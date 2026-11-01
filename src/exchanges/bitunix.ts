import { createHash, randomBytes } from 'node:crypto';
import type { Candle, ExchangeAdapter, Interval, Position, Side } from '../types.js';
import { ApiError, msTime, normaliseSymbol, num, requestJson } from '../http.js';

/**
 * Bitunix USDT-M futures.
 * Docs: https://www.bitunix.com/api-docs/futures/common/sign.html
 *
 * Signing: digest = SHA256(nonce + timestamp + apiKey + queryParams + body)
 *          sign   = SHA256(digest + secret)        (both lowercase hex)
 * queryParams = keys sorted ASCII ascending, each key joined directly to its value ("limit3symbolBTCUSDT").
 * body = compact JSON, byte-identical to what is sent.
 */
export class BitunixAdapter implements ExchangeAdapter {
  readonly exchange = 'bitunix' as const;
  private base = 'https://fapi.bitunix.com';

  constructor(
    private apiKey: string,
    private secret: string,
  ) {}

  static sign(nonce: string, timestamp: string, apiKey: string, queryParams: string, body: string, secret: string) {
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    return sha(sha(nonce + timestamp + apiKey + queryParams + body) + secret);
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, params: Record<string, string | number> = {}, body?: object): Promise<T> {
    const keys = Object.keys(params).sort();
    const signQuery = keys.map((k) => `${k}${params[k]}`).join('');
    const urlQuery = keys.map((k) => `${k}=${encodeURIComponent(String(params[k]))}`).join('&');
    const bodyStr = body ? JSON.stringify(body) : '';
    const nonce = randomBytes(16).toString('hex'); // 32 chars, docs require < 64
    const timestamp = Date.now().toString();
    const sign = BitunixAdapter.sign(nonce, timestamp, this.apiKey, signQuery, bodyStr, this.secret);

    const res = await requestJson(this.exchange, {
      method,
      url: `${this.base}${path}${urlQuery ? '?' + urlQuery : ''}`,
      headers: { 'api-key': this.apiKey, nonce, timestamp, sign, 'Content-Type': 'application/json', language: 'en-US' },
      body: bodyStr || undefined,
    });
    // Errors come back as HTTP 200 with a non-zero code.
    if (res.code !== 0) throw new ApiError(this.exchange, `${path}: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    return res.data as T;
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.call<any[]>('GET', '/api/v1/futures/position/get_pending_positions');
    return (data ?? [])
      .filter((p) => num(p.qty) !== 0)
      .map((p) => {
        const qty = num(p.qty);
        if (!Number.isFinite(qty)) throw new ApiError(this.exchange, `unreadable position size "${p.qty}" on ${p.symbol}`);
        const s = String(p.side ?? '').toUpperCase();
        let side: Side;
        if (s === 'LONG' || s === 'BUY') side = 'long';
        else if (s === 'SHORT' || s === 'SELL') side = 'short';
        else throw new ApiError(this.exchange, `unrecognised position side "${p.side}" on ${p.symbol} — not guessing long/short`);
        return {
          symbol: p.symbol,
          key: normaliseSymbol(p.symbol),
          side,
          size: Math.abs(qty), // base coin
          sizeRaw: String(p.qty).replace(/^-/, ''),
          entryPrice: num(p.avgOpenPrice),
          marginMode: p.marginMode,
          positionId: p.positionId != null && p.positionId !== '' ? String(p.positionId) : undefined,
          hedge: p.positionMode === 'HEDGE',
          openTime: msTime(p.ctime),
        };
      });
  }

  /** Bitunix documents that only CLOSED candles are returned; the forming candle is never included. */
  async getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const q = `symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}&type=LAST_PRICE`;
    const res = await requestJson(this.exchange, { method: 'GET', url: `${this.base}/api/v1/futures/market/kline?${q}` });
    if (res.code !== 0) throw new ApiError(this.exchange, `kline: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    return (res.data ?? [])
      .map((k: any) => ({ openTime: Number(k.time), open: num(k.open), high: num(k.high), low: num(k.low), close: num(k.close), closed: true }))
      .sort((a: Candle, b: Candle) => a.openTime - b.openTime);
  }

  /** Flash close by positionId — closes the whole position at market, in one-way and hedge mode. */
  async closePosition(p: Position): Promise<string> {
    if (!p.positionId) throw new ApiError(this.exchange, `flash close needs a positionId (${p.symbol})`);
    const d = await this.call('POST', '/api/v1/futures/trade/flash_close_position', {}, { positionId: p.positionId });
    return `flash_close ${d?.positionId ?? p.positionId}`;
  }

  /**
   * Market order with tradeSide CLOSE on this positionId, so it can only close that position.
   * Bitunix quirk: `side` names the position being closed (close long → BUY), per the docs.
   * One-way accounts take the same shape (field reports); without tradeSide they reject the order.
   */
  async closeWithOrder(p: Position): Promise<string> {
    if (!p.positionId) throw new ApiError(this.exchange, `a CLOSE order needs a positionId (${p.symbol})`);
    const d = await this.call('POST', '/api/v1/futures/trade/place_order', {}, {
      symbol: p.symbol,
      qty: p.sizeRaw,
      side: p.side === 'long' ? 'BUY' : 'SELL',
      tradeSide: 'CLOSE',
      positionId: p.positionId,
      orderType: 'MARKET',
    });
    return `order ${d?.orderId}`;
  }
}
