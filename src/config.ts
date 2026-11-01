import { readFileSync, renameSync, existsSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import type { AccountConfig, ExchangeId, Position, Side, StopRule, StopsFile } from './types.js';
import { normaliseSymbol, parseJson } from './http.js';

export const ACCOUNTS_FILE = resolve(process.env.ACCOUNTS_FILE ?? 'accounts.json');
export const STOPS_FILE = resolve(process.env.STOPS_FILE ?? 'sl.json');

const EXCHANGES: ExchangeId[] = ['blofin', 'bitunix', 'bingx', 'weex'];

export function loadAccounts(path = ACCOUNTS_FILE): AccountConfig[] {
  if (!existsSync(path)) throw new Error(`accounts file not found: ${path} (copy accounts.example.json)`);
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const list: AccountConfig[] = Array.isArray(raw) ? raw : raw.accounts;
  if (!Array.isArray(list)) throw new Error(`${path}: expected an array of accounts`);

  const names = new Set<string>();
  for (const a of list) {
    if (!a.name) throw new Error(`${path}: every account needs a "name"`);
    if (names.has(a.name)) throw new Error(`${path}: duplicate account name "${a.name}"`);
    names.add(a.name);
    if (!EXCHANGES.includes(a.exchange)) throw new Error(`${path}: account "${a.name}" has unknown exchange "${a.exchange}" (use ${EXCHANGES.join(', ')})`);
    if (!a.apiKey || !a.apiSecret) throw new Error(`${path}: account "${a.name}" is missing apiKey/apiSecret`);
    if ((a.exchange === 'blofin' || a.exchange === 'weex') && !a.passphrase) {
      throw new Error(`${path}: account "${a.name}" (${a.exchange}) needs "passphrase"`);
    }
  }
  return list.filter((a) => a.enabled !== false);
}

// ── sl.json ────────────────────────────────────────────────────────────────

/** sl.json exactly as written, unvalidated. */
export type RawStops = { defaults?: any; stops?: any[]; [k: string]: unknown };

export interface LoadedStops {
  file: StopsFile;
  /** Rules or defaults that were skipped or partly ignored, in plain words. */
  problems: string[];
}

/** Raw sl.json, or undefined if there is none. Throws if it exists but isn't valid JSON. */
export function readStopsRaw(path = STOPS_FILE): RawStops | undefined {
  if (!existsSync(path)) return undefined;
  return toRawStops(parseJson(readFileSync(path, 'utf8')), path);
}

/**
 * Read sl.json. A bad rule is skipped (and listed in `problems`) instead of failing the whole
 * file, so one typo can't switch off every other stop. Throws only if the file is unreadable.
 */
export function loadStops(path = STOPS_FILE): LoadedStops {
  const raw = readStopsRaw(path);
  return raw ? parseStops(raw) : { file: { defaults: {}, stops: [] }, problems: [] };
}

export function parseStops(raw: RawStops): LoadedStops {
  const problems: string[] = [];
  const defaults: NonNullable<StopsFile['defaults']> = {};
  for (const k of ['slPct', 'hardPct'] as const) {
    const v = raw.defaults?.[k];
    if (v == null) continue;
    if (isPct(v)) defaults[k] = v;
    else problems.push(`defaults.${k} = ${JSON.stringify(v)} ignored — use a number above 0 and below 100, or null`);
  }
  if (raw.stops == null) {
    const other = Object.keys(raw).filter((k) => k !== 'defaults');
    problems.push(`no "stops" list found${other.length ? ` (found ${other.map((k) => `"${k}"`).join(', ')} — a typo?)` : ''} — no rules loaded`);
  } else if (!Array.isArray(raw.stops)) {
    problems.push('"stops" must be a list — no rules loaded');
    return { file: { defaults, stops: [] }, problems };
  }
  const stops: StopRule[] = [];
  const seen = new Set<string>();
  (raw.stops ?? []).forEach((r: any, i: number) => {
    const { rule, problems: ps } = checkRule(r);
    const who = r && typeof r === 'object' ? ` (${r.account} ${r.symbol} ${r.side})` : '';
    for (const p of ps) problems.push(`stops[${i}]${who}: ${p}`);
    if (!rule) return;
    const key = `${rule.account}|${rule.symbol}|${rule.side}|${rule.positionId ?? ''}`;
    if (seen.has(key)) {
      problems.push(`stops[${i}]${who}: duplicate of an earlier rule for the same position — skipped, the earlier one is used`);
      return;
    }
    seen.add(key);
    stops.push(rule);
  });
  return { file: { defaults, stops }, problems };
}

/**
 * Validate one rule as written in sl.json. Returns no rule if it can't be used at all;
 * otherwise the usable rule, with any ignored parts explained in `problems`.
 */
export function checkRule(r: any): { rule?: StopRule; problems: string[] } {
  const problems: string[] = [];
  if (!r || typeof r !== 'object') return { problems: ['not an object — rule skipped'] };
  if (typeof r.account !== 'string' || !r.account) return { problems: ['missing "account" — rule skipped'] };
  if (typeof r.symbol !== 'string' || !normaliseSymbol(r.symbol)) return { problems: ['missing "symbol" — rule skipped'] };
  if (r.side !== 'long' && r.side !== 'short') return { problems: ['"side" must be "long" or "short" — rule skipped'] };
  const side: Side = r.side;
  const rule: StopRule = { account: r.account, symbol: normaliseSymbol(r.symbol), side, sig: ruleSig(r) };

  if (r.sl != null) {
    if (!isPrice(r.sl)) return { problems: ['"sl" must be a positive number — rule skipped'] };
    rule.sl = r.sl;
  }
  if (r.slPct != null) {
    if (!isPct(r.slPct)) return { problems: ['"slPct" must be above 0 and below 100 — rule skipped'] };
    if (rule.sl != null) problems.push('has both "sl" and "slPct" — using "sl"');
    else rule.slPct = r.slPct;
  }
  if (rule.sl == null && rule.slPct == null) return { problems: ['needs "sl" (a price) or "slPct" — rule skipped'] };

  if (r.hard != null) {
    if (!isPrice(r.hard)) problems.push('"hard" must be a positive number — emergency level ignored');
    else if (rule.sl != null && !beyond(side, r.hard, rule.sl)) {
      problems.push(`"hard" ${r.hard} must be ${side === 'long' ? 'below' : 'above'} the soft SL ${rule.sl} — emergency level ignored`);
    } else rule.hard = r.hard;
  }
  if (r.hardPct != null) {
    if (!isPct(r.hardPct)) problems.push('"hardPct" must be above 0 and below 100 — ignored');
    else if (rule.hard != null) problems.push('has both "hard" and "hardPct" — using "hard"');
    else rule.hardPct = r.hardPct;
  }
  if (r.positionId != null) {
    if (validId(r.positionId)) rule.positionId = String(r.positionId);
    else problems.push('"positionId" is not valid — ignored');
  }
  if (typeof r.note === 'string') rule.note = r.note;
  return { rule, problems };
}

/** Fingerprint of a rule as written, so the bot only edits a rule if nobody changed it meanwhile. */
export function ruleSig(r: any): string {
  return JSON.stringify([
    r?.account ?? null,
    typeof r?.symbol === 'string' ? normaliseSymbol(r.symbol) : null,
    r?.side ?? null,
    r?.sl ?? null,
    r?.slPct ?? null,
    r?.hard ?? null,
    r?.hardPct ?? null,
    r?.positionId != null ? String(r.positionId) : null,
  ]);
}

/** The same fingerprint after the rule is tied to `positionId`. */
export function boundSig(sig: string, positionId: string): string {
  const a = JSON.parse(sig);
  a[7] = positionId;
  return JSON.stringify(a);
}

/** Remove the rule with this fingerprint. */
export function removeRuleBySig(raw: RawStops, sig: string): boolean {
  if (!Array.isArray(raw.stops)) return false;
  const before = raw.stops.length;
  raw.stops = raw.stops.filter((r) => ruleSig(r) !== sig);
  return raw.stops.length !== before;
}

/** Tie the (still untied) rule with this fingerprint to a position. */
export function bindRuleBySig(raw: RawStops, sig: string, positionId: string): boolean {
  if (!Array.isArray(raw.stops)) return false;
  const r = raw.stops.find((x) => x && typeof x === 'object' && !validId(x.positionId) && ruleSig(x) === sig);
  if (!r) return false;
  r.positionId = positionId;
  return true;
}

/**
 * Put `rule` in place of the existing rule(s) for its account/symbol/side. A rule tied to a position
 * only replaces untied rules and the rule for that same position (other positions keep theirs).
 * Returns how many rules it replaced.
 */
export function replaceRule(raw: RawStops, rule: Record<string, any>): number {
  const same = (r: any) => r?.account === rule.account && normaliseSymbol(String(r?.symbol ?? '')) === rule.symbol && r?.side === rule.side;
  const replaced = (r: any) => same(r) && (!rule.positionId || !validId(r.positionId) || String(r.positionId) === rule.positionId);
  const before = (raw.stops ??= []).length;
  raw.stops = raw.stops.filter((r) => !replaced(r));
  const n = before - raw.stops.length;
  raw.stops.push(rule);
  return n;
}

/**
 * Edit sl.json in place: everything you didn't touch stays exactly as written. If the file changes
 * while the edit is being made (the CLI and the bot, or you in an editor), it starts over on the new
 * version instead of overwriting it. `fn` returns false to skip writing. Throws if unreadable.
 */
export function editStops(fn: (raw: RawStops) => boolean, path = STOPS_FILE): boolean {
  for (let attempt = 0; attempt < 5; attempt++) {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    const raw = before === undefined ? { defaults: { slPct: null, hardPct: null }, stops: [] } : toRawStops(parseJson(before), path);
    if (raw.stops == null) raw.stops = [];
    if (!Array.isArray(raw.stops)) throw new Error(`${path}: "stops" must be a list`);
    if (!fn(raw)) return false;
    const unchanged = () => (existsSync(path) ? readFileSync(path, 'utf8') : undefined) === before;
    if (writeAtomic(path, formatStops(raw), unchanged)) return true;
  }
  throw new Error(`${path} kept changing while being edited — not saved`);
}

/** State that must survive a restart (unfinished closes, stopped positions), as a JSON file. */
export function fileStateStore(path: string) {
  return {
    load: () => (existsSync(path) ? parseJson(readFileSync(path, 'utf8')) : undefined),
    save: (state: unknown) => void writeAtomic(path, JSON.stringify(state, null, 1) + '\n'),
  };
}

function toRawStops(v: unknown, path: string): RawStops {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${path}: expected an object like {"defaults": {...}, "stops": [...]}`);
  return v as RawStops;
}

const validId = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && String(v) !== '';

/** One rule per line, so the file stays easy to edit by hand. */
export function formatStops(raw: RawStops): string {
  const { stops = [], ...rest } = raw;
  const head = Object.entries(rest).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  const body = stops.map((r) => `    ${JSON.stringify(r)}`).join(',\n');
  return `{\n${[...head, `  "stops": [${stops.length ? `\n${body}\n  ` : ''}]`].join(',\n')}\n}\n`;
}

/**
 * Temp file (unique name, flushed to disk) + rename, so a crash or power cut never leaves a
 * half-written file. If `stillOk` says the target changed meanwhile, nothing is replaced.
 */
function writeAtomic(path: string, text: string, stillOk: () => boolean = () => true): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!stillOk()) {
    unlinkSync(tmp);
    return false;
  }
  renameSync(tmp, path);
  return true;
}

// ── resolving a position's stop ────────────────────────────────────────────

/** A rule tied to a position applies only to that position; an untied rule applies to any. */
export function findRule(stops: StopsFile, account: string, p: Position): StopRule | undefined {
  const cands = stops.stops.filter((r) => r.account === account && r.symbol === p.key && r.side === p.side);
  if (!p.positionId) return cands.find((r) => !r.positionId) ?? cands[0];
  return cands.find((r) => r.positionId === p.positionId) ?? cands.find((r) => !r.positionId);
}

export type ResolvedStop =
  | { kind: 'none' }
  | { kind: 'error'; message: string; rule?: StopRule }
  | { kind: 'ok'; sl: number; hard?: number; rule?: StopRule; warning?: string };

/** The levels that apply to a position. */
export function resolveStop(stops: StopsFile, account: string, p: Position): ResolvedStop {
  const rule = findRule(stops, account, p);
  const slPct = rule ? rule.slPct : stops.defaults?.slPct ?? undefined;
  let sl = rule?.sl;
  if (sl == null && slPct) {
    if (!(p.entryPrice > 0)) return { kind: 'error', rule, message: `the exchange didn't report an entry price, so the ${slPct}% stop can't be worked out` };
    sl = offset(p.entryPrice, p.side, slPct);
  }
  if (sl == null || !Number.isFinite(sl)) return { kind: 'none' };

  // Emergency level: a price, or a % beyond the soft SL. A rule without its own falls back to the default.
  let hard: number | undefined = rule?.hard;
  if (hard == null) {
    const hardPct = rule?.hardPct ?? stops.defaults?.hardPct ?? undefined;
    if (hardPct) hard = offset(sl, p.side, hardPct);
  }
  let warning: string | undefined;
  if (hard != null && !beyond(p.side, hard, sl)) {
    warning = `emergency level ${round(hard)} isn't ${p.side === 'long' ? 'below' : 'above'} the soft SL ${round(sl)}, so it is ignored`;
    hard = undefined;
  }
  return { kind: 'ok', sl, hard, rule, warning };
}

export function hasHardLevels(stops: StopsFile, account: string): boolean {
  return !!stops.defaults?.hardPct || stops.stops.some((r) => r.account === account && (r.hard != null || r.hardPct != null));
}

/** `pct` % away from `ref`, on the losing side of the position. */
export function offset(ref: number, side: Side, pct: number) {
  return side === 'long' ? ref * (1 - pct / 100) : ref * (1 + pct / 100);
}

/** Long: price below level. Short: price above level. */
export function isBreached(side: Side, price: number, level: number) {
  return side === 'long' ? price < level : price > level;
}

/** Is `level` further from the market than `sl` (below it for a long, above it for a short)? */
export function beyond(side: Side, level: number, sl: number) {
  return isBreached(side, level, sl);
}

const isPrice = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isPct = (v: unknown): v is number => typeof v === 'number' && v > 0 && v < 100;
const round = (n: number) => Number(n.toPrecision(8));
