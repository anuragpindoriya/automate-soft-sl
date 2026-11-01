import type { Candle, ExchangeAdapter, Position, StopRule, StopsFile } from './types.js';
import {
  bindRuleBySig,
  boundSig,
  hasHardLevels,
  isBreached,
  removeRuleBySig,
  resolveStop,
  type LoadedStops,
  type RawStops,
} from './config.js';
import { sleep, withRetry } from './http.js';
import type { Notifier } from './notify.js';
import { log } from './log.js';

export const HOUR = 3_600_000;
const MIN = 60_000;
/** A candle the exchange doesn't flag as final is trusted this long after its hour ends, even with no later candle. */
export const LATE_ACCEPT_MS = MIN;
/** A tied rule's position must be missing on 3+ checks spanning at least this long before the rule is removed. */
export const STALE_RULE_MS = 15 * MIN;
/** If positions were seen this recently, an empty positions reply is double-checked before it is believed. */
const RECENT_MS = 5 * MIN;

export interface EngineAccount {
  name: string;
  adapter: ExchangeAdapter;
}

/** Where unfinished closes and stopped positions are kept, so a restart doesn't forget them. */
export interface StateStore {
  load(): unknown;
  save(state: unknown): void;
}

export interface EngineDeps {
  accounts: EngineAccount[];
  /** Read sl.json (bad rules skipped and listed). Throws only if the file is unreadable. */
  loadStops: () => LoadedStops;
  /** Targeted edit of sl.json's raw JSON; returns true if the file was written. */
  editStops: (fn: (raw: RawStops) => boolean) => boolean;
  notify: Notifier;
  /** Log and alert, but never send close orders. */
  dryRun: boolean;
  /** Tie rules to their position and remove them once it is gone. Default true. */
  removeRuleAfterClose?: boolean;
  /** True in the daemon, where tick() retries failed closes. False for a one-off run. */
  retriesFailedCloses?: boolean;
  state?: StateStore;
  /** Wait between quick retries when the just-closed candle isn't published yet. */
  candleRetryMs?: number;
  /** Wait after a close order before re-checking positions. */
  verifyDelayMs?: number;
  /** Wait before a second read that confirms a position (or every position) is really gone. */
  confirmDelayMs?: number;
  now?: () => number;
}

export type Action = 'ok' | 'closed' | 'would-close' | 'unprotected' | 'no-candle' | 'no-positions' | 'skipped' | 'error' | 'cancelled';

export interface CheckResult {
  account: string;
  symbol: string;
  side: string;
  action: Action;
  price?: number;
  level?: number;
  detail?: string;
}

interface Decision {
  kind: 'soft' | 'hard';
  /** The price the decision was based on (1h close, or last price for the emergency level). */
  price: number;
  rule?: StopRule;
  /** For soft decisions: the hourly close that triggered it. Retries stop when the next close is due. */
  boundary?: number;
}

interface PendingClose {
  account: string;
  position: Position;
  /** Size when the close was decided. A close must only ever make it smaller. */
  baseline: number;
  reason: string;
  decision: Decision;
}

interface Frozen {
  account: string;
  key: string;
  side: string;
  positionId?: string;
  why: string;
  at: number;
}

interface Sent {
  ref: string;
  /** Position ids on the symbol just before a fallback order (to spot a position it opened). */
  before?: Set<string>;
}

class Grew extends Error {}

/** Same position: same symbol and side, and the same exchange id when both have one. */
export function samePosition(a: Position, b: Position): boolean {
  if (a.key !== b.key || a.side !== b.side) return false;
  return a.positionId && b.positionId ? a.positionId === b.positionId : true;
}

/**
 * Is the candle that ended at `boundaryMs` really finished? Trust the exchange's own flag when it
 * has one. Otherwise require a later candle in the same response (proof the hour is over on the
 * exchange's clock, whatever our clock says), or that the hour ended a while ago.
 */
export function isFinal(c: Candle, all: Candle[], boundaryMs: number, now: number): boolean {
  if (c.closed === true) return true;
  if (c.closed === false) return false;
  return all.some((x) => x.openTime > c.openTime) || now >= boundaryMs + LATE_ACCEPT_MS;
}

/** Did a close attempt make things worse? Bigger than when we started, or turned into something else. */
function damage(positions: Position[], p: Position, baseline: number): string | undefined {
  if (p.positionId) {
    const byId = positions.find((q) => q.positionId === p.positionId);
    if (byId && (byId.key !== p.key || byId.side !== p.side)) return `it turned into ${byId.key} ${byId.side.toUpperCase()} ${byId.sizeRaw}`;
  }
  const still = positions.find((q) => samePosition(q, p));
  if (still && still.size > baseline * (1 + 1e-9)) return `it grew from ${baseline} to ${still.sizeRaw}`;
  return undefined;
}

