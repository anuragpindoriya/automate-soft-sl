import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlofinAdapter } from '../src/exchanges/blofin.js';
import { BitunixAdapter } from '../src/exchanges/bitunix.js';
import { BingxAdapter } from '../src/exchanges/bingx.js';
import { WeexAdapter } from '../src/exchanges/weex.js';
import { protectBigInts, normaliseSymbol, parseJson } from '../src/http.js';
import { parseDryRun } from '../src/env.js';
import { checkRule, editStops, loadStops, parseStops, resolveStop, ruleSig, removeRuleBySig } from '../src/config.js';
import type { Position } from '../src/types.js';

// ── signing vectors ─────────────────────────────────────────────────────────

test('BloFin signature matches BloFin’s own test vector (blofin-mcp tests/auth.test.ts)', () => {
  const s = BlofinAdapter.sign('secret', '/api/v1/test', 'GET', '1700000000000', '123e4567-e89b-12d3-a456-426614174000', '');
  assert.equal(s, 'ZTQ2N2RhODY4OTExZjc1NjQyMDVhODVhZmIxOTFhYTk1OTkxODE1ZWZjNGJhNGZmOWQ1YTA2NGQ4YTE3NGUwNw==');
});

test('Bitunix signature matches the docs’ Python sample (computed with hashlib)', () => {
  const body = '{"uid":"2899","arr":[{"id":1,"name":"maple"},{"id":2,"name":"lily"}]}';
  const s = BitunixAdapter.sign('123456', '20241120123045', 'yourApiKey', 'id1uid200', body, 'yourSecretKey');
  assert.equal(s, '00397cd1e52c7dce3258067324363b6361fabc9178a0912b330c138db8745655');
});

test('WEEX signature = base64 HMAC over ts+METHOD+path?query (Python reference)', () => {
  const s = WeexAdapter.sign('weexsecret', '1591089508404', 'get', '/capi/v3/market/klines', 'symbol=BTCUSDT&interval=1h&limit=3', '');
  assert.equal(s, 'uFLxbmtDEyxd3PlYMJSOoEEYFZ5/CND/qEmLstBqqNk=');
});

test('BingX canonical string is key-sorted and signature is hex HMAC (Python reference)', () => {
  const c = BingxAdapter.canonical({ timestamp: 1700000000000, symbol: 'BTC-USDT', recvWindow: 5000, limit: 3 });
  assert.equal(c, 'limit=3&recvWindow=5000&symbol=BTC-USDT&timestamp=1700000000000');
  assert.equal(BingxAdapter.sign('bingxsecret', c), '0eb3b18b578fa8dd7aa18fd7c0a6b1cd967ba635ef5982e82959b64a2bf5b7ee');
});

// ── helpers ─────────────────────────────────────────────────────────────────

test('19-digit ids survive JSON parsing; timestamps, decimals and strings are untouched', () => {
  const j = parseJson('{"id":1234567890123456789,"t":1700000000000,"a":[9007199254740993,-1234567890123456789],"p":"x 1234567890123456789, y","f":12345678901234567.5}');
  assert.equal(j.id, '1234567890123456789');
  assert.equal(j.t, 1700000000000);
  assert.deepEqual(j.a, ['9007199254740993', '-1234567890123456789']);
  assert.equal(j.p, 'x 1234567890123456789, y');
  assert.equal(typeof j.f, 'number');
  assert.equal(protectBigInts('{"s":"a\\"1234567890123456789"}'), '{"s":"a\\"1234567890123456789"}');
});

test('symbol normalisation', () => {
  assert.equal(normaliseSymbol('BTC-USDT'), 'BTCUSDT');
  assert.equal(normaliseSymbol('cmt_btcusdt'), 'BTCUSDT');
  assert.equal(normaliseSymbol('1000PEPE-USDT'), '1000PEPEUSDT');
});

