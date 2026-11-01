import { env } from './env.js';
import { loadAccounts, loadStops, editStops, replaceRule, resolveStop, isBreached, checkRule, STOPS_FILE } from './config.js';
import { createAdapter } from './exchanges/index.js';
import { normaliseSymbol, sleep } from './http.js';
import { HOUR, isFinal, samePosition } from './engine.js';
import type { Side } from './types.js';

const [cmd, ...args] = process.argv.slice(2);

const usage = `SoftSL — manage hourly-close stop losses

  probe                                         check public candle feeds on all 4 exchanges (no keys needed)
  status                                        open positions, their SL and the last 1h close
  list                                          rules in sl.json
  set <account> <symbol> <long|short> <price>   [--hard <price>] [--note "..."]
  set <account> <symbol> <long|short> --pct <n> [--hard-pct <n>] [--note "..."]
  rm  <account> <symbol> <long|short>
  close <account> <symbol> <long|short> [--order] --yes
                                                test-close a live position (needs DRY_RUN=false);
                                                --order uses the fallback market order instead

  --hard is an emergency price; --hard-pct is a % beyond the soft SL. Both are checked intra-hour.
  symbol is exchange-agnostic: BTCUSDT, BTC-USDT and cmt_btcusdt are the same.
  Edits take effect at the next check — no restart needed.`;

function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}
function parseSide(s: string | undefined): Side {
  if (s !== 'long' && s !== 'short') throw new Error('side must be "long" or "short"');
  return s;
}
function account(name: string | undefined) {
  const all = loadAccounts();
  const a = all.find((x) => x.name === name);
  if (!a) throw new Error(`unknown account "${name}" (have: ${all.map((x) => x.name).join(', ')})`);
  return a;
}
const r8 = (n: number) => Number(n.toPrecision(8));

/** Public endpoints only (no keys): checks each exchange returns the last closed 1h candle. */
async function probe() {
  const boundary = Math.floor(Date.now() / HOUR) * HOUR;
  const targets = [
    { ex: 'blofin', sym: 'BTC-USDT' },
    { ex: 'bitunix', sym: 'BTCUSDT' },
    { ex: 'bingx', sym: 'BTC-USDT' },
    { ex: 'weex', sym: 'BTCUSDT' },
  ] as const;
  const rows = [];
  for (const t of targets) {
    const ad = createAdapter({ name: t.ex, exchange: t.ex, apiKey: 'x', apiSecret: 'x', passphrase: 'x' });
    try {
      const cs = await ad.getCandles(t.sym, '1h', 5);
      const hit = cs.find((c) => c.openTime === boundary - HOUR);
      // The candle of the hour in progress must never be flagged final (Bitunix documents closed-only candles).
      const formingFlaggedFinal = cs.some((c) => c.openTime >= boundary && c.closed === true);
      rows.push({
        exchange: t.ex,
        candles: cs.map((c) => new Date(c.openTime).toISOString().slice(11, 16)).join(' '),
        lastClosed: hit ? `${new Date(hit.openTime).toISOString().slice(11, 16)}Z close ${hit.close}` : 'NOT FOUND',
        final: hit ? (isFinal(hit, cs, boundary, Date.now()) ? 'yes' : 'not yet') : '',
        check: formingFlaggedFinal ? 'PROBLEM: the hour in progress is marked final — do not go live' : 'ok',
      });
    } catch (e) {
      rows.push({ exchange: t.ex, candles: 'ERROR', lastClosed: (e as Error).message.slice(0, 100) });
    }
  }
  console.table(rows);
}

async function status() {
  const accounts = loadAccounts();
  const { file: stops, problems } = loadStops();
  for (const p of problems) console.warn(`sl.json: ${p}`);
  const lastClosedOpen = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const rows: Record<string, unknown>[] = [];
  for (const a of accounts) {
    const ad = createAdapter(a);
    try {
      const positions = await ad.getPositions();
      if (!positions.length) rows.push({ account: a.name, symbol: '—', side: '', note: 'no positions' });
      for (const p of positions) {
        const st = resolveStop(stops, a.name, p);
        let close: number | undefined;
        try {
          close = (await ad.getCandles(p.symbol, '1h', 5)).find((c) => c.openTime === lastClosedOpen)?.close;
        } catch {}
        const ok = st.kind === 'ok' ? st : undefined;
        rows.push({
          account: a.name,
          symbol: p.key,
          side: p.side,
          size: p.sizeRaw,
          entry: p.entryPrice,
          softSL: ok ? r8(ok.sl) : st.kind === 'error' ? 'ERROR' : 'NONE',
          hard: ok?.hard ? r8(ok.hard) : '',
          lastHourClose: close ?? '?',
          state: !ok ? (st.kind === 'error' ? 'ERROR' : 'UNPROTECTED') : close === undefined ? '?' : isBreached(p.side, close, ok.sl) ? 'BREACHED' : 'ok',
          via: ok?.rule ? (ok.rule.positionId ? 'rule (tied)' : 'rule') : ok ? 'default %' : '',
          note: st.kind === 'error' ? st.message : ok?.warning ?? '',
        });
      }
    } catch (e) {
      rows.push({ account: a.name, symbol: 'ERROR', note: (e as Error).message.slice(0, 120) });
    }
  }
  console.table(rows);
}

function list() {
  const { file, problems } = loadStops();
  const d = file.defaults ?? {};
  console.log(`${STOPS_FILE}\ndefaults: slPct ${d.slPct ?? 'none'}, hardPct ${d.hardPct ?? 'none'}`);
  for (const p of problems) console.warn(`problem: ${p}`);
  console.table(file.stops.map(({ sig, ...r }) => r));
}