const findSame = (list: Position[], p: Position) => list.find((q) => samePosition(q, p));
const posKey = (account: string, p: Pick<Position, 'key' | 'side' | 'positionId'>) => `${account}|${p.key}:${p.side}:${p.positionId ?? ''}`;
const label = (account: string, p: Position) => `${account} ${p.key} ${p.side.toUpperCase()} ${p.sizeRaw}`;
const isFrozenPos = (q: Position, f: Frozen) => q.key === f.key && q.side === f.side && (!f.positionId || q.positionId === f.positionId);

export class SoftSlEngine {
  private locks = new Map<string, Promise<unknown>>();
  private lastAlert = new Map<string, number>();
  private pending = new Map<string, PendingClose>();
  private frozen = new Map<string, Frozen>();
  private lastGoodStops?: StopsFile;
  /** sl.json edits not written yet (file unreadable): untied rule fingerprint → position id, and fingerprints to remove. */
  private ties = new Map<string, string>();
  private drops = new Set<string>();
  private missing = new Map<string, { since: number; count: number }>();
  private seen = new Map<string, { first: number; last: number }>();
  private lastNonEmpty = new Map<string, number>();
  private hourState = new Map<string, { boundary: number; done: Set<string>; eligible: Set<string> }>();
  private hardFailures = new Map<string, number>();
  private hardAlerted = new Set<string>();
  private stopping = false;

  constructor(private d: EngineDeps) {
    this.restore();
  }

  // ── hourly check ─────────────────────────────────────────────────────────

  /**
   * Hourly check. `boundaryMs` is the top of the hour that just passed (e.g. 10:00:00 UTC); the
   * candle evaluated is the one that opened at boundary − 1h. Calling it again for the same hour
   * (a retry) only checks positions that weren't checked yet.
   * - `final: false`: problems a retry may fix (candle not out, exchange down) are logged, not alerted.
   * - `strict: true` (retries, startup catch-up): a position is only judged on this close if it is
   *   known to have existed before it — never one opened after the candle closed.
   */
  async runHourly(boundaryMs: number, opts: { accounts?: string[]; final?: boolean; strict?: boolean } = {}): Promise<CheckResult[]> {
    if (this.stopping) return [];
    const final = opts.final ?? true;
    const early = boundaryMs - this.now();
    if (early > 0) await sleep(early + 1000); // never judge a candle before its hour is over
    const list = this.d.accounts.filter((a) => !opts.accounts || opts.accounts.includes(a.name));
    log.info(
      `── hourly check of the ${iso(boundaryMs)} close: ${list.map((a) => a.name).join(', ')}` +
        `${opts.strict ? ' (follow-up)' : ''}${this.d.dryRun ? ' [DRY RUN]' : ''}`,
    );
    const results = await Promise.all(
      list.map((acc) =>
        this.withLock(acc.name, () => this.hourlyForAccount(acc, boundaryMs, final, !!opts.strict)).catch((e): CheckResult[] => {
          const msg = (e as Error).message;
          log.error(`${acc.name}: hourly check failed${final ? '' : ' — will retry'}`, e);
          if (final) void this.d.notify(`⚠️ SoftSL: ${acc.name} hourly check FAILED — stops NOT evaluated for the ${iso(boundaryMs)} close\n${msg}`);
          return [{ account: acc.name, symbol: '*', side: '*', action: 'error', detail: msg }];
        }),
      ),
    );
    return results.flat();
  }

