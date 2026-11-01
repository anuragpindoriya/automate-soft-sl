import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOUR, LATE_ACCEPT_MS, STALE_RULE_MS, SoftSlEngine, isFinal, samePosition, type StateStore } from '../src/engine.js';
import { parseStops, type RawStops } from '../src/config.js';
import type { Candle, ExchangeAdapter, Interval, Position } from '../src/types.js';

const BOUNDARY = Date.UTC(2026, 10, 1, 10); // 10:00 UTC — the hour that just closed
const CLOSED = BOUNDARY - HOUR; // 09:00 candle
const MIN = 60_000;

function pos(o: Partial<Position> & Pick<Position, 'key' | 'side'>): Position {
  return { symbol: o.key, size: 1, sizeRaw: '1', entryPrice: 100, hedge: true, positionId: `${o.key}-${o.side}`, ...o };
}

class MockExchange implements ExchangeAdapter {
  readonly exchange = 'bingx' as const;
  closed: Position[] = []; // via the close-position endpoint
  orders: Position[] = []; // via the fallback order
  failCloses = 0; // close endpoint throws this many times
  failOrders = 0; // fallback order throws this many times
  closeThenThrow = false; // …after actually closing (a timeout on a close that went through)
  ignoreCloses = false; // accepts closes but the position stays open
  emptyReads = 0; // the next N position reads come back empty (an API glitch)
  orderDoes: 'close' | 'grow' | 'flip' | 'spawn' = 'close'; // what a fallback order really does
  constructor(
    public positions: Position[],
    public candles: Record<string, Candle[]>,
    public minuteClose: Record<string, number> = {},
  ) {}
  async getPositions() {
    if (this.emptyReads > 0) {
      this.emptyReads--;
      return [];
    }
    return this.positions.map((p) => ({ ...p }));
  }
  async getCandles(symbol: string, interval: Interval) {
    if (interval === '1m') return [{ openTime: 0, open: 0, high: 0, low: 0, close: this.minuteClose[symbol] }];
    return this.candles[symbol] ?? [];
  }
  private remove(p: Position) {
    if (!this.ignoreCloses) this.positions = this.positions.filter((q) => !samePosition(q, p));
  }
  async closePosition(p: Position) {
    if (this.failCloses > 0) {
      this.failCloses--;
      if (this.closeThenThrow) this.remove(p);
      throw new Error('exchange said no');
    }
    this.closed.push(p);
    this.remove(p);
    return 'close-1';
  }
  async closeWithOrder(p: Position) {
    if (this.failOrders > 0) {
      this.failOrders--;
      throw new Error('order rejected');
    }
    this.orders.push(p);
    const i = this.positions.findIndex((q) => samePosition(q, p));
    if (this.orderDoes === 'grow') this.positions[i] = { ...this.positions[i], size: this.positions[i].size * 2, sizeRaw: String(this.positions[i].size * 2) };
    else if (this.orderDoes === 'flip') this.positions[i] = { ...this.positions[i], side: p.side === 'long' ? 'short' : 'long' };
    else {
      this.remove(p);
      if (this.orderDoes === 'spawn') this.positions.push({ ...p, side: p.side === 'long' ? 'short' : 'long', positionId: 'SPAWNED' });
    }
    return 'order-1';
  }
}

/** Closed 09:00 candle with `close`, plus the forming 10:00 candle with `forming`. */
const hour = (close: number, forming = close): Candle[] => [
  { openTime: CLOSED - HOUR, open: 100, high: 100, low: 100, close: 100 },
  { openTime: CLOSED, open: 100, high: 100, low: 50, close },
  { openTime: BOUNDARY, open: close, high: close, low: close, close: forming },
];

function memoryState(): StateStore & { data?: unknown } {
  const s: StateStore & { data?: unknown } = { load: () => structuredClone(s.data), save: (d) => void (s.data = structuredClone(d)) };
  return s;
}

