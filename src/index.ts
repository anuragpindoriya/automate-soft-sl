import { env } from './env.js';
import { loadAccounts, loadStops, editStops, fileStateStore, ACCOUNTS_FILE, STOPS_FILE } from './config.js';
import { acquireLock } from './lock.js';
import { createAdapter } from './exchanges/index.js';
import { createNotifier, flushNotifications } from './notify.js';
import { HOUR, SoftSlEngine, type CheckResult } from './engine.js';
import { sleep } from './http.js';
import { log } from './log.js';

const MIN = 60_000;
/** Started this soon after an hourly close: check that close straight away. */
const CATCH_UP_MS = 15 * MIN;

const once = process.argv.includes('--once');
const notify = createNotifier();

/** A startup problem: log it, alert (the daemon may be running unattended under pm2), exit. */
async function refuse(msg: string): Promise<never> {
  log.error(msg);
  if (!once) await notify(`⛔ SoftSL did NOT start: ${msg}`);
  process.exit(1);
}

let releaseLock = () => {};
try {
  releaseLock = acquireLock(`${STOPS_FILE}.lock`);
} catch (e) {
  await refuse((e as Error).message);
}
process.on('exit', () => releaseLock());

let accounts: { name: string; adapter: ReturnType<typeof createAdapter> }[] = [];
try {
  accounts = loadAccounts().map((a) => ({ name: a.name, adapter: createAdapter(a) }));
} catch (e) {
  releaseLock();
  await refuse((e as Error).message);
}

const engine = new SoftSlEngine({
  accounts,
  loadStops: () => loadStops(),
  editStops: (fn) => editStops(fn),
  notify,
  dryRun: env.dryRun,
  removeRuleAfterClose: env.removeRuleAfterClose,
  retriesFailedCloses: !once,
  state: fileStateStore(`${STOPS_FILE}.state`),
});

const delayMs = env.closeDelaySec * 1000;
log.info(`SoftSL starting — ${accounts.length} account(s): ${accounts.map((a) => `${a.name}(${a.adapter.exchange})`).join(', ')}`);
log.info(`accounts: ${ACCOUNTS_FILE} | stops: ${STOPS_FILE} | dry-run: ${env.dryRun} | close delay: ${env.closeDelaySec}s | emergency poll: ${env.hardCheckSec || 'off'}${env.hardCheckSec ? 's' : ''}`);
if (env.dryRun) log.warn('DRY RUN is ON — breaches are logged/alerted but no orders are sent. Set DRY_RUN=false to go live.');
try {
  for (const p of loadStops().problems) log.error(`sl.json: ${p}`);
} catch (e) {
  log.error(`sl.json can't be read: ${(e as Error).message}`);
}

let stopping = false;
const timers = new Set<NodeJS.Timeout>();

async function shutdown(code: number) {
  stopping = true;
  engine.stop();
  for (const t of timers) clearTimeout(t);
  // Let a close that is already in progress finish and be verified before exiting.
  await Promise.race([engine.drain(), sleep(30_000)]);
  await flushNotifications(5000);
  releaseLock();
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (stopping) {
      log.warn(`${sig} again — exiting now`);
      process.exit(1);
    }
    log.info(`${sig} — finishing in-flight work, then stopping`);
    if (!once) void notify('⏹️ SoftSL stopped — positions are NOT protected until it restarts');
    void shutdown(0);
  });
}
process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));

if (once) {
  // Evaluate the most recently closed hourly candle right now, then exit.
  const boundary = Math.floor(Date.now() / HOUR) * HOUR;
  const res = await engine.runHourly(boundary, { final: true });
  console.table(res);
  await shutdown(0);
} else {
  startDaemon();
}