  private async hourlyForAccount(acc: EngineAccount, boundaryMs: number, final: boolean, strict: boolean): Promise<CheckResult[]> {
    if (this.stopping) return [];
    const stops = await this.getStops();
    const recentlyHad = this.now() - (this.lastNonEmpty.get(acc.name) ?? -Infinity) < RECENT_MS;
    let positions = await withRetry(`${acc.name} positions`, () => this.fetchPositions(acc));
    if (!positions.length && recentlyHad) {
      // An empty reply right after positions were open may be a glitch: look again before believing it.
      for (let i = 0; i < 2 && !positions.length; i++) positions = await this.confirmRead(acc);
      if (!positions.length) {
        log.warn(`${acc.name}: positions came back empty right after positions were open — will look again`);
        return [{ account: acc.name, symbol: '*', side: '*', action: 'no-positions', detail: 'empty positions reply after recent positions' }];
      }
    }
    positions = await this.reconcile(acc, positions);
    this.syncRules(acc, stops, positions);
    if (positions.length === 0) {
      log.info(`${acc.name}: no open positions`);
      return [];
    }

    const hs = this.hourStateFor(acc.name, boundaryMs);
    const out: CheckResult[] = [];
    const todo: { p: Position; k: string }[] = [];
    for (const p of positions) {
      const k = posKey(acc.name, p);
      if (hs.done.has(k)) continue;
      if (!this.existedBefore(acc.name, p, boundaryMs, strict)) {
        hs.done.add(k);
        log.info(`${acc.name} ${p.key} ${p.side}: opened after the ${iso(boundaryMs)} close — first checked at the next close`);
        out.push({ account: acc.name, symbol: p.key, side: p.side, action: 'skipped', detail: 'opened after this close' });
        continue;
      }
      hs.eligible.add(k);
      todo.push({ p, k });
    }

    const evals = todo.map(({ p, k }) => ({ p, k, st: resolveStop(stops, acc.name, p) }));
    const symbols = [...new Set(evals.filter((e) => e.st.kind === 'ok').map((e) => e.p.symbol))];
    const candles = new Map(await Promise.all(symbols.map(async (s) => [s, await this.closedCandle(acc, s, boundaryMs)] as const)));

    for (const { p, k, st } of evals) {
      const base = { account: acc.name, symbol: p.key, side: p.side };
      if (st.kind === 'none') {
        hs.done.add(k);
        out.push({ ...base, action: 'unprotected' });
        log.warn(`${acc.name} ${p.key} ${p.side}: NO soft SL configured (size ${p.sizeRaw} @ ${p.entryPrice})`);
        this.alertEvery(`unprotected|${k}`, Infinity, `⚠️ SoftSL: ${acc.name} ${p.key} ${p.side.toUpperCase()} has no stop configured`);
        continue;
      }
      if (st.kind === 'error') {
        out.push({ ...base, action: 'error', detail: st.message });
        log.error(`${acc.name} ${p.key} ${p.side}: ${st.message}`);
        this.alertEvery(`stoperr|${k}`, 50 * MIN, `⚠️ SoftSL: ${acc.name} ${p.key} ${p.side.toUpperCase()} — ${st.message}. SL NOT evaluated.`);
        continue;
      }
      this.warnStop(acc.name, p, st.warning);

      const c = candles.get(p.symbol);
      if (!c) {
        out.push({ ...base, action: 'no-candle', level: st.sl });
        log.error(`${acc.name} ${p.key}: closed 1h candle ${iso(boundaryMs - HOUR)} not available${final ? '' : ' yet — will retry'}`);
        if (final) void this.d.notify(`⚠️ SoftSL: ${acc.name} ${p.key} — couldn't get the closed 1h candle, SL NOT evaluated for the ${iso(boundaryMs)} close`);
        continue;
      }
      hs.done.add(k);

      const breached = isBreached(p.side, c.close, st.sl);
      log.info(`${acc.name} ${p.key} ${p.side}: close ${c.close} vs SL ${round(st.sl)} → ${breached ? 'BREACHED' : 'ok'}`);
      if (!breached) {
        if (this.pending.get(k)?.decision.kind === 'soft') {
          this.pending.delete(k);
          this.persist();
          void this.d.notify(`ℹ️ SoftSL: no longer trying to close ${label(acc.name, p)} — the latest 1h close ${c.close} is back inside the SL ${round(st.sl)}`);
        }
        out.push({ ...base, action: 'ok', price: c.close, level: st.sl });
        continue;
      }
      const reason = `1h close ${c.close} ${p.side === 'long' ? '<' : '>'} SL ${round(st.sl)}`;
      const action = await this.closeAndVerify(acc, p, reason, { kind: 'soft', price: c.close, rule: st.rule, boundary: boundaryMs });
      out.push({ ...base, action, price: c.close, level: st.sl, detail: reason });
    }
    return out;
  }

  /** Fetch the candle that closed at `boundaryMs`, retrying briefly while the exchange catches up. */
  private async closedCandle(acc: EngineAccount, symbol: string, boundaryMs: number): Promise<Candle | undefined> {
    const openTime = boundaryMs - HOUR;
    const tries = 4;
    for (let i = 1; i <= tries; i++) {
      try {
        const candles = await acc.adapter.getCandles(symbol, '1h', 5);
        const c = candles.find((x) => x.openTime === openTime);
        if (c && Number.isFinite(c.close) && c.close > 0) {
          if (isFinal(c, candles, boundaryMs, this.now())) return c;
          log.debug(`${acc.name} ${symbol}: candle ${iso(openTime)} not final yet`);
        } else {
          log.debug(`${acc.name} ${symbol}: candle ${iso(openTime)} not found yet (got ${candles.map((x) => iso(x.openTime)).join(', ')})`);
        }
      } catch (e) {
        log.warn(`${acc.name} ${symbol}: kline fetch failed (try ${i}/${tries})`, e);
      }
      if (i < tries) await sleep(this.d.candleRetryMs ?? 3000);
    }
    return undefined;
  }

