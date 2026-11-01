import type { AccountConfig, ExchangeAdapter } from '../types.js';
import { BlofinAdapter } from './blofin.js';
import { BitunixAdapter } from './bitunix.js';
import { BingxAdapter } from './bingx.js';
import { WeexAdapter } from './weex.js';

export function createAdapter(a: AccountConfig): ExchangeAdapter {
  switch (a.exchange) {
    case 'blofin':
      return new BlofinAdapter(a.apiKey, a.apiSecret, a.passphrase!);
    case 'bitunix':
      return new BitunixAdapter(a.apiKey, a.apiSecret);
    case 'bingx':
      return new BingxAdapter(a.apiKey, a.apiSecret);
    case 'weex':
      return new WeexAdapter(a.apiKey, a.apiSecret, a.passphrase!);
  }
}