function setup(ex: MockExchange, raw: RawStops, o: { dryRun?: boolean; now?: number; state?: StateStore } = {}) {
  const store = { raw: structuredClone(raw), broken: false };
  const alerts: string[] = [];
  const clock = { t: o.now ?? BOUNDARY + 5000 };
  const state = o.state ?? memoryState();
  const make = () =>
    new SoftSlEngine({
      accounts: [{ name: 'acc', adapter: ex }],
      loadStops: () => {
        if (store.broken) throw new Error('Unexpected end of JSON input');
        return parseStops(structuredClone(store.raw));
      },
      editStops: (fn) => {
        if (store.broken) throw new Error('Unexpected end of JSON input');
        const copy = structuredClone(store.raw);
        if (!fn(copy)) return false;
        store.raw = copy;
        return true;
      },
      notify: async (t) => void alerts.push(t),
      dryRun: o.dryRun ?? false,
      candleRetryMs: 1,
      verifyDelayMs: 1,
      confirmDelayMs: 1,
      state,
      now: () => clock.t,
    });
  return { engine: make(), make, store, alerts, clock, state };
}

const rule = (o: object = {}): RawStops => ({ stops: [{ account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90, ...o }] });
const tick = (e: SoftSlEngine) => e.tick('acc', { hardCheck: false });

// ── the basics ──────────────────────────────────────────────────────────────

test('long closes when the hourly close is below SL, and its rule is removed', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(89) });
  const { engine, store, alerts } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
  assert.equal(ex.closed.length, 1);
  assert.equal(store.raw.stops!.length, 0);
  assert.match(alerts.join('\n'), /closed/);
});

test('a wick below SL does not trigger — only the close counts', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(91) }); // low 50, close 91
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'ok');
  assert.equal(ex.closed.length, 0);
});

test('the still-forming candle is ignored', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(95, 10) });
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'ok');
  assert.equal(r.price, 95);
});

test('short closes when the hourly close is above SL', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'short' })], { BTCUSDT: hour(111) });
  const { engine } = setup(ex, rule({ side: 'short', sl: 110 }));
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
});

test('hedge mode: only the breached side is closed', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' }), pos({ key: 'BTCUSDT', side: 'short' })], { BTCUSDT: hour(89) });
  const { engine } = setup(ex, {
    stops: [
      { account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90 },
      { account: 'acc', symbol: 'BTCUSDT', side: 'short', sl: 110 },
    ],
  });
  const res = await engine.runHourly(BOUNDARY);
  assert.deepEqual(res.map((r) => [r.side, r.action]), [['long', 'closed'], ['short', 'ok']]);
  assert.deepEqual(ex.positions.map((p) => p.side), ['short']);
});

test('dry run alerts but sends no order', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  const { engine, store, alerts } = setup(ex, rule(), { dryRun: true });
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'would-close');
  assert.equal(ex.closed.length + ex.orders.length, 0);
  assert.equal(store.raw.stops!.length, 1);
  assert.match(alerts.join(), /DRY RUN/);
});

test('default slPct protects positions without a rule (and the default is not deleted)', async () => {
  const ex = new MockExchange([pos({ key: 'ETHUSDT', side: 'long', entryPrice: 200 })], { ETHUSDT: hour(193) });
  const { engine, store } = setup(ex, { defaults: { slPct: 3 }, stops: [] }); // SL = 194
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
  assert.equal(r.level, 194);
  assert.equal(store.raw.defaults.slPct, 3);
});

test('unprotected positions are warned about, alerted only once', async () => {
  const ex = new MockExchange([pos({ key: 'SOLUSDT', side: 'long' })], {});
  const { engine, alerts, clock } = setup(ex, { stops: [] });
  assert.equal((await engine.runHourly(BOUNDARY))[0].action, 'unprotected');
  clock.t += HOUR;
  await engine.runHourly(BOUNDARY + HOUR);
  assert.equal(alerts.filter((a) => a.includes('no stop')).length, 1);
});

test('a % stop with no entry price is an error, not "unprotected"', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long', entryPrice: NaN })], { BTCUSDT: hour(10) });
  const { engine, alerts } = setup(ex, rule({ sl: undefined, slPct: 5 }));
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'error');
  assert.match(alerts.join(), /entry price/);
  assert.equal(ex.closed.length, 0);
});

test('a candle with a zero close is ignored, never read as a breach', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(0) });
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'no-candle');
  assert.equal(ex.closed.length, 0);
});

// ── never close a position other than the breached one ──────────────────────