  /** Is `p` known to have existed before the close at `boundaryMs`? */
  private existedBefore(account: string, p: Position, boundaryMs: number, strict: boolean): boolean {
    const k = posKey(account, p);
    if ((this.seen.get(k)?.first ?? Infinity) < boundaryMs) return true; // we saw it before the close
    if (p.openTime !== undefined) return p.openTime < boundaryMs;
    const hs = this.hourState.get(account);
    if (hs?.boundary === boundaryMs && hs.eligible.has(k)) return true;
    // Unknown: right after the close, a position we see was almost surely there; on later retries it may be new.
    return !strict;
  }

  private hourStateFor(account: string, boundaryMs: number) {
    let hs = this.hourState.get(account);
    if (!hs || hs.boundary !== boundaryMs) {
      hs = { boundary: boundaryMs, done: new Set(), eligible: new Set() };
      this.hourState.set(account, hs);
    }
    return hs;
  }

  // ── between the hours ────────────────────────────────────────────────────

  /**
   * Runs every few seconds per account: follow positions (tie/remove rules, notice closes), retry
   * failed closes, and — when `hardCheck` — check emergency levels.
   */
  async tick(name: string, opts: { hardCheck: boolean }): Promise<CheckResult[]> {
    if (this.stopping) return [];
    const acc = this.account(name);
    return this.withLock(name, async () => {
      if (this.stopping) return [];
      const stops = await this.getStops();
      let positions = await this.fetchPositions(acc);
      positions = await this.reconcile(acc, positions);
      this.syncRules(acc, stops, positions);
      const out = await this.retryPending(acc, stops, positions);
      if (opts.hardCheck) out.push(...(await this.hardCheck(acc, stops, positions)));
      this.prune();
      return out;
    }).then(
      (out) => {
        if (opts.hardCheck) this.hardCheckOk(name);
        return out;
      },
      (e): CheckResult[] => {
        if (opts.hardCheck) this.hardCheckFailed(name, e);
        else log.error(`${name}: check failed`, e);
        return [];
      },
    );
  }

  /** Emergency check (plus failed-close retries) for one account, now. */
  runHardCheck(name: string): Promise<CheckResult[]> {
    return this.tick(name, { hardCheck: true });
  }

  /**
   * A soft close that failed keeps being retried until it works, the position is gone, its stop is
   * removed or moved in sl.json, or the next hourly close is due (that check decides afresh).
   */
  private async retryPending(acc: EngineAccount, stops: StopsFile, positions: Position[]): Promise<CheckResult[]> {
    const out: CheckResult[] = [];
    for (const [k, e] of [...this.pending]) {
      if (e.account !== acc.name) continue;
      const base = { account: acc.name, symbol: e.position.key, side: e.position.side };
      const lbl = label(acc.name, e.position);
      if (e.decision.boundary !== undefined && this.now() >= e.decision.boundary + HOUR) {
        this.pending.delete(k);
        this.persist();
        log.warn(`${lbl}: the next hourly close is due — no longer retrying the earlier close`);
        void this.d.notify(`ℹ️ SoftSL: stopped retrying the close of ${lbl} (decided at the ${iso(e.decision.boundary)} close) — the next hourly check decides now`);
        out.push({ ...base, action: 'cancelled', detail: 'next hourly close due' });
        continue;
      }
      const cur = findSame(positions, e.position);
      if (!cur) continue; // missing from this read but not confirmed gone — look again next time
      if (cur.size > e.baseline * (1 + 1e-9)) {
        this.freeze(acc, cur, `it grew from ${e.baseline} to ${cur.sizeRaw}`, e.reason);
        out.push({ ...base, action: 'error', detail: 'position grew' });
        continue;
      }
      const st = resolveStop(stops, acc.name, cur);
      if (st.kind === 'none' || (st.kind === 'ok' && !isBreached(cur.side, e.decision.price, st.sl))) {
        this.pending.delete(k);
        this.persist();
        log.warn(`${lbl}: stop removed or moved in sl.json — no longer trying to close`);
        void this.d.notify(`ℹ️ SoftSL: no longer trying to close ${lbl} — its stop was removed or moved in sl.json`);
        out.push({ ...base, action: 'cancelled' });
        continue;
      }
      const rule = st.kind === 'ok' ? st.rule : e.decision.rule;
      const action = await this.closeAndVerify(acc, cur, e.reason, { ...e.decision, rule }, e.baseline);
      out.push({ ...base, action, price: e.decision.price, detail: e.reason });
    }
    return out;
  }