function startDaemon() {
  void notify(`✅ SoftSL started (${accounts.map((a) => a.name).join(', ')})${env.dryRun ? ' — DRY RUN' : ''}`);
  const now = Date.now();
  const thisHour = Math.floor(now / HOUR) * HOUR;
  if (now >= thisHour + delayMs && now - thisHour < CATCH_UP_MS) {
    log.info(`started ${Math.round((now - thisHour) / 1000)}s after the ${iso(thisHour)} close — checking it now`);
    void checkBoundary(thisHour, true);
  }
  scheduleHourly();

  // Every account gets its own tick (and busy flag), so one slow exchange can't hold up the others.
  // Ticks follow positions and retry failed closes; the emergency check runs every HARD_CHECK_SEC.
  const hardMs = env.hardCheckSec * 1000;
  const tickMs = Math.min(30_000, hardMs || 30_000);
  const busy = new Set<string>();
  const lastHard = new Map<string, number>();
  const iv = setInterval(() => {
    if (stopping) return;
    for (const a of accounts) {
      if (busy.has(a.name)) continue;
      const t = Date.now();
      const hardCheck = hardMs > 0 && t - (lastHard.get(a.name) ?? 0) >= hardMs - 1000;
      if (hardCheck) lastHard.set(a.name, t);
      busy.add(a.name);
      engine
        .tick(a.name, { hardCheck })
        .catch((e) => log.error(`${a.name}: tick failed`, e))
        .finally(() => busy.delete(a.name));
    }
  }, tickMs);
  timers.add(iv);
}

/** Schedule the check of the next hourly close (after `after`, if given). */
function scheduleHourly(after?: number) {
  if (stopping) return;
  const now = Date.now();
  const thisHour = Math.floor(now / HOUR) * HOUR;
  let boundary = now < thisHour + delayMs ? thisHour : thisHour + HOUR;
  if (after !== undefined && boundary <= after) boundary = after + HOUR;
  const fireAt = boundary + delayMs;
  log.info(`next hourly check at ${new Date(fireAt).toISOString()}`);
  const t = setTimeout(() => {
    timers.delete(t);
    void onTimer(boundary);
  }, fireAt - now);
  timers.add(t);
}

async function onTimer(expected: number) {
  // Timers run on a monotonic clock. If the wall clock was stepped back, wait until the hour is really over;
  // if we fired late (sleep, suspend), check the latest close rather than a stale one — and say so.
  const due = expected + delayMs;
  if (Date.now() < due) await sleep(due - Date.now());
  const boundary = Math.max(expected, Math.floor(Date.now() / HOUR) * HOUR);
  scheduleHourly(boundary);
  if (boundary !== expected) {
    log.warn(`hourly timer fired late — skipped the ${iso(expected)} close, checking the ${iso(boundary)} close`);
    void notify(`⚠️ SoftSL: the hourly check ran late (was the machine asleep?) — the ${iso(expected)} close was NOT checked; checking the ${iso(boundary)} close now`);
  }
  await checkBoundary(boundary, false);
}

/** Check one hourly close on every account, each on its own retry schedule. */
async function checkBoundary(boundary: number, strict: boolean) {
  await Promise.all(accounts.map((a) => checkAccount(a.name, boundary, strict)));
}

/** Results that a later retry might complete: no candle yet, an empty or failed positions read. */
const incomplete = (res: CheckResult[]) =>
  res.some((r) => r.action === 'no-candle' || r.action === 'no-positions' || (r.action === 'error' && r.symbol === '*'));

async function checkAccount(name: string, boundary: number, strict: boolean) {
  try {
    let res = await engine.runHourly(boundary, { accounts: [name], final: false, strict });
    // Exchanges are often slow right at the top of the hour: try again at +1, +5 and +15 minutes
    // before giving up on this close (and alerting). Retries only look at positions not checked yet.
    for (const min of [1, 5, 15]) {
      if (!incomplete(res) || stopping) return;
      const at = boundary + min * MIN;
      if (Date.now() < at) await sleep(at - Date.now());
      if (stopping) return;
      res = await engine.runHourly(boundary, { accounts: [name], final: min === 15, strict: true });
    }
  } catch (e) {
    log.error(`${name}: hourly run crashed`, e);
    void notify(`⚠️ SoftSL: ${name} hourly run crashed — ${(e as Error).message}`);
  }
}

function iso(ms: number) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}