test('multi-position: only the breached position is closed, by id', async () => {
  const a = pos({ key: 'BTCUSDT', side: 'long', positionId: 'A', entryPrice: 100 }); // 5% SL = 95
  const b = pos({ key: 'BTCUSDT', side: 'long', positionId: 'B', entryPrice: 80 }); //  5% SL = 76
  const ex = new MockExchange([a, b], { BTCUSDT: hour(90) });
  const { engine, store } = setup(ex, rule({ sl: undefined, slPct: 5 }));
  const res = await engine.runHourly(BOUNDARY);
  assert.deepEqual(res.map((r) => r.action), ['closed', 'ok']);
  assert.deepEqual(ex.closed.map((p) => p.positionId), ['A']);
  assert.deepEqual(ex.positions.map((p) => p.positionId), ['B']);
  assert.equal(store.raw.stops!.length, 1, 'rule kept: position B still uses it');
});

test('no fallback order when several positions share symbol + side', async () => {
  const ex = new MockExchange(
    [pos({ key: 'BTCUSDT', side: 'long', positionId: 'A' }), pos({ key: 'BTCUSDT', side: 'long', positionId: 'B', entryPrice: 50 })],
    { BTCUSDT: hour(80) },
  );
  ex.failCloses = 3;
  const { engine } = setup(ex, rule({ sl: undefined, slPct: 5 }));
  const res = await engine.runHourly(BOUNDARY);
  assert.equal(res[0].action, 'error');
  assert.equal(ex.orders.length, 0);
  assert.equal(ex.positions.length, 2);
});

test('samePosition needs the same symbol and side, not just the same id', () => {
  const a = pos({ key: 'BTCUSDT', side: 'long', positionId: '1' });
  assert.equal(samePosition(a, { ...a }), true);
  assert.equal(samePosition(a, { ...a, side: 'short' }), false);
  assert.equal(samePosition(a, { ...a, key: 'ETHUSDT' }), false);
});

// ── the fallback order only goes out if the position is still there ─────────

test('close endpoint fails → fallback market order closes it', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 1;
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
  assert.equal(ex.orders.length, 1);
});

test('close endpoint errors after actually closing → no fallback order is sent', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 1;
  ex.closeThenThrow = true;
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
  assert.equal(ex.orders.length, 0);
});

// ── a close that makes things worse stops everything for that position ─────

test('a fallback order that GROWS the position: one order, then automation stops for it', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 1; // the next attempt's close endpoint would "work" — it must never get that far
  ex.orderDoes = 'grow';
  const { engine, alerts } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'error');
  assert.equal(ex.orders.length, 1, 'exactly one bad order');
  assert.equal(ex.closed.length, 0, 'no further close attempt on the grown position');
  assert.match(alerts.join(), /STOPPED closing .*it grew from 1 to 2/);
  for (let i = 0; i < 5; i++) await engine.runHardCheck('acc');
  await engine.runHourly(BOUNDARY); // same hour again
  assert.equal(ex.orders.length, 1, 'nothing more is sent: no retries, no re-checks');
});

test('a fallback order that flips the position to the other side stops automation for it', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 99;
  ex.orderDoes = 'flip';
  const { engine, alerts } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  assert.equal(ex.orders.length, 1);
  assert.match(alerts.join(), /STOPPED closing .*turned into BTCUSDT SHORT/);
});

test('a new position that appears right after a fallback order is flagged and left alone', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 1;
  ex.orderDoes = 'spawn';
  const { engine, alerts, clock } = setup(ex,{ stops: [{ account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90 }, { account: 'acc', symbol: 'BTCUSDT', side: 'short', sl: 70 }] });
  await engine.runHourly(BOUNDARY);
  assert.match(alerts.join(), /NEW position acc BTCUSDT SHORT/);
  ex.candles.BTCUSDT = hour(75); // the short's 70 stop is breached at the next close
  clock.t = BOUNDARY + HOUR + 2 * MIN;
  const [r] = await engine.runHourly(BOUNDARY + HOUR);
  assert.equal(r.action, 'error');
  assert.deepEqual(ex.positions.map((p) => p.positionId), ['SPAWNED'], 'the flagged short is never closed automatically');
  assert.match(alerts.at(-1)!, /automatic closing is STOPPED/);
});

test('a pending close whose position grew in the meantime is stopped, not retried', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, alerts } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  const sent = ex.closed.length;
  ex.positions = [pos({ key: 'BTCUSDT', side: 'long', size: 3, sizeRaw: '3' })];
  await tick(engine);
  assert.equal(ex.closed.length, sent);
  assert.match(alerts.join(), /STOPPED closing/);
});