  /** Emergency check against the latest price (newest 1m candle), for positions with a hard level. */
  private async hardCheck(acc: EngineAccount, stops: StopsFile, positions: Position[]): Promise<CheckResult[]> {
    if (!hasHardLevels(stops, acc.name)) return [];
    const prices = new Map<string, Promise<number | undefined>>();
    const out: CheckResult[] = [];
    for (const p of positions) {
      const st = resolveStop(stops, acc.name, p);
      if (st.kind !== 'ok') continue;
      this.warnStop(acc.name, p, st.warning);
      if (st.hard == null) continue;
      if (!prices.has(p.symbol)) prices.set(p.symbol, this.lastPrice(acc, p.symbol));
      const price = await prices.get(p.symbol);
      if (price === undefined || !isBreached(p.side, price, st.hard)) continue;
      const reason = `EMERGENCY: price ${price} ${p.side === 'long' ? '<' : '>'} hard level ${round(st.hard)}`;
      log.warn(`${acc.name} ${p.key} ${p.side}: ${reason}`);
      const action = await this.closeAndVerify(acc, p, reason, { kind: 'hard', price, rule: st.rule });
      out.push({ account: acc.name, symbol: p.key, side: p.side, action, price, level: st.hard, detail: reason });
    }
    return out;
  }

  /** Stop starting new work (shutdown). Closes already in progress finish and are verified. */
  stop() {
    this.stopping = true;
  }

  /** Resolves once all in-flight account work has finished. */
  async drain(): Promise<void> {
    for (;;) {
      const now = [...this.locks.values()];
      await Promise.allSettled(now);
      const after = [...this.locks.values()];
      if (after.length === now.length && after.every((p, i) => p === now[i])) return;
    }
  }

  // ── closing ──────────────────────────────────────────────────────────────

  private async closeAndVerify(acc: EngineAccount, p: Position, reason: string, decision: Decision, baseline = p.size): Promise<Action> {
    const lbl = label(acc.name, p);
    const k = posKey(acc.name, p);
    const frozen = this.frozen.get(k);
    if (frozen) {
      this.alertEvery(`frozen|${k}`, HOUR, `🚨 SoftSL: ${lbl} — ${reason}, but automatic closing is STOPPED for this position (${frozen.why}). Close it manually.`);
      return 'error';
    }
    if (this.d.dryRun) {
      log.warn(`[DRY RUN] would close ${lbl} — ${reason}`);
      const text = `🧪 [DRY RUN] SoftSL would close ${lbl}\n${reason}`;
      // The emergency loop runs every few seconds; tell about it once an hour, not every tick.
      if (decision.kind === 'soft') await this.d.notify(text);
      else this.alertEvery(`dry|${k}`, HOUR, text);
      return 'would-close';
    }

    let current = p;
    for (let attempt = 1; attempt <= 3; attempt++) {
      let sent: Sent | undefined;
      try {
        sent = await this.closeOnce(acc, current, baseline);
        log.warn(`close sent: ${lbl} (${sent.ref}) — ${reason}`);
      } catch (e) {
        if (e instanceof Grew) {
          this.freeze(acc, current, e.message, reason);
          return 'error';
        }
        log.error(`close FAILED: ${lbl} (attempt ${attempt}/3)`, e);
      }
      await sleep(this.d.verifyDelayMs ?? 2000);

      let positions: Position[];
      try {
        positions = await this.fetchPositions(acc);
      } catch (e) {
        log.error(`${acc.name}: could not verify the close`, e);
        continue;
      }
      const harm = damage(positions, current, baseline);
      if (harm) {
        this.freeze(acc, current, harm, reason);
        return 'error';
      }
      if (sent?.before) this.flagNewPositions(acc, current, positions, sent.before);
      const still = findSame(positions, current);
      if (still) {
        current = still; // partial fill: close what is left of this same position
        continue;
      }
      // Gone from this read. One empty or partial reply is not proof, so confirm with a second read.
      let again: Position[];
      try {
        again = await this.confirmRead(acc);
      } catch (e) {
        log.error(`${acc.name}: could not confirm the close`, e);
        continue;
      }
      const back = findSame(again, current);
      if (back) {
        current = back;
        continue;
      }
      this.pending.delete(k);
      this.persist();
      this.lastAlert.delete(`closefail|${k}`);
      log.warn(`CLOSED ${lbl} — ${reason}`);
      await this.d.notify(`🛑 SoftSL closed ${lbl}\n${reason}`);
      this.afterClose(acc, p, again, decision.rule);
      return 'closed';
    }

    const retrying = this.d.retriesFailedCloses !== false;
    if (retrying && decision.kind === 'soft') {
      this.pending.set(k, { account: acc.name, position: current, baseline, reason, decision });
      this.persist();
    }
    const next = !retrying
      ? 'CLOSE IT MANUALLY.'
      : decision.kind === 'soft'
        ? 'Retrying until the next hourly close — close it manually if you can.'
        : 'Retrying while the price stays beyond the emergency level — close it manually if you can.';
    this.alertEvery(`closefail|${k}`, 15 * MIN, `🚨 SoftSL could NOT close ${lbl}\n${reason}\n${next}`);
    return 'error';
  }