test('DRY_RUN only turns off for an explicit false/0/no/off', () => {
  for (const v of [undefined, '', 'true', '1', 'yes', 'flase']) assert.equal(parseDryRun(v), true, String(v));
  for (const v of ['false', '0', 'no', 'off', 'OFF', ' False ']) assert.equal(parseDryRun(v), false, v);
});

// ── sl.json ─────────────────────────────────────────────────────────────────

test('rule validation: hard must be beyond the soft SL; % values must be sane', () => {
  assert.deepEqual(checkRule({ account: 'a', symbol: 'BTC-USDT', side: 'long', sl: 90, hard: 85 }).problems, []);
  assert.match(checkRule({ account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 90, hard: 95 }).problems[0], /must be below the soft SL/);
  assert.match(checkRule({ account: 'a', symbol: 'BTCUSDT', side: 'short', sl: 90, hard: 85 }).problems[0], /must be above the soft SL/);
  assert.equal(checkRule({ account: 'a', symbol: 'BTCUSDT', side: 'long', slPct: 150 }).rule, undefined);
  assert.equal(checkRule({ account: 'a', symbol: 'BTCUSDT', side: 'long' }).rule, undefined);
  const { file, problems } = parseStops({ defaults: { slPct: -5, hardPct: 2 }, stops: [] });
  assert.deepEqual(file.defaults, { hardPct: 2 });
  assert.match(problems[0], /defaults\.slPct/);
});

test('a tied rule only applies to its own position; an untied one to any', () => {
  const stops = parseStops({ stops: [{ account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 90, positionId: '1' }] }).file;
  const p = (id: string): Position => ({ symbol: 'BTCUSDT', key: 'BTCUSDT', side: 'long', size: 1, sizeRaw: '1', entryPrice: 100, hedge: true, positionId: id });
  assert.equal(resolveStop(stops, 'a', p('1')).kind, 'ok');
  assert.equal(resolveStop(stops, 'a', p('2')).kind, 'none');
});

test('editStops keeps other rules as written and removes only the exact rule', () => {
  const dir = mkdtempSync(join(tmpdir(), 'softsl-'));
  const path = join(dir, 'sl.json');
  writeFileSync(path, JSON.stringify({ defaults: { slPct: null }, stops: [{ account: 'a', symbol: 'btc-usdt', side: 'long', sl: 90, extra: 'kept' }, { account: 'a', symbol: 'ETHUSDT', side: 'short', sl: 3000 }] }));
  const [btc] = loadStops(path).file.stops;
  assert.equal(editStops((raw) => removeRuleBySig(raw, ruleSig({ ...btc, sl: 91 })), path), false, 'rule changed meanwhile → not removed');
  assert.equal(editStops((raw) => removeRuleBySig(raw, btc.sig!), path), true);
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(after.stops, [{ account: 'a', symbol: 'ETHUSDT', side: 'short', sl: 3000 }]);
  assert.match(readFileSync(path, 'utf8'), /\n {4}\{"account":"a","symbol":"ETHUSDT"/, 'one rule per line');
});

// ── request/response shape with a mocked fetch ──────────────────────────────

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}
const realFetch = globalThis.fetch;
let calls: Call[] = [];
function mockFetch(responder: (c: Call) => unknown) {
  calls = [];
  globalThis.fetch = (async (url: string, init: any) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(url), headers: init?.headers ?? {}, body: init?.body };
    calls.push(c);
    const r = responder(c);
    return new Response(typeof r === 'string' ? r : JSON.stringify(r), { status: 200 });
  }) as typeof fetch;
}
afterEach(() => {
  globalThis.fetch = realFetch;
});

const H = 3_600_000;
const t0 = Math.floor(Date.now() / H) * H - 2 * H;
const position = (o: Partial<Position>): Position => ({ symbol: 'BTCUSDT', key: 'BTCUSDT', side: 'long', size: 1, sizeRaw: '1', entryPrice: 1, hedge: true, ...o });

