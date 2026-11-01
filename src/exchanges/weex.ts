import { createHmac } from 'node:crypto';
import type { Candle, ExchangeAdapter, Interval, Position, Side } from '../types.js';
import { ApiError, msTime, normaliseSymbol, num, requestJson } from '../http.js';

/**
 * WEEX futures, API V3 (/capi/v3, symbols like BTCUSDT). V2 (/capi/v2, cmt_btcusdt) is retired.
 * Docs: https://www.weex.com/legacy-docs/contract/QuickStart/Signature
 *
 * Signing: base64( HMAC_SHA256(secret, timestamp + METHOD + path + ["?" + query] + body) )
 * Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP (ms), ACCESS-PASSPHRASE
 * V3 success responses have no envelope; errors are {code, msg}.
 */
export class WeexAdapter implements ExchangeAdapter {
  readonly exchange = 'weex' as const;
  private base = 'https://api-contract.weex.com';

  constructor(
    private apiKey: string,
    private secret: string,
    private passphrase: string,
  ) {}

  static sign(secret: string, timestamp: string, method: string, path: string, query: string, body: string) {
    const prehash = timestamp + method.toUpperCase() + path + (query ? '?' + query : '') + body;
    return createHmac('sha256', secret).update(prehash).digest('base64');
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, query = '', body = ''): Promise<T> {
    const ts = Date.now().toString();
    const res = await requestJson(this.exchange, {
      method,
      url: `${this.base}${path}${query ? '?' + query : ''}`,
      headers: {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-SIGN': WeexAdapter.sign(this.secret, ts, method, path, query, body),
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
      body: body || undefined,
    });
    if (res && !Array.isArray(res) && typeof res === 'object' && 'code' in res && 'msg' in res && Number(res.code) !== 0 && Number(res.code) !== 200) {
      throw new ApiError(this.exchange, `${path}: code ${res.code} ${res.msg}`, undefined, res);
    }
    return res as T;
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.call<any[]>('GET', '/capi/v3/account/position/allPosition');
    if (!Array.isArray(data)) throw new ApiError(this.exchange, 'allPosition: unexpected response', undefined, data);
    return data
      .filter((p) => num(p.size) !== 0)
      .map((p) => {
        const size = num(p.size); // base coin
        if (!Number.isFinite(size)) throw new ApiError(this.exchange, `unreadable position size "${p.size}" on ${p.symbol}`);
        const s = String(p.side ?? '').toUpperCase();
        let side: Side;
        if (s === 'LONG') side = 'long';
        else if (s === 'SHORT') side = 'short';
        else throw new ApiError(this.exchange, `unrecognised position side "${p.side}" on ${p.symbol} — not guessing long/short`);
        return {
          symbol: p.symbol,
          key: normaliseSymbol(p.symbol),
          side,
          size: Math.abs(size),
          sizeRaw: String(p.size).replace(/^-/, ''),
          // V3 has no avg price field; openValue / size is the cost basis of what's still open.
          entryPrice: num(p.openValue) / Math.abs(size),
          marginMode: p.marginType,
          positionId: p.id != null && p.id !== '' ? String(p.id) : undefined,
          hedge: true, // V3 always addresses positions by LONG/SHORT side
          openTime: msTime(p.createdTime),
        };
      });
  }

  async getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const q = `symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const rows = await this.call<any[]>('GET', '/capi/v3/market/klines', q);
    if (!Array.isArray(rows)) throw new ApiError(this.exchange, 'klines: unexpected response', undefined, rows);
    // [openTime, open, high, low, close, baseVol, closeTime, ...]. No "final" flag — the engine works that out.
    return rows
      .map((k) => ({ openTime: Number(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]) }))
      .sort((a, b) => a.openTime - b.openTime);
  }

  /**
   * Close by positionId. NEVER call closePositions without an id: an empty body closes every
   * position in the account, and a symbol-only body closes both sides of the pair.
   */
  async closePosition(p: Position): Promise<string> {
    if (!p.positionId || !/^\d+$/.test(p.positionId)) throw new ApiError(this.exchange, `closePositions needs a numeric positionId (${p.symbol})`);
    // Raw number in the JSON so an 18–19 digit id isn't rounded.
    const res = await this.call<any>('POST', '/capi/v3/closePositions', '', `{"positionId":${p.positionId}}`);
    const r = Array.isArray(res) ? res[0] : res;
    if (!r?.success) throw new ApiError(this.exchange, `closePositions did not succeed: ${r?.errorMessage ?? JSON.stringify(res)}`, undefined, res);
    return `closePositions order ${r.successOrderId}`;
  }

  /** Reduce-only market order on the position's side. */
  async closeWithOrder(p: Position): Promise<string> {
    const body = JSON.stringify({
      symbol: p.symbol,
      side: p.side === 'long' ? 'SELL' : 'BUY',
      positionSide: p.side === 'long' ? 'LONG' : 'SHORT',
      type: 'MARKET',
      quantity: p.sizeRaw,
      reduceOnly: true,
      newClientOrderId: `softsl-${Date.now()}`,
    });
    const r = await this.call('POST', '/capi/v3/order', '', body);
    if (r?.success === false) throw new ApiError(this.exchange, `order rejected: ${r.errorCode} ${r.errorMessage}`, undefined, r);
    return `order ${r?.orderId}`;
  }
}