async function set() {
  const [accName, sym, sideArg, priceArg] = args;
  if (!accName || !sym) throw new Error(usage);
  const side = parseSide(sideArg);
  const acc = account(accName);

  const raw: Record<string, unknown> = { account: accName, symbol: normaliseSymbol(sym), side };
  const num = (v: string | undefined) => (v === undefined ? undefined : Number(v));
  if (flag('pct') !== undefined) raw.slPct = num(flag('pct'));
  else if (priceArg && !priceArg.startsWith('--')) raw.sl = num(priceArg);
  if (flag('hard') !== undefined) raw.hard = num(flag('hard'));
  if (flag('hard-pct') !== undefined) raw.hardPct = num(flag('hard-pct'));
  if (flag('note') !== undefined) raw.note = flag('note');
  // Same validation the bot uses; for a new rule every problem is an error.
  const { rule, problems } = checkRule(raw);
  if (!rule || problems.length) throw new Error(`not saved: ${problems.join('; ').replace(/ — .*?(;|$)/g, '$1')}`);

  // Tie the rule to the open position, so it never carries over to a later trade.
  if (env.removeRuleAfterClose) {
    try {
      const matches = (await createAdapter(acc).getPositions()).filter((p) => p.key === rule.symbol && p.side === side);
      if (matches.length === 1 && matches[0].positionId) {
        const p = matches[0];
        raw.positionId = p.positionId;
        const st = resolveStop({ stops: [{ ...rule, positionId: p.positionId }] }, accName, p);
        console.log(`tied to the open position (id ${p.positionId}, size ${p.sizeRaw}, entry ${p.entryPrice})`);
        if (st.kind === 'ok') console.log(`soft SL ${r8(st.sl)}${st.hard ? `, emergency ${r8(st.hard)}` : ''}${st.warning ? `\nwarning: ${st.warning}` : ''}`);
      } else if (matches.length === 0) {
        console.log(`no open ${rule.symbol} ${side} position yet — the rule will apply to the next one you open`);
      } else {
        console.log(`${matches.length} open ${rule.symbol} ${side} positions — the rule applies to all of them`);
      }
    } catch (e) {
      console.warn(`couldn't check open positions (${(e as Error).message.slice(0, 120)}) — saved without tying it to a position`);
    }
  }

  let replaced = 0;
  editStops((file) => {
    replaced = replaceRule(file, raw);
    return true;
  });
  console.log(`saved: ${JSON.stringify(raw)}${replaced ? ` (replaced ${replaced} earlier rule${replaced > 1 ? 's' : ''})` : ''}`);
}

function rm() {
  const [accName, sym, sideArg] = args;
  if (!accName || !sym) throw new Error(usage);
  const side = parseSide(sideArg);
  const key = normaliseSymbol(sym);
  let n = 0;
  editStops((file) => {
    const before = file.stops!.length;
    file.stops = file.stops!.filter((r: any) => !(r?.account === accName && normaliseSymbol(String(r?.symbol ?? '')) === key && r?.side === side));
    n = before - file.stops.length;
    return n > 0;
  });
  console.log(n ? `removed ${n} rule(s)` : 'no matching rule');
}

/** Close one live position by hand — the way to test each exchange's close paths on a tiny position. */
async function close() {
  const [accName, sym, sideArg] = args;
  if (!accName || !sym) throw new Error(usage);
  const side = parseSide(sideArg);
  const ad = createAdapter(account(accName));
  const viaOrder = args.includes('--order');
  const matches = (await ad.getPositions()).filter((p) => p.key === normaliseSymbol(sym) && p.side === side);
  if (!matches.length) throw new Error(`no open ${normaliseSymbol(sym)} ${side} position on ${accName}`);
  if (matches.length > 1) throw new Error(`${matches.length} matching positions — this command only handles one`);
  const p = matches[0];
  const how = viaOrder ? 'the fallback market order' : 'the close-position endpoint';
  console.log(`${accName} ${p.symbol} ${p.side} size ${p.sizeRaw} entry ${p.entryPrice} id ${p.positionId ?? '—'}`);
  if (env.dryRun) return console.log(`DRY_RUN is on — nothing sent. Would close it with ${how}. Run with DRY_RUN=false to send it.`);
  if (!args.includes('--yes')) return console.log(`add --yes to close it now with ${how}`);

  const ref = viaOrder ? await ad.closeWithOrder(p) : await ad.closePosition(p);
  console.log(`sent: ${ref}`);
  await sleep(2000);
  const after = await ad.getPositions();
  const still = after.find((q) => samePosition(q, p));
  if (still && still.size > p.size) console.log(`⚠️  the position GREW to ${still.sizeRaw} — this close method is wrong for this account. Close it by hand and don't go live.`);
  else console.log(still ? `still open: size ${still.sizeRaw}` : 'closed ✔');
  const fresh = after.filter((q) => q.key === p.key && !samePosition(q, p));
  if (fresh.length) console.log(`note: other ${p.key} positions are open: ${fresh.map((q) => `${q.side} ${q.sizeRaw}`).join(', ')} — check none was opened by this order`);
}

try {
  if (cmd === 'probe') await probe();
  else if (cmd === 'status') await status();
  else if (cmd === 'list') list();
  else if (cmd === 'set') await set();
  else if (cmd === 'rm') rm();
  else if (cmd === 'close') await close();
  else console.log(usage);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
