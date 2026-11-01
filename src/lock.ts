import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { uptime } from 'node:os';

/** Approximate time the machine booted (ms). Changes after a reboot, so old locks can be recognised. */
const bootTime = () => Date.now() - uptime() * 1000;

/**
 * One SoftSL process per sl.json: two would both send closes. Returns a release function.
 * A lock left behind by a crash, a kill or a reboot is taken over: its pid must still be running,
 * on this boot, and be a node process, or the lock is stale.
 */
export function acquireLock(path: string): () => void {
  const me = JSON.stringify({ pid: process.pid, boot: Math.round(bootTime()) });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, me, { flag: 'wx' });
      return () => {
        try {
          if (readFileSync(path, 'utf8') === me) unlinkSync(path);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = readHolder(path);
    if (holder && isLive(holder)) {
      throw new Error(`another SoftSL process (pid ${holder.pid}) is already running with this sl.json. Stop it first, or delete ${path} if that pid isn't SoftSL.`);
    }
    // Stale: remove it and try to create ours again (if another process wins that race, we see it as live).
    try {
      unlinkSync(path);
    } catch {
      /* someone else removed it */
    }
  }
  throw new Error(`couldn't take the lock ${path}`);
}

function readHolder(path: string): { pid: number; boot?: number } | undefined {
  let text: string;
  try {
    text = readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
  try {
    const j = JSON.parse(text);
    if (typeof j === 'number') return { pid: j };
    return { pid: Number(j?.pid), boot: typeof j?.boot === 'number' ? j.boot : undefined };
  } catch {
    return { pid: Number(text) };
  }
}

function isLive({ pid, boot }: { pid: number; boot?: number }): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  if (boot !== undefined && Math.abs(boot - bootTime()) > 120_000) return false; // written before a reboot
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  // On Linux, make sure the pid is a node process — after a crash it may now belong to something else.
  try {
    const cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return /node/i.test(cmd);
  } catch {
    return true; // no /proc (macOS, Windows): can't tell, assume it is SoftSL
  }
}
