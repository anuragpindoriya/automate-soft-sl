import { createHmac, randomUUID } from 'node:crypto';
import type { Candle, ExchangeAdapter, Interval, Position, Side } from '../types.js';
import { ApiError, msTime, normaliseSymbol, num, requestJson } from '../http.js';

/**
 * BloFin USDT-M perpetuals.
 * Docs: https://docs.blofin.com/index.html#authentication
 *
 * Signing: prehash = requestPath(+?query) + METHOD + timestamp + nonce + body
 *          sign    = base64( utf8( hex( HMAC_SHA256(secret, prehash) ) ) )   ← base64 of the HEX TEXT
 * Headers: ACCESS-KEY, ACCESS-SIGN, ACCESS-TIMESTAMP (ms), ACCESS-NONCE, ACCESS-PASSPHRASE
 * Envelope: { code: "0", msg, data }. Sizes are in contracts.
 */
export class BlofinAdapter implements ExchangeAdapter {
  readonly exchange = 'blofin' as const;
  private base = 'https://openapi.blofin.com';

  constructor(
    private apiKey: string,
    private secret: string,
    private passphrase: string,
  ) {}

  static sign(secret: string, pathWithQuery: string, method: string, timestamp: string, nonce: string, body: string) {
    const hex = createHmac('sha256', secret).update(pathWithQuery + method.toUpperCase() + timestamp + nonce + body).digest('hex');
    return Buffer.from(hex, 'utf8').toString('base64');
  }

  private async call<T = any>(method: 'GET' | 'POST', path: string, query = '', body?: object): Promise<T> {
    const pathWithQuery = path + (query ? '?' + query : '');
    const bodyStr = body ? JSON.stringify(body) : '';
    const ts = Date.now().toString();
    const nonce = randomUUID();
    const res = await requestJson(this.exchange, {
      method,
      url: this.base + pathWithQuery,
      headers: {
        'ACCESS-KEY': this.apiKey,
        'ACCESS-SIGN': BlofinAdapter.sign(this.secret, pathWithQuery, method, ts, nonce, bodyStr),
        'ACCESS-TIMESTAMP': ts,
        'ACCESS-NONCE': nonce,
        'ACCESS-PASSPHRASE': this.passphrase,
        'Content-Type': 'application/json',
      },
      body: bodyStr || undefined,
    });
    if (String(res.code) !== '0') throw new ApiError(this.exchange, `${path}: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    // Trade endpoints also report per-item results.
    const items = Array.isArray(res.data) ? res.data : [res.data];
    const bad = items.find((d: any) => d && typeof d === 'object' && 'code' in d && String(d.code) !== '0');
    if (bad && path.startsWith('/api/v1/trade/')) throw new ApiError(this.exchange, `${path}: code ${bad.code} ${bad.msg ?? ''}`, undefined, res);
    return res.data as T;
  }

  async getPositions(): Promise<Position[]> {
    const data = await this.call<any[]>('GET', '/api/v1/account/positions');
    return (data ?? [])
      .filter((p) => num(p.positions) !== 0)
      .map((p) => {
        const qty = num(p.positions);
        if (!Number.isFinite(qty)) throw new ApiError(this.exchange, `unreadable position size "${p.positions}" on ${p.instId}`);
        const ps = String(p.positionSide ?? '').toLowerCase(); // long | short | net
        let side: Side;
        if (ps === 'long' || ps === 'short') side = ps;
        else if (ps === 'net') side = qty < 0 ? 'short' : 'long';
        else throw new ApiError(this.exchange, `unrecognised positionSide "${p.positionSide}" on ${p.instId} — not guessing long/short`);
        return {
          symbol: p.instId,
          key: normaliseSymbol(p.instId),
          side,
          size: Math.abs(qty), // contracts
          sizeRaw: String(p.positions).replace(/^-/, ''),
          entryPrice: num(p.averagePrice),
          marginMode: p.marginMode,
          positionId: p.positionId != null && p.positionId !== '' ? String(p.positionId) : undefined,
          hedge: ps !== 'net',
          openTime: msTime(p.createTime),
        };
      });
  }

  async getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]> {
    const bar = interval === '1h' ? '1H' : '1m';
    const q = `instId=${encodeURIComponent(symbol)}&bar=${bar}&limit=${limit}`;
    const res = await requestJson(this.exchange, { method: 'GET', url: `${this.base}/api/v1/market/candles?${q}` });
    if (String(res.code) !== '0') throw new ApiError(this.exchange, `candles: code ${res.code} ${res.msg ?? ''}`, undefined, res);
    // Rows (newest first): [ts, open, high, low, close, vol, volCcy, volQuote, confirm]. confirm "1" = completed.
    return (res.data ?? [])
      .map((k: any[]) => ({
        openTime: Number(k[0]),
        open: num(k[1]),
        high: num(k[2]),
        low: num(k[3]),
        close: num(k[4]),
        closed: String(k[8]) === '1' ? true : String(k[8]) === '0' ? false : undefined,
      }))
      .sort((a: Candle, b: Candle) => a.openTime - b.openTime);
  }

  /** Dedicated endpoint: closes the whole position at market. */
  async closePosition(p: Position): Promise<string> {
    const body: Record<string, string> = {
      instId: p.symbol,
      marginMode: p.marginMode ?? 'cross',
      positionSide: p.hedge ? p.side : 'net',
      clientOrderId: `softsl${Date.now()}`,
    };
    if (p.positionId) body.positionId = p.positionId; // required in Multi-Position mode
    await this.call('POST', '/api/v1/trade/close-position', '', body);
    return 'close-position';
  }

  /** Market order. One-way: reduceOnly. Hedge: positionSide does the job (reduceOnly is ignored there). */
  async closeWithOrder(p: Position): Promise<string> {
    const order: Record<string, string> = {
      instId: p.symbol,
      marginMode: p.marginMode ?? 'cross',
      positionSide: p.hedge ? p.side : 'net',
      side: p.side === 'long' ? 'sell' : 'buy',
      orderType: 'market',
      size: p.sizeRaw,
      clientOrderId: `softsl${Date.now()}`,
    };
    if (!p.hedge) order.reduceOnly = 'true';
    const d = await this.call<any[]>('POST', '/api/v1/trade/order', '', order);
    return `order ${Array.isArray(d) ? d[0]?.orderId : ''}`;
  }
}
