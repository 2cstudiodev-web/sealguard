// Telegram: the guard's alert channel. Each user links their own chat by opening the bot with a one-time code.
import { webhookSecret } from "./auth";

export const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] as string));

export async function sendTelegram(botToken: string, chatId: string, html: string, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<boolean> {
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Points the bot's webhook at us, once per bot token (the caller remembers it in the meta table). */
export async function setWebhook(botToken: string, url: string, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<boolean> {
  try {
    const r = await fetchFn(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, secret_token: webhookSecret(botToken), allowed_updates: ["message"] }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** The /start payload from an update, or null when the message is anything else. */
export function startCode(update: any): { chatId: string; code: string } | null {
  const msg = update?.message;
  const chatId = String(msg?.chat?.id ?? "");
  const text: string = typeof msg?.text === "string" ? msg.text.trim() : "";
  const m = /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{6,64})$/.exec(text);
  if (!chatId || !m) return null;
  return { chatId, code: m[1] };
}