  /**
   * One close attempt: the exchange's close-position endpoint, then a market order as a fallback.
   * Before the fallback, look again: the first close may have gone through anyway (a timeout, say),
   * and an order for a position that is already gone could open a new one.
   */
  private async closeOnce(acc: EngineAccount, p: Position, baseline: number): Promise<Sent> {
    try {
      return { ref: await acc.adapter.closePosition(p) };
    } catch (e) {
      log.warn(`${acc.name} ${p.key} ${p.side}: close-position endpoint failed — re-checking before a fallback order`, e);
    }
    const positions = await this.fetchPositions(acc);
    const harm = damage(positions, p, baseline);
    if (harm) throw new Grew(harm);
    const cur = findSame(positions, p);
    if (!cur) return { ref: 'already closed' };
    const twins = positions.filter((q) => q.key === cur.key && q.side === cur.side).length;
    if (twins > 1) throw new Error(`${twins} ${cur.key} ${cur.side} positions are open; a market order can't safely target just this one`);
    const before = new Set(positions.filter((q) => q.key === cur.key && q.positionId).map((q) => q.positionId!));
    return { ref: `fallback ${await acc.adapter.closeWithOrder(cur)}`, before };
  }

  /** A close made things worse: never send another automatic order for this position. */
  private freeze(acc: EngineAccount, p: Position, why: string, reason: string) {
    const k = posKey(acc.name, p);
    this.frozen.set(k, { account: acc.name, key: p.key, side: p.side, positionId: p.positionId, why, at: this.now() });
    this.pending.delete(k);
    this.persist();
    log.error(`STOPPED closing ${label(acc.name, p)} — ${why}`);
    void this.d.notify(
      `🚨🚨 SoftSL STOPPED closing ${label(acc.name, p)}: ${why} after a close attempt.\n` +
        `No more automatic orders for this position — check it and close it manually NOW.\n(${reason})`,
    );
  }

  /** A new position on the symbol right after a fallback order may have been opened by it. */
  private flagNewPositions(acc: EngineAccount, p: Position, positions: Position[], before: Set<string>) {
    for (const q of positions) {
      if (q.key !== p.key || !q.positionId || before.has(q.positionId)) continue;
      const k = posKey(acc.name, q);
      if (this.frozen.has(k)) continue;
      this.frozen.set(k, { account: acc.name, key: q.key, side: q.side, positionId: q.positionId, why: 'it appeared right after a fallback close order', at: this.now() });
      this.persist();
      log.error(`${label(acc.name, q)} appeared right after the fallback close order for ${p.key} ${p.side}`);
      void this.d.notify(
        `🚨🚨 SoftSL: a NEW position ${label(acc.name, q)} appeared right after the fallback close order for ${p.key} ${p.side.toUpperCase()} — ` +
          `the order may have opened it. SoftSL won't touch it; check it NOW.`,
      );
    }
  }

  /** Remove the rule once nothing it protects is left, so it can't fire on a future position. */
  private afterClose(acc: EngineAccount, closed: Position, positionsNow: Position[], rule?: StopRule) {
    if (this.d.removeRuleAfterClose === false || !rule?.sig) return;
    const stillUsed = rule.positionId
      ? rule.positionId !== closed.positionId
      : positionsNow.some((q) => q.key === closed.key && q.side === closed.side);
    if (stillUsed) return;
    this.dropRule(rule.sig);
    log.info(`removed rule ${acc.name} ${closed.key} ${closed.side} from sl.json`);
  }

  /**
   * Pending closes and stopped positions whose position is missing from `positions` are finished —
   * but only if a second read agrees. Returns the freshest positions list.
   */
  private async reconcile(acc: EngineAccount, positions: Position[]): Promise<Position[]> {
    const pend = [...this.pending].filter(([, e]) => e.account === acc.name && !findSame(positions, e.position));
    const froz = [...this.frozen].filter(([, f]) => f.account === acc.name && !positions.some((q) => isFrozenPos(q, f)));
    if (!pend.length && !froz.length) return positions;
    let again: Position[];
    try {
      again = await this.confirmRead(acc);
    } catch (e) {
      log.warn(`${acc.name}: couldn't double-check positions`, e);
      return positions;
    }
    for (const [k, e] of pend) {
      if (findSame(again, e.position)) continue;
      this.pending.delete(k);
      this.lastAlert.delete(`closefail|${k}`);
      log.warn(`${label(acc.name, e.position)} is closed now`);
      void this.d.notify(`✅ SoftSL: ${label(acc.name, e.position)} is closed now (after earlier failed attempts)`);
      this.afterClose(acc, e.position, again, e.decision.rule);
    }
    for (const [k, f] of froz) if (!again.some((q) => isFrozenPos(q, f))) this.frozen.delete(k);
    this.persist();
    return again;
  }

  // ── rules ↔ positions ────────────────────────────────────────────────────

