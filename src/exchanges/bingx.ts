import { createHmac } from 'node:crypto';
import type { Candle, ExchangeAdapter, Interval, Position, Side } from '../types.js';
import { ApiError, normaliseSymbol, num, requestJson } from '../http.js';

type Params = Record<string, string | number | boolean>;

/**
 * BingX USDT-M perpetual swap.
 * Docs: https://bingx-api.github.io/docs-v3/#/en/Swap  (auth: github.com/bingx-api/api-ai-skills/.../authentication.md)
 *
 * Signing: params sorted by key (ASCII), joined as k=v&k=v WITHOUT url-encoding,
 *          signature = hex( HMAC_SHA256(secret, thatString) ), sent as &signature=.
 * Params (incl. timestamp) go in the query string for GET and POST alike.
 * Header: X-BX-APIKEY.  Envelope: { code: 0, msg, data }.
 */
export class BingxAdapter implements ExchangeAdapter {
  readonly exchange = 'bingx' as const;
  private base = 'https://open-api.bingx.com';

  constructor(
    private apiKey: string,
    private secret: string,
  ) {}

  static canonical(params: Params) {
    return Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  static sign(secret: string, canonical: string) {
    return createHmac('sha256', secret).update(canonical).digest('hex');
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, params: Params = {}): Promise<T> {
    const all: Params = { ...params, timestamp: Date.now(), recvWindow: 5000 };
    const canonical = BingxAdapter.canonical(all);
    const signature = BingxAdapter.sign(this.secret, canonical);
    // Values here are plain symbols/numbers; encode for the URL only (signature is over raw values).
    const urlQuery = Object.keys(all)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(String(all[k]))}`)
      .join('&');
    const res = await requestJson(this.exchange, {
      method,
      url: `${this.base}${path}?${urlQuery}&signature=${signature}`,
      headers: { 'X-BX-APIKEY': this.apiKey },
    });
    if (Number(res.code) !== 0) throw new ApiError(this.exchange, `${path}: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    return res.data as T;
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.call<any[]>('GET', '/openApi/swap/v2/user/positions');
    return (data ?? [])
      .filter((p) => num(p.positionAmt) !== 0)
      .map((p) => {
        const amt = num(p.positionAmt);
        if (!Number.isFinite(amt)) throw new ApiError(this.exchange, `unreadable position size "${p.positionAmt}" on ${p.symbol}`);
        const ps = String(p.positionSide ?? '').toUpperCase();
        let side: Side;
        if (ps === 'LONG') side = 'long';
        else if (ps === 'SHORT') side = 'short';
        else if (ps === 'BOTH') side = amt < 0 ? 'short' : 'long';
        else throw new ApiError(this.exchange, `unrecognised positionSide "${p.positionSide}" on ${p.symbol} — not guessing long/short`);
        return {
          symbol: p.symbol,
          key: normaliseSymbol(p.symbol),
          side,
          size: Math.abs(amt), // base coin
          sizeRaw: String(p.positionAmt).replace(/^-/, ''),
          entryPrice: num(p.avgPrice),
          marginMode: p.isolated ? 'isolated' : 'cross',
          positionId: p.positionId != null && p.positionId !== '' ? String(p.positionId) : undefined,
          // Informational only; one-way accounts can still report LONG/SHORT. Orders ask /positionSide/dual.
          hedge: ps !== 'BOTH',
        };
      });
  }

  async getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const q = `symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`;
    const res = await requestJson(this.exchange, { method: 'GET', url: `${this.base}/openApi/swap/v3/quote/klines?${q}` });
    if (Number(res.code) !== 0) throw new ApiError(this.exchange, `klines: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    // Documented as objects {time, open, high, low, close, volume}; accept array rows too. Order isn't guaranteed,
    // and BingX doesn't say whether the newest candle is final — the engine works that out.
    return (res.data ?? [])
      .map((k: any) =>
        Array.isArray(k)
          ? { openTime: Number(k[0]), open: num(k[1]), high: num(k[2]), low: num(k[3]), close: num(k[4]) }
          : { openTime: Number(k.time), open: num(k.open), high: num(k.high), low: num(k.low), close: num(k.close) },
      )
      .sort((a: Candle, b: Candle) => a.openTime - b.openTime);
  }

  /** Close by positionId at market — works in one-way and hedge mode. */
  async closePosition(p: Position): Promise<string> {
    if (!p.positionId) throw new ApiError(this.exchange, `closePosition needs a positionId (${p.symbol})`);
    const d = await this.call('POST', '/openApi/swap/v1/trade/closePosition', { positionId: p.positionId });
    return `closePosition order ${d?.orderId ?? ''}`;
  }

  /** Market order. Hedge: opposite side + positionSide LONG/SHORT. One-way: opposite side + BOTH + reduceOnly. */
  async closeWithOrder(p: Position): Promise<string> {
    // Asked every time (not cached): the account's mode can be switched while the bot runs.
    const mode = await this.call('GET', '/openApi/swap/v1/positionSide/dual');
    const dual = String(mode?.dualSidePosition) === 'true';
    const params: Params = {
      symbol: p.symbol,
      side: p.side === 'long' ? 'SELL' : 'BUY',
      type: 'MARKET',
      quantity: p.sizeRaw,
      positionSide: dual ? (p.side === 'long' ? 'LONG' : 'SHORT') : 'BOTH',
    };
    if (!dual) params.reduceOnly = 'true';
    const d = await this.call('POST', '/openApi/swap/v2/trade/order', params);
    return `order ${d?.order?.orderId ?? d?.orderId ?? ''}`;
  }
}