test('BloFin: net-mode short, contracts, confirm flag, close via close-position', async () => {
  mockFetch((c) => {
    if (c.url.includes('/account/positions'))
      return { code: '0', msg: 'success', data: [{ instId: 'ETH-USDT', positionSide: 'net', positions: '-12.5', averagePrice: '2500', marginMode: 'cross', positionId: '8' }] };
    if (c.url.includes('/market/candles'))
      return { code: '0', data: [[String(t0 + 2 * H), '1', '1', '1', '9', '', '', '', '0'], [String(t0 + H), '1', '1', '1', '8', '', '', '', '1'], [String(t0), '1', '1', '1', '7', '', '', '', '1']] };
    return { code: '0', msg: '', data: { instId: 'ETH-USDT' } };
  });
  const a = new BlofinAdapter('k', 's', 'p');
  const [p] = await a.getPositions();
  assert.deepEqual([p.side, p.size, p.sizeRaw, p.hedge, p.key], ['short', 12.5, '12.5', false, 'ETHUSDT']);

  const candles = await a.getCandles('ETH-USDT', '1h', 3);
  assert.deepEqual(candles.map((c) => [c.close, c.closed]), [[7, true], [8, true], [9, false]]);
  assert.match(calls[1].url, /bar=1H/);

  await a.closePosition(p);
  const close = calls.at(-1)!;
  assert.match(close.url, /\/api\/v1\/trade\/close-position$/);
  assert.deepEqual(JSON.parse(close.body!), { instId: 'ETH-USDT', marginMode: 'cross', positionSide: 'net', clientOrderId: JSON.parse(close.body!).clientOrderId, positionId: '8' });
  assert.ok(close.headers['ACCESS-SIGN'] && close.headers['ACCESS-NONCE'] && close.headers['ACCESS-PASSPHRASE'] === 'p');
});

test('BloFin: close-position errors are thrown (the engine decides on a fallback)', async () => {
  mockFetch(() => ({ code: '152404', msg: 'nope', data: null }));
  await assert.rejects(new BlofinAdapter('k', 's', 'p').closePosition(position({ symbol: 'BTC-USDT' })), /152404/);
});

test('BloFin: hedge fallback order uses opposite side + positionSide, no reduceOnly; one-way adds reduceOnly', async () => {
  mockFetch(() => ({ code: '0', data: [{ orderId: '77', code: '0', msg: '' }] }));
  const a = new BlofinAdapter('k', 's', 'p');
  assert.equal(await a.closeWithOrder(position({ symbol: 'BTC-USDT', size: 3, sizeRaw: '3', marginMode: 'isolated' })), 'order 77');
  let o = JSON.parse(calls.at(-1)!.body!);
  assert.deepEqual([o.side, o.positionSide, o.orderType, o.size, o.reduceOnly], ['sell', 'long', 'market', '3', undefined]);
  await a.closeWithOrder(position({ symbol: 'BTC-USDT', side: 'short', hedge: false }));
  o = JSON.parse(calls.at(-1)!.body!);
  assert.deepEqual([o.side, o.positionSide, o.reduceOnly], ['buy', 'net', 'true']);
});

test('Bitunix: signs sorted query, parses positions, candles are final, flash-closes by positionId', async () => {
  mockFetch((c) => {
    if (c.url.includes('get_pending_positions'))
      return { code: 0, data: [{ positionId: '19848247723672', symbol: 'BTCUSDT', qty: '0.5', side: 'SHORT', avgOpenPrice: '60000', marginMode: 'CROSS', positionMode: 'ONE_WAY' }] };
    if (c.url.includes('kline')) return { code: 0, data: [{ time: t0 + H, open: '1', high: '1', low: '1', close: '2' }, { time: t0, open: '1', high: '1', low: '1', close: '1' }] };
    return { code: 0, data: { positionId: '19848247723672' }, msg: 'Success' };
  });
  const a = new BitunixAdapter('key', 'sec');
  const [p] = await a.getPositions();
  assert.deepEqual([p.side, p.size, p.entryPrice, p.positionId, p.hedge], ['short', 0.5, 60000, '19848247723672', false]);

  const h = calls[0].headers;
  const expect = createHash('sha256')
    .update(createHash('sha256').update(h.nonce + h.timestamp + 'key' + '' + '').digest('hex') + 'sec')
    .digest('hex');
  assert.equal(h.sign, expect);

  assert.deepEqual((await a.getCandles('BTCUSDT', '1h', 3)).map((c) => [c.openTime, c.closed]), [[t0, true], [t0 + H, true]]);

  await a.closePosition(p);
  const c = calls.at(-1)!;
  assert.match(c.url, /flash_close_position$/);
  assert.equal(c.body, '{"positionId":"19848247723672"}');
});

