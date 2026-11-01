// Load .env if present (Node ≥ 20.12). Import this first. Variables already set in the shell win.
try {
  process.loadEnvFile?.('.env');
} catch {
  /* no .env — fine */
}

const truthy = (v?: string) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

/**
 * Live trading only when DRY_RUN is explicitly false/0/no/off. Unset, empty, a typo or
 * anything else keeps dry-run on, so a config mistake never sends real orders.
 */
export function parseDryRun(v: string | undefined): boolean {
  return !['false', '0', 'no', 'off'].includes((v ?? '').trim().toLowerCase());
}

/** Whole number from the environment, or a clear startup error. */
export function intEnv(name: string, fallback: number, min: number, max: number, allowZero = false): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || ((n < min || n > max) && !(allowZero && n === 0))) {
    throw new Error(`${name}=${raw} is invalid: use a whole number from ${min} to ${max}${allowZero ? ' (or 0 to turn it off)' : ''}`);
  }
  return n;
}

function load() {
  try {
    return {
      /** Default ON so a fresh install never sends a real order until you flip it. */
      dryRun: parseDryRun(process.env.DRY_RUN),
      /** Seconds after the hour before checking, so the exchange has finalised the candle. */
      closeDelaySec: intEnv('CLOSE_DELAY_SEC', 5, 1, 300),
      /** Emergency (hard level) poll interval; 0 disables the emergency loop. */
      hardCheckSec: intEnv('HARD_CHECK_SEC', 30, 10, 3600, true),
      /** Rules are tied to their position and removed once it is gone, unless KEEP_RULES_AFTER_CLOSE is set. */
      removeRuleAfterClose: !truthy(process.env.KEEP_RULES_AFTER_CLOSE),
    };
  } catch (e) {
    console.error(`config error: ${(e as Error).message}`);
    process.exit(1);
  }
}

export const env = load();
