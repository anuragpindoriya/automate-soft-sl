import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join } from 'node:path';
import { parseStops, replaceRule, type RawStops } from '../src/config.js';
import { acquireLock } from '../src/lock.js';

test('a missing or misspelled "stops" list is reported, not silently empty', () => {
  const { file, problems } = parseStops({ defaults: {}, stop: [{ account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 1 }] } as RawStops);
  assert.equal(file.stops.length, 0);
  assert.match(problems[0], /no "stops" list found \(found "stop" — a typo\?\)/);
});

test('duplicate rules for the same position are reported; the first one is used', () => {
  const { file, problems } = parseStops({
    stops: [
      { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 90 },
      { account: 'a', symbol: 'BTC-USDT', side: 'long', sl: 80 },
      { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 70, positionId: '5' },
    ],
  });
  assert.deepEqual(file.stops.map((r) => r.sl), [90, 70]);
  assert.match(problems[0], /stops\[1\].*duplicate/);
});

test('replaceRule: a rule for one position leaves the rules of other positions alone', () => {
  const raw: RawStops = {
    stops: [
      { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 90, positionId: '111' },
      { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 80, positionId: '222' },
      { account: 'a', symbol: 'BTCUSDT', side: 'short', sl: 120 },
    ],
  };
  assert.equal(replaceRule(raw, { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 85, positionId: '222' }), 1);
  assert.deepEqual(raw.stops!.map((r) => [r.side, r.sl, r.positionId]), [['long', 90, '111'], ['short', 120, undefined], ['long', 85, '222']]);
  // An untied rule (positions couldn't be checked) replaces every rule for that symbol + side.
  assert.equal(replaceRule(raw, { account: 'a', symbol: 'BTCUSDT', side: 'long', sl: 70 }), 2);
  assert.deepEqual(raw.stops!.map((r) => [r.side, r.sl]), [['short', 120], ['long', 70]]);
});

// ── the single-instance lock ────────────────────────────────────────────────

const dir = mkdtempSync(join(tmpdir(), 'softsl-lock-'));

/** Start a child process and wait until it is really running. */
async function start(cmd: string, args: string[]): Promise<ChildProcess> {
  const child = spawn(cmd, args, { stdio: 'ignore' });
  await new Promise((r) => child.once('spawn', r));
  await new Promise((r) => setTimeout(r, 50));
  return child;
}

test('lock: a second instance is refused while the first runs', async () => {
  const path = join(dir, 'a.lock');
  const release = acquireLock(path);
  assert.ok(existsSync(path));
  release();
  assert.ok(!existsSync(path), 'released on exit');
  const node = await start(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  try {
    writeFileSync(path, JSON.stringify({ pid: node.pid, boot: Date.now() - uptime() * 1000 }));
    assert.throws(() => acquireLock(path), /already running/);
  } finally {
    node.kill();
  }
});

test('lock: a lock whose pid now belongs to a non-node process is taken over', async () => {
  const path = join(dir, 'b.lock');
  const other = await start('sleep', ['20']);
  try {
    writeFileSync(path, JSON.stringify({ pid: other.pid }));
    acquireLock(path)();
    assert.ok(!existsSync(path));
  } finally {
    other.kill();
  }
});

test('lock: a lock written before a reboot is taken over, even if its pid is a live node process', async () => {
  const path = join(dir, 'c.lock');
  const node = await start(process.execPath, ['-e', 'setTimeout(() => {}, 20000)']);
  try {
    writeFileSync(path, JSON.stringify({ pid: node.pid, boot: Date.now() - 365 * 24 * 3600_000 }));
    acquireLock(path)();
  } finally {
    node.kill();
  }
});

test('lock: a lock left by a dead pid (old plain-number format) is taken over', () => {
  const path = join(dir, 'd.lock');
  writeFileSync(path, '999999');
  acquireLock(path)();
});