// ── emergency level ─────────────────────────────────────────────────────────

test('hardPct is measured beyond the soft SL, so it can never sit inside it', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 87 });
  const { engine } = setup(ex, { defaults: { hardPct: 5 }, stops: [{ account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90 }] }); // hard 85.5
  assert.deepEqual(await engine.runHardCheck('acc'), []); // 87: below soft 90, above hard 85.5
  ex.minuteClose.BTCUSDT = 85;
  const [r] = await engine.runHardCheck('acc');
  assert.equal(r.action, 'closed');
  assert.equal(r.level, 85.5);
});

test('a hard price that is not beyond the soft SL is ignored, with a warning', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long', entryPrice: 100 })], {}, { BTCUSDT: 93 });
  const { engine, alerts } = setup(ex, rule({ sl: undefined, slPct: 10, hard: 95 })); // soft 90, "hard" 95
  assert.deepEqual(await engine.runHardCheck('acc'), []);
  assert.equal(ex.closed.length, 0);
  assert.match(alerts.join(), /isn't below the soft SL/);
});

test('emergency level closes intra-hour; between soft and hard it waits for the close', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 87 });
  const { engine } = setup(ex, rule({ hard: 85 }));
  assert.equal((await engine.runHardCheck('acc')).length, 0);
  ex.minuteClose.BTCUSDT = 84;
  const [r] = await engine.runHardCheck('acc');
  assert.equal(r.action, 'closed');
});

test('a zero last price never triggers the emergency level', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 0 });
  const { engine } = setup(ex, rule({ hard: 85 }));
  assert.deepEqual(await engine.runHardCheck('acc'), []);
});

test('dry-run emergency breach alerts once an hour, not every tick', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 80 });
  const { engine, alerts, clock } = setup(ex, rule({ hard: 85 }), { dryRun: true });
  await engine.runHardCheck('acc');
  clock.t += 30_000;
  await engine.runHardCheck('acc');
  assert.equal(alerts.filter((a) => a.includes('DRY RUN')).length, 1);
});

// ── a still-forming candle is never treated as closed ───────────────────────

test('isFinal: exchange flag first, then a later candle, then time', () => {
  const c: Candle = { openTime: CLOSED, open: 1, high: 1, low: 1, close: 1 };
  assert.equal(isFinal({ ...c, closed: true }, [c], BOUNDARY, BOUNDARY), true);
  assert.equal(isFinal({ ...c, closed: false }, [c], BOUNDARY, BOUNDARY + HOUR), false);
  assert.equal(isFinal(c, [c, { ...c, openTime: BOUNDARY }], BOUNDARY, BOUNDARY - 10_000), true);
  assert.equal(isFinal(c, [c], BOUNDARY, BOUNDARY + 5000), false);
  assert.equal(isFinal(c, [c], BOUNDARY, BOUNDARY + LATE_ACCEPT_MS), true);
});

test('candle with no "final" flag and no later candle is not used right after the hour', async () => {
  // e.g. our clock runs ahead of the exchange's: the 09:00 candle is still forming there.
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80).slice(0, 2) });
  const { engine, alerts } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY, { final: false });
  assert.equal(r.action, 'no-candle');
  assert.equal(ex.closed.length, 0);
  assert.equal(alerts.length, 0, 'no alert yet — a retry may still get it');
});

test('candle flagged as still forming is not used', async () => {
  const forming = hour(80).map((c) => ({ ...c, closed: c.openTime === CLOSED ? false : true }));
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: forming });
  const { engine, alerts } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'no-candle');
  assert.match(alerts.join(), /NOT evaluated/);
});

// ── a position is only judged on closes that happened after it opened ───────

test('a position opened after the close is never judged on it', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long', openTime: BOUNDARY + 2000 })], { BTCUSDT: hour(80) });
  const { engine } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'skipped');
  assert.equal(ex.closed.length, 0);
});