  /**
   * Tie each untied rule to its position as soon as exactly one matches, and remove a tied rule once
   * its position is gone (take-profit, manual close, liquidation…), so an old stop never lands on a
   * new trade. A position must be missing on 3+ checks over 15 minutes, so a few bad API replies
   * can't wipe your rules (a stale tied rule is harmless meanwhile: it applies to nothing else).
   */
  private syncRules(acc: EngineAccount, stops: StopsFile, positions: Position[]) {
    if (this.d.removeRuleAfterClose === false) return;
    const now = this.now();
    for (const r of [...stops.stops]) {
      if (r.account !== acc.name || !r.sig) continue;
      const same = positions.filter((p) => p.key === r.symbol && p.side === r.side);
      if (r.positionId) {
        if (positions.some((p) => p.positionId === r.positionId) || same.some((p) => !p.positionId)) {
          this.missing.delete(r.sig);
          continue;
        }
        const m = this.missing.get(r.sig) ?? { since: now, count: 0 };
        m.count++;
        this.missing.set(r.sig, m);
        if (m.count < 3 || now - m.since < STALE_RULE_MS) continue;
        this.missing.delete(r.sig);
        stops.stops.splice(stops.stops.indexOf(r), 1);
        this.dropRule(r.sig);
        log.info(`${acc.name} ${r.symbol} ${r.side}: position ${r.positionId} is gone — rule removed`);
        void this.d.notify(`🧹 SoftSL: removed the ${acc.name} ${r.symbol} ${r.side.toUpperCase()} rule — its position is no longer open`);
        continue;
      }
      if (same.length !== 1 || !same[0].positionId) continue;
      const id = same[0].positionId;
      if (stops.stops.some((o) => o !== r && o.account === acc.name && o.positionId === id)) continue; // already has its rule
      this.tieRule(r.sig, id);
      log.info(`${acc.name} ${r.symbol} ${r.side}: rule tied to position ${id}`);
      r.positionId = id;
      r.sig = boundSig(r.sig, id);
    }
  }

  private tieRule(sig: string, positionId: string) {
    this.ties.set(sig, positionId);
    this.flushRuleEdits();
  }

  private dropRule(sig: string) {
    // If the rule's tie isn't on disk yet, the file still holds the untied version: remove that too.
    for (const [u, id] of [...this.ties]) {
      if (boundSig(u, id) !== sig) continue;
      this.ties.delete(u);
      this.drops.add(u);
    }
    this.drops.add(sig);
    this.flushRuleEdits();
  }

  /** Write pending ties/removals to sl.json. Kept in memory (and applied to every read) until they land. */
  private flushRuleEdits() {
    for (const [sig, id] of [...this.ties]) if (this.tryEdit((raw) => bindRuleBySig(raw, sig, id)) !== 'error') this.ties.delete(sig);
    for (const sig of [...this.drops]) if (this.tryEdit((raw) => removeRuleBySig(raw, sig)) !== 'error') this.drops.delete(sig);
  }

  private withRuleEdits(file: StopsFile): StopsFile {
    file.stops = file.stops.filter((r) => !(r.sig && this.drops.has(r.sig)));
    for (const r of file.stops) {
      const id = r.sig && !r.positionId ? this.ties.get(r.sig) : undefined;
      if (!id) continue;
      r.positionId = id;
      r.sig = boundSig(r.sig!, id);
    }
    file.stops = file.stops.filter((r) => !(r.sig && this.drops.has(r.sig)));
    return file;
  }

