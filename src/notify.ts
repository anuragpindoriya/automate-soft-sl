import { log } from './log.js';

export type Notifier = (text: string) => Promise<void>;

const inFlight = new Set<Promise<void>>();

/**
 * Telegram alerts if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are set; otherwise a no-op.
 * Failures to notify are logged but never stop the bot.
 */
export function createNotifier(): Notifier {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return async () => {};

  const send = async (text: string) => {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn(`telegram: HTTP ${res.status}`);
    } catch (e) {
      log.warn('telegram: send failed', e);
    }
  };
  return (text: string) => {
    const p = send(text);
    inFlight.add(p);
    void p.finally(() => inFlight.delete(p));
    return p;
  };
}

/** Wait (up to `ms`) for alerts still being sent, so they aren't lost on exit. */
export async function flushNotifications(ms = 5000): Promise<void> {
  if (!inFlight.size) return;
  await Promise.race([Promise.allSettled([...inFlight]), new Promise((r) => setTimeout(r, ms))]);
}