test('a retry only checks positions not checked yet, and skips ones it can’t place before the close', async () => {
  const a = pos({ key: 'BTCUSDT', side: 'long', positionId: 'A' });
  const ex = new MockExchange([a, pos({ key: 'ETHUSDT', side: 'long' })], { BTCUSDT: hour(95) }); // no ETH candle yet
  const { engine, clock } = setup(ex, { stops: [...rule().stops!, { account: 'acc', symbol: 'ETHUSDT', side: 'long', sl: 90 }] });
  const first = await engine.runHourly(BOUNDARY, { final: false });
  assert.deepEqual(first.map((r) => [r.symbol, r.action]), [['BTCUSDT', 'ok'], ['ETHUSDT', 'no-candle']]);

  // +1 min: ETH's candle is out; a brand-new BTC long (unknown open time) appeared after the close.
  clock.t = BOUNDARY + MIN;
  ex.candles.ETHUSDT = hour(80);
  ex.candles.BTCUSDT = hour(10);
  ex.positions.push(pos({ key: 'BTCUSDT', side: 'long', positionId: 'NEW' }));
  const retry = await engine.runHourly(BOUNDARY, { strict: true });
  assert.deepEqual(retry.map((r) => [r.symbol, r.action]), [['BTCUSDT', 'skipped'], ['ETHUSDT', 'closed']]);
  assert.deepEqual(ex.closed.map((p) => p.key), ['ETHUSDT'], 'A was checked already, NEW opened after the close');
});

// ── one bad API reply is never taken at its word ────────────────────────────

test('an empty read after a failed close does not count as "closed"', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.failCloses = 99;
  ex.failOrders = 99;
  const { engine, store } = setup(ex, rule());
  const real = ex.getPositions.bind(ex);
  let n = 0;
  ex.getPositions = async () => (++n === 3 ? [] : real()); // the first verify read glitches
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'error');
  assert.equal(store.raw.stops!.length, 1, 'rule kept');
});

test('one empty read does not drop a pending close', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, alerts } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  ex.emptyReads = 1;
  await tick(engine);
  assert.doesNotMatch(alerts.join(), /is closed now/);
  ex.ignoreCloses = false;
  const [t] = await tick(engine);
  assert.equal(t.action, 'closed');
});

test('an empty positions list right after positions were open is double-checked and retried', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(95) });
  const { engine, clock } = setup(ex, rule(), { now: BOUNDARY - 10_000 });
  await tick(engine); // positions seen just before the close
  clock.t = BOUNDARY + 5000;
  ex.emptyReads = 3;
  const [r] = await engine.runHourly(BOUNDARY, { final: false });
  assert.equal(r.action, 'no-positions');
  const [again] = await engine.runHourly(BOUNDARY, { strict: true });
  assert.equal(again.action, 'ok', 'the retry checks the position that was hidden');
});

// ── a bad sl.json never silently switches protection off ────────────────────

test('one invalid rule is skipped with an alert; the others still work', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  const { engine, alerts } = setup(ex, {
    stops: [
      { account: 'acc', symbol: 'ETHUSDT', side: 'sideways', sl: 1 },
      { account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90 },
    ],
  });
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'closed');
  assert.match(alerts.join(), /problem in sl\.json.*side/);
});

test('unreadable sl.json → last good copy is used, with an alert', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(95) });
  const { engine, store, alerts, clock } = setup(ex, rule());
  assert.equal((await engine.runHourly(BOUNDARY))[0].action, 'ok');
  store.broken = true;
  ex.candles.BTCUSDT = hour(80); // its 10:00 candle is final by 11:02
  clock.t = BOUNDARY + HOUR + 2 * MIN;
  const [r] = await engine.runHourly(BOUNDARY + HOUR);
  assert.equal(r.action, 'closed');
  assert.match(alerts.join(), /can't be read.*last good copy/);
});

test('unreadable sl.json at first start → account error and alert', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  const { engine, store, alerts } = setup(ex, rule());
  store.broken = true;
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'error');
  assert.match(alerts.join(), /FAILED/);
});

test('while sl.json is unwritable, ties are kept in memory and written once it is fixed', async () => {
  const ex = new MockExchange([], {});
  const { engine, store } = setup(ex, rule());
  await tick(engine); // good copy loaded: one untied rule
  store.broken = true;
  ex.positions = [pos({ key: 'BTCUSDT', side: 'long', positionId: 'A' })];
  await tick(engine); // tied to A in memory only
  ex.positions = [pos({ key: 'BTCUSDT', side: 'long', positionId: 'B', entryPrice: 85 })]; // A closed outside the bot, B opened
  ex.candles.BTCUSDT = hour(88);
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'unprotected', 'the old stop does not land on B');
  store.broken = false;
  await tick(engine);
  assert.equal(store.raw.stops![0].positionId, 'A', 'the tie reached the file');
});