test('Bitunix: fallback CLOSE order sends side = position side + tradeSide CLOSE + positionId', async () => {
  mockFetch(() => ({ code: 0, data: { orderId: '9' } }));
  const a = new BitunixAdapter('key', 'sec');
  await a.closeWithOrder(position({ positionId: '5' }));
  const o = JSON.parse(calls.at(-1)!.body!);
  assert.deepEqual([o.side, o.tradeSide, o.orderType, o.positionId, o.qty], ['BUY', 'CLOSE', 'MARKET', '5', '1']);
  await assert.rejects(a.closeWithOrder(position({})), /needs a positionId/);
  assert.equal(calls.length, 1, 'no order without a positionId');
});

test('BingX: params signed in query string, closes by positionId', async () => {
  mockFetch((c) => {
    if (c.url.includes('/user/positions'))
      return '{"code":0,"msg":"","data":[{"symbol":"BTC-USDT","positionId":1234567890123456789,"positionSide":"LONG","positionAmt":"0.01","avgPrice":"65000","isolated":true}]}';
    if (c.url.includes('klines')) return { code: 0, data: [{ time: t0 + H, open: '1', high: '1', low: '1', close: '5' }, { time: t0, open: '1', high: '1', low: '1', close: '4' }] };
    return { code: 0, msg: '', data: { orderId: 1, positionId: '1234567890123456789' } };
  });
  const a = new BingxAdapter('key', 'sec');
  const [p] = await a.getPositions();
  assert.deepEqual([p.side, p.size, p.positionId], ['long', 0.01, '1234567890123456789']);
  const u = new URL(calls[0].url);
  const sig = u.searchParams.get('signature')!;
  u.searchParams.delete('signature');
  const canon = [...u.searchParams.entries()].map(([k, v]) => `${k}=${v}`).join('&');
  assert.equal(sig, BingxAdapter.sign('sec', canon));
  assert.equal(calls[0].headers['X-BX-APIKEY'], 'key');

  assert.deepEqual((await a.getCandles('BTC-USDT', '1h', 3)).map((c) => [c.close, c.closed]), [[4, undefined], [5, undefined]]);

  await a.closePosition(p);
  const c = new URL(calls.at(-1)!.url);
  assert.equal(c.pathname, '/openApi/swap/v1/trade/closePosition');
  assert.equal(c.searchParams.get('positionId'), '1234567890123456789');
});

test('BingX: one-way fallback order uses positionSide BOTH + reduceOnly; the mode is asked every time', async () => {
  let dual = 'false';
  mockFetch((c) => (c.url.includes('positionSide/dual') ? { code: 0, data: { dualSidePosition: dual } } : { code: 0, data: { order: { orderId: 3 } } }));
  const a = new BingxAdapter('key', 'sec');
  await a.closeWithOrder(position({ symbol: 'BTC-USDT', side: 'short', size: 2, sizeRaw: '2', hedge: false }));
  let q = new URL(calls.at(-1)!.url).searchParams;
  assert.deepEqual([q.get('side'), q.get('positionSide'), q.get('reduceOnly'), q.get('type'), q.get('quantity')], ['BUY', 'BOTH', 'true', 'MARKET', '2']);
  dual = 'true';
  await a.closeWithOrder(position({ symbol: 'BTC-USDT', side: 'short' }));
  q = new URL(calls.at(-1)!.url).searchParams;
  assert.deepEqual([q.get('positionSide'), q.get('reduceOnly')], ['SHORT', null]);
});