  private tryEdit(fn: (raw: RawStops) => boolean): 'written' | 'unchanged' | 'error' {
    try {
      return this.d.editStops(fn) ? 'written' : 'unchanged';
    } catch (e) {
      log.error('could not update sl.json (will retry)', e);
      return 'error';
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** sl.json, or the last good copy if it can't be read right now (an editor mid-save, a typo). */
  private async getStops(): Promise<StopsFile> {
    if (this.ties.size || this.drops.size) this.flushRuleEdits();
    let err: unknown;
    for (let i = 0; i < 3; i++) {
      try {
        const { file, problems } = this.d.loadStops();
        for (const pr of problems) {
          const key = pr.replace(/^stops\[\d+\]\s*/, '');
          if (this.alertEvery(`stops|${key}`, HOUR, `⚠️ SoftSL: problem in sl.json — ${pr}`)) log.error(`sl.json: ${pr}`);
        }
        this.lastGoodStops = structuredClone(file);
        return this.withRuleEdits(file);
      } catch (e) {
        err = e;
        if (i < 2) await sleep(300);
      }
    }
    const msg = (err as Error)?.message ?? String(err);
    if (this.lastGoodStops) {
      if (this.alertEvery('stops|unreadable', HOUR, `⚠️ SoftSL: sl.json can't be read (${msg}). Using the last good copy until it's fixed.`)) {
        log.error('sl.json can’t be read — using the last good copy', err);
      }
      return this.withRuleEdits(structuredClone(this.lastGoodStops));
    }
    throw new Error(`sl.json can't be read: ${msg}`);
  }

  private async fetchPositions(acc: EngineAccount): Promise<Position[]> {
    const ps = await acc.adapter.getPositions();
    const now = this.now();
    for (const p of ps) {
      const k = posKey(acc.name, p);
      const s = this.seen.get(k);
      if (s) s.last = now;
      else this.seen.set(k, { first: now, last: now });
    }
    if (ps.length) this.lastNonEmpty.set(acc.name, now);
    return ps;
  }

  private async confirmRead(acc: EngineAccount): Promise<Position[]> {
    await sleep(this.d.confirmDelayMs ?? 2000);
    return this.fetchPositions(acc);
  }

  private async lastPrice(acc: EngineAccount, symbol: string): Promise<number | undefined> {
    const c = (await acc.adapter.getCandles(symbol, '1m', 2)).at(-1);
    return c && Number.isFinite(c.close) && c.close > 0 ? c.close : undefined;
  }

  private warnStop(account: string, p: Position, warning?: string) {
    if (!warning) return;
    const text = `⚠️ SoftSL: ${account} ${p.key} ${p.side.toUpperCase()} — ${warning}`;
    if (this.alertEvery(`warn|${posKey(account, p)}|${warning}`, 24 * HOUR, text)) log.warn(`${account} ${p.key} ${p.side}: ${warning}`);
  }

  private hardCheckFailed(name: string, e: unknown) {
    const n = (this.hardFailures.get(name) ?? 0) + 1;
    this.hardFailures.set(name, n);
    log.error(`${name}: emergency check failed (${n} in a row)`, e);
    if (n >= 3 && this.alertEvery(`hardfail|${name}`, 15 * MIN, `⚠️ SoftSL: emergency checks for ${name} keep failing (${n} in a row) — ${(e as Error).message}`)) {
      this.hardAlerted.add(name);
    }
  }

  private hardCheckOk(name: string) {
    this.hardFailures.delete(name);
    if (this.hardAlerted.delete(name)) this.alertEvery(`hardok|${name}`, 15 * MIN, `✅ SoftSL: emergency checks for ${name} are working again`);
  }

  /** Send `text` unless the same alert went out less than `everyMs` ago. Returns whether it was sent. */
  private alertEvery(key: string, everyMs: number, text: string): boolean {
    const now = this.now();
    const last = this.lastAlert.get(key);
    if (last !== undefined && now - last < everyMs) return false;
    this.lastAlert.set(key, now);
    void this.d.notify(text);
    return true;
  }

  private prune() {
    const now = this.now();
    for (const [k, t] of this.lastAlert) if (now - t > 25 * HOUR) this.lastAlert.delete(k);
    for (const [k, s] of this.seen) if (now - s.last > 25 * HOUR) this.seen.delete(k);
  }

  private persist() {
    try {
      this.d.state?.save({ v: 1, pending: [...this.pending.values()], frozen: [...this.frozen.entries()] });
    } catch (e) {
      log.error('could not save the state file', e);
    }
  }

  private restore() {
    let s: any;
    try {
      s = this.d.state?.load();
    } catch (e) {
      log.error('could not read the state file — starting without it', e);
      return;
    }
    if (!s || typeof s !== 'object') return;
    const names = new Set(this.d.accounts.map((a) => a.name));
    for (const e of Array.isArray(s.pending) ? s.pending : []) {
      const p = e?.position;
      if (!names.has(e?.account) || !p?.key || (p.side !== 'long' && p.side !== 'short') || typeof e.reason !== 'string' || typeof e?.decision?.price !== 'number') continue;
      this.pending.set(posKey(e.account, p), { ...e, baseline: Number(e.baseline) > 0 ? Number(e.baseline) : p.size });
    }
    for (const entry of Array.isArray(s.frozen) ? s.frozen : []) {
      const [k, f] = Array.isArray(entry) ? entry : [];
      if (typeof k === 'string' && f && names.has(f.account)) this.frozen.set(k, f);
    }
    if (this.pending.size || this.frozen.size) {
      log.warn(`restored ${this.pending.size} unfinished close(s) and ${this.frozen.size} stopped position(s) from the state file`);
    }
  }

  private account(name: string): EngineAccount {
    const a = this.d.accounts.find((x) => x.name === name);
    if (!a) throw new Error(`unknown account ${name}`);
    return a;
  }

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** Serialise work per account so the hourly check, retries and emergency loop never race on one position. */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.locks.set(key, next.catch(() => undefined));
    return next;
  }
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
const round = (n: number) => Number(n.toPrecision(8));