// ── failures are retried instead of giving up for the hour ──────────────────

test('a close that keeps failing alerts once, then tick() keeps retrying until it works', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, alerts, store } = setup(ex, rule());
  const [r] = await engine.runHourly(BOUNDARY);
  assert.equal(r.action, 'error');
  assert.equal(ex.closed.length, 3);
  await tick(engine); // still failing
  assert.equal(alerts.filter((a) => a.includes('could NOT close')).length, 1, 'repeat alerts are rate-limited');
  ex.ignoreCloses = false;
  const [t] = await tick(engine);
  assert.equal(t.action, 'closed');
  assert.equal(ex.positions.length, 0);
  assert.equal(store.raw.stops!.length, 0);
  assert.deepEqual(await tick(engine), [], 'nothing left to retry');
});

test('a failing close is dropped once the next 1h close is back inside the SL', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, alerts, clock } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  const next = BOUNDARY + HOUR;
  clock.t = next + 5000;
  ex.candles.BTCUSDT = [
    { openTime: CLOSED, open: 1, high: 1, low: 1, close: 80 },
    { openTime: next - HOUR, open: 1, high: 1, low: 1, close: 95 },
    { openTime: next, open: 1, high: 1, low: 1, close: 95 },
  ];
  assert.equal((await engine.runHourly(next))[0].action, 'ok');
  assert.deepEqual(await tick(engine), []);
  assert.match(alerts.join(), /no longer trying to close/);
});

test('a failing close stops being retried when the next hourly close is due', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, clock } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  clock.t = BOUNDARY + HOUR + 1000;
  const [t] = await tick(engine);
  assert.equal(t.action, 'cancelled');
});

test('a failing close is dropped when you remove its rule', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, store } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  store.raw.stops = [];
  const [t] = await tick(engine);
  assert.equal(t.action, 'cancelled');
});

test('a close that went through later is reported and not retried', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, alerts } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  ex.positions = [];
  assert.deepEqual(await tick(engine), []);
  assert.match(alerts.join(), /is closed now/);
});

test('unfinished closes and stopped positions survive a restart', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' }), pos({ key: 'ETHUSDT', side: 'long' })], { BTCUSDT: hour(80), ETHUSDT: hour(80) });
  ex.ignoreCloses = true;
  const { engine, make, store } = setup(ex, { stops: [...rule().stops!, { account: 'acc', symbol: 'ETHUSDT', side: 'long', sl: 90 }] });
  await engine.runHourly(BOUNDARY); // both fail → pending
  ex.positions[1] = { ...ex.positions[1], size: 2, sizeRaw: '2' };
  await tick(engine); // ETH grew → stopped
  const restarted = make();
  ex.ignoreCloses = false;
  const res = await tick(restarted);
  assert.deepEqual(res.map((r) => [r.symbol, r.action]), [['BTCUSDT', 'closed']]);
  assert.equal(ex.positions.length, 1, 'ETH stays stopped after the restart');
  assert.equal(store.raw.stops!.length, 1);
});

test('after stop(), no new work starts', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) }, { BTCUSDT: 1 });
  const { engine } = setup(ex, rule({ hard: 85 }));
  engine.stop();
  assert.deepEqual(await engine.runHardCheck('acc'), []);
  assert.deepEqual(await engine.runHourly(BOUNDARY), []);
  await engine.drain();
  assert.equal(ex.closed.length, 0);
});

// ── an old rule never applies to a new position ─────────────────────────────

test('a rule is tied to its position; a new position does not inherit it, and the stale rule is removed', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long', positionId: 'OLD' })], { BTCUSDT: hour(95) });
  const { engine, store, alerts, clock } = setup(ex, rule());
  await engine.runHourly(BOUNDARY);
  assert.equal(store.raw.stops![0].positionId, 'OLD', 'tied on first sight');

  // Take-profit closed OLD outside the bot; a new long is opened at a lower price.
  ex.positions = [pos({ key: 'BTCUSDT', side: 'long', positionId: 'NEW', entryPrice: 85 })];
  ex.candles.BTCUSDT = hour(88); // below the old 90 stop
  clock.t += HOUR;
  const [r] = await engine.runHourly(BOUNDARY + HOUR);
  assert.equal(r.action, 'unprotected');
  assert.equal(ex.closed.length, 0, 'the old stop must not close the new trade');

  for (let i = 0; i < 3; i++) {
    clock.t += STALE_RULE_MS / 2;
    await tick(engine);
  }
  assert.equal(store.raw.stops!.length, 0);
  assert.match(alerts.join(), /removed the acc BTCUSDT LONG rule/);
});