test('WEEX: entry from openValue/size, close by exact 19-digit positionId', async () => {
  mockFetch((c) => {
    if (c.url.includes('allPosition'))
      return '[{"id":1234567890123456789,"symbol":"BTCUSDT","side":"LONG","size":"0.020000","openValue":"1801.06","marginType":"CROSSED"}]';
    if (c.url.includes('klines')) return [[t0 + H, '1', '1', '1', '3', '0', t0 + 2 * H - 1], [t0, '1', '1', '1', '2', '0', t0 + H - 1]];
    return [{ positionId: 1, success: true, successOrderId: 42 }];
  });
  const a = new WeexAdapter('k', 's', 'p');
  const [p] = await a.getPositions();
  assert.equal(p.positionId, '1234567890123456789');
  assert.ok(Math.abs(p.entryPrice - 90053) < 0.01);

  assert.deepEqual((await a.getCandles('BTCUSDT', '1h', 3)).map((c) => c.close), [2, 3]);

  assert.equal(await a.closePosition(p), 'closePositions order 42');
  const c = calls.at(-1)!;
  assert.equal(c.body, '{"positionId":1234567890123456789}');
  assert.equal(c.headers['ACCESS-SIGN'], WeexAdapter.sign('s', c.headers['ACCESS-TIMESTAMP'], 'POST', '/capi/v3/closePositions', '', c.body!));
});

test('WEEX: never calls closePositions without a numeric id; failed close throws', async () => {
  mockFetch(() => [{ positionId: 1, success: false, errorMessage: 'no position' }]);
  const a = new WeexAdapter('k', 's', 'p');
  await assert.rejects(a.closePosition(position({})), /numeric positionId/);
  assert.equal(calls.length, 0);
  await assert.rejects(a.closePosition(position({ positionId: '12' })), /did not succeed: no position/);
});

test('WEEX: fallback is a reduce-only order on the position side', async () => {
  mockFetch(() => ({ orderId: 5, success: true }));
  await new WeexAdapter('k', 's', 'p').closeWithOrder(position({ side: 'short' }));
  assert.match(calls[0].url, /\/capi\/v3\/order$/);
  const o = JSON.parse(calls[0].body!);
  assert.deepEqual([o.side, o.positionSide, o.type, o.reduceOnly], ['BUY', 'SHORT', 'MARKET', true]);
});

// ── review finding 7: never guess long/short ────────────────────────────────

test('unknown position sides are an error on every exchange, never "long"', async () => {
  mockFetch(() => ({ code: '0', data: [{ instId: 'BTC-USDT', positions: '-1', averagePrice: '1' }] }));
  await assert.rejects(new BlofinAdapter('k', 's', 'p').getPositions(), /unrecognised positionSide/);
  mockFetch(() => ({ code: 0, data: [{ symbol: 'BTC-USDT', positionAmt: '-0.5', avgPrice: '1' }] }));
  await assert.rejects(new BingxAdapter('k', 's').getPositions(), /unrecognised positionSide/);
  mockFetch(() => ({ code: 0, data: [{ symbol: 'BTCUSDT', qty: '1', side: '', positionId: '1' }] }));
  await assert.rejects(new BitunixAdapter('k', 's').getPositions(), /unrecognised position side/);
  mockFetch(() => [{ id: 1, symbol: 'BTCUSDT', side: 'BOTH', size: '1', openValue: '1' }]);
  await assert.rejects(new WeexAdapter('k', 's', 'p').getPositions(), /unrecognised position side/);
});

test('BingX one-way BOTH with a negative amount is a short', async () => {
  mockFetch(() => ({ code: 0, data: [{ symbol: 'BTC-USDT', positionSide: 'BOTH', positionAmt: '-0.5', avgPrice: '1', positionId: '1' }] }));
  const [p] = await new BingxAdapter('k', 's').getPositions();
  assert.deepEqual([p.side, p.sizeRaw], ['short', '0.5']);
});
