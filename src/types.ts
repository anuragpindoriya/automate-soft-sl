export type Side = 'long' | 'short';
export type Interval = '1m' | '1h';
export type ExchangeId = 'blofin' | 'bitunix' | 'bingx' | 'weex';

/** One open position, normalised across exchanges. */
export interface Position {
  /** Symbol exactly as the exchange returns it (used for API calls). */
  symbol: string;
  /** Normalised key used in sl.json, e.g. "BTCUSDT". */
  key: string;
  side: Side;
  /** Absolute size in the exchange's own unit (contracts or coins). */
  size: number;
  /** Size string as returned by the exchange — sent back unchanged when closing. */
  sizeRaw: string;
  /** Average entry price; NaN when the exchange didn't report one. */
  entryPrice: number;
  marginMode?: string;
  /** Exchange position id (kept as an exact string; can exceed 2^53). */
  positionId?: string;
  /** True if the account holds long/short separately (hedge mode). */
  hedge: boolean;
  /** When the position was opened (ms), if the exchange reports it. */
  openTime?: number;
}

export interface Candle {
  /** Candle open time, ms since epoch (UTC). */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * true: the exchange says this candle is final. false: the exchange says it is still forming.
   * undefined: the exchange doesn't say. The engine then only trusts it once a later candle exists.
   */
  closed?: boolean;
}

export interface ExchangeAdapter {
  readonly exchange: ExchangeId;
  getPositions(): Promise<Position[]>;
  /** Most recent candles, sorted oldest → newest. May include the still-forming candle. */
  getCandles(symbol: string, interval: Interval, limit: number): Promise<Candle[]>;
  /**
   * Close the whole position with the exchange's dedicated close-position endpoint.
   * Throws if that endpoint can't be used for this position or the exchange rejects it.
   */
  closePosition(p: Position): Promise<string>;
  /**
   * Fallback: a market order that closes `p.sizeRaw` of this position (reduce-only or
   * position-side targeted). The engine only calls it after re-checking the position still exists.
   */
  closeWithOrder(p: Position): Promise<string>;
}

export interface AccountConfig {
  /** Your label for this account, referenced from sl.json. */
  name: string;
  exchange: ExchangeId;
  apiKey: string;
  apiSecret: string;
  /** Required by BloFin and WEEX. */
  passphrase?: string;
  enabled?: boolean;
}

export interface StopRule {
  account: string;
  /** Normalised symbol, e.g. "BTCUSDT". */
  symbol: string;
  side: Side;
  /** Absolute soft-SL price, checked on the hourly close. */
  sl?: number;
  /** Soft SL as % away from entry (used when sl is not set). */
  slPct?: number;
  /** Optional emergency price, checked intra-hour. Must be beyond the soft SL. */
  hard?: number;
  /** Emergency level as % beyond the soft SL. */
  hardPct?: number;
  /** Position this rule belongs to. Set automatically; a bound rule never applies to another position. */
  positionId?: string;
  note?: string;
  /** Internal: fingerprint of the rule as written in the file (used for safe edits). Not saved. */
  sig?: string;
}

export interface StopsFile {
  /** Applied to positions that have no explicit rule. Leave null to only warn. */
  defaults?: { slPct?: number | null; hardPct?: number | null };
  stops: StopRule[];
}
