type Level = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';

const debugOn = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

function out(level: Level, msg: string, extra?: unknown) {
  if (level === 'DEBUG' && !debugOn) return;
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}`;
  const tail = extra === undefined ? '' : ' ' + (extra instanceof Error ? extra.message : JSON.stringify(extra));
  (level === 'ERROR' ? console.error : console.log)(line + tail);
}

export const log = {
  info: (m: string, e?: unknown) => out('INFO', m, e),
  warn: (m: string, e?: unknown) => out('WARN', m, e),
  error: (m: string, e?: unknown) => out('ERROR', m, e),
  debug: (m: string, e?: unknown) => out('DEBUG', m, e),
};
