import { log } from './log.js';

export class ApiError extends Error {
  constructor(
    public exchange: string,
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(`[${exchange}] ${message}`);
  }
}

export interface RequestOpts {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** fetch + timeout + JSON parse. Throws ApiError on network/HTTP/parse failure. */
export async function requestJson<T = any>(exchange: string, o: RequestOpts): Promise<T> {
  let res: Response;
  try {
    res = await fetch(o.url, {
      method: o.method,
      headers: o.headers,
      body: o.body,
      signal: AbortSignal.timeout(o.timeoutMs ?? 10_000),
    });
  } catch (e) {
    throw new ApiError(exchange, `network error on ${o.method} ${stripQuery(o.url)}: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? parseJson(text) : {};
  } catch {
    throw new ApiError(exchange, `non-JSON response (HTTP ${res.status}) on ${stripQuery(o.url)}: ${text.slice(0, 200)}`, res.status);
  }
  if (!res.ok) {
    throw new ApiError(exchange, `HTTP ${res.status} on ${stripQuery(o.url)}: ${text.slice(0, 300)}`, res.status, json);
  }
  log.debug(`${exchange} ${o.method} ${stripQuery(o.url)} ->`, json);
  return json as T;
}

/** Retry an async op on failure with linear backoff. */
export async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 3, delayMs = 1500): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < attempts) {
        log.warn(`${label} failed (attempt ${i}/${attempts}), retrying`, e);
        await sleep(delayMs * i);
      }
    }
  }
  throw last;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Build a query string from params, skipping undefined. Keeps insertion order. */
export function qs(params: Record<string, string | number | boolean | undefined>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * Position/order ids can be 18–19 digit integers, which JSON.parse silently rounds
 * (> 2^53). Quote every bare integer of 16+ digits so it survives as an exact string.
 * A small scanner (not a regex) so digits inside string values are never touched.
 */
export function protectBigInts(text: string): string {
  let out = '';
  let last = 0;
  let i = 0;
  const n = text.length;
  const isDigit = (c: number) => c >= 48 && c <= 57;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 34 /* " */) {
      i++;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 /* \ */) i += 2;
        else if (d === 34) {
          i++;
          break;
        } else i++;
      }
      continue;
    }
    if (c === 45 /* - */ || isDigit(c)) {
      const start = i;
      if (c === 45) i++;
      const digitsStart = i;
      while (i < n && isDigit(text.charCodeAt(i))) i++;
      const intEnd = i;
      let integer = true;
      while (i < n && /[0-9.eE+-]/.test(text[i])) {
        integer = false;
        i++;
      }
      if (integer && intEnd - digitsStart >= 16) {
        out += text.slice(last, start) + '"' + text.slice(start, intEnd) + '"';
        last = intEnd;
      }
      continue;
    }
    i++;
  }
  return out + text.slice(last);
}

/** JSON.parse that keeps 16+ digit integers exact (as strings). */
export function parseJson(text: string) {
  // No silent fallback to plain JSON.parse: that would round ids and close the wrong position.
  return JSON.parse(protectBigInts(text));
}

function stripQuery(url: string) {
  const i = url.indexOf('?');
  return i === -1 ? url : url.slice(0, i);
}

/** A timestamp field as ms since epoch (accepts seconds too), or undefined. */
export function msTime(v: unknown): number | undefined {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

export const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
};

/** Normalise any exchange symbol to e.g. "BTCUSDT". */
export function normaliseSymbol(s: string): string {
  return s.toUpperCase().replace(/^CMT_/, '').replace(/[^A-Z0-9]/g, '');
}