test('a rule set before the position exists ties itself to the first one seen, between hourly checks too', async () => {
  const ex = new MockExchange([], {});
  const { engine, store } = setup(ex, rule());
  await tick(engine);
  assert.equal(store.raw.stops![0].positionId, undefined);
  ex.positions = [pos({ key: 'BTCUSDT', side: 'long', positionId: '777' })];
  await tick(engine); // no emergency levels needed
  assert.equal(store.raw.stops![0].positionId, '777');
});

test('a few empty positions replies do not wipe tied rules', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long', positionId: 'X' })], { BTCUSDT: hour(95) });
  const { engine, store, clock } = setup(ex, rule());
  await tick(engine);
  for (let i = 0; i < 6; i++) {
    ex.emptyReads = 2; // the read and its confirmation
    clock.t += 30_000;
    await tick(engine);
  }
  assert.equal(store.raw.stops!.length, 1);
});

// ── accounts never wait on each other ───────────────────────────────────────

test('one hanging exchange does not hold up another account', async () => {
  const good = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 80 });
  const stuck = new MockExchange([], {});
  stuck.getPositions = () => new Promise<Position[]>(() => {});
  const engine = new SoftSlEngine({
    accounts: [
      { name: 'stuck', adapter: stuck },
      { name: 'acc', adapter: good },
    ],
    loadStops: () => parseStops({ defaults: { hardPct: 5 }, stops: [{ account: 'acc', symbol: 'BTCUSDT', side: 'long', sl: 90 }] }),
    editStops: () => true,
    notify: async () => {},
    dryRun: false,
    verifyDelayMs: 1,
    confirmDelayMs: 1,
  });
  void engine.tick('stuck', { hardCheck: true });
  const [r] = await engine.tick('acc', { hardCheck: true });
  assert.equal(r.action, 'closed');
});

test('one failing account does not stop the others in the hourly check', async () => {
  const good = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], { BTCUSDT: hour(80) });
  const bad = new MockExchange([], {});
  bad.getPositions = async () => {
    throw new Error('boom');
  };
  const engine = new SoftSlEngine({
    accounts: [
      { name: 'bad', adapter: bad },
      { name: 'acc', adapter: good },
    ],
    loadStops: () => parseStops(rule()),
    editStops: () => true,
    notify: async () => {},
    dryRun: false,
    candleRetryMs: 1,
    verifyDelayMs: 1,
    confirmDelayMs: 1,
  });
  const res = await engine.runHourly(BOUNDARY);
  assert.deepEqual(res.map((r) => [r.account, r.action]), [['bad', 'error'], ['acc', 'closed']]);
});

test('emergency checks that keep failing alert after 3 in a row, and again on recovery — without spamming', async () => {
  const ex = new MockExchange([pos({ key: 'BTCUSDT', side: 'long' })], {}, { BTCUSDT: 89 });
  const real = ex.getPositions.bind(ex);
  const broken = async (): Promise<Position[]> => {
    throw new Error('503');
  };
  const { engine, alerts, clock } = setup(ex, rule({ hard: 85 }));
  ex.getPositions = broken;
  for (let i = 0; i < 3; i++) await engine.runHardCheck('acc');
  assert.equal(alerts.filter((a) => a.includes('keep failing')).length, 1);
  ex.getPositions = real;
  await engine.runHardCheck('acc');
  assert.match(alerts.at(-1)!, /working again/);

  // A flapping exchange: 3 failures, 1 success, over and over — at most one alert of each kind per 15 min.
  for (let round = 0; round < 10; round++) {
    clock.t += 30_000;
    ex.getPositions = broken;
    for (let i = 0; i < 3; i++) await engine.runHardCheck('acc');
    ex.getPositions = real;
    await engine.runHardCheck('acc');
  }
  assert.ok(alerts.filter((a) => a.includes('keep failing') || a.includes('working again')).length <= 2);
});
