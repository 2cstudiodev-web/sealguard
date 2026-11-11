// The guard: sign in, link Telegram, pay for a year, and the cron that re-scans every watched wallet and
// messages the owner when something changed for the worse.
import { fetchScanInput, rpcOver } from "../shared/chain";
import { diffWatch, formatAlerts, watchState, type WatchState } from "../shared/watch";
import { bearer, checkSignIn, issueToken, makeNonce, siwsMessage, verifyToken, webhookSecret } from "./auth";
import { buildQuotes, extendPaidUntil, GUARD_USD, jupiterPrices, PAY_SLACK_MS, PAY_TOKENS, QUOTE_TTL_MS, SKR_MINT, verifyPaymentTx, WSOL_MINT, type ParsedTx, type PayToken } from "./pay";
import { esc, sendTelegram, setWebhook, startCode } from "./telegram";

export interface GuardEnv {
  DB: D1Database;
  RPC_URL: string;
  SESSION_SECRET: string;
  TREASURY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  PUBLIC_URL?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) { super(message ?? code); }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const isWallet = (s: unknown): s is string => typeof s === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
const LINK_CODE_TTL_MS = 30 * 60 * 1000;
/** Guards re-scanned per cron run, oldest check first. 10-minute cron → each of 180 guards is seen hourly. */
export const CHECKS_PER_RUN = 30;
export const CHECK_INTERVAL_MS = 55 * 60 * 1000;

async function readJson(request: Request): Promise<any> {
  try { return await request.json(); } catch { return {}; }
}

function randomCode(len = 24): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

type GuardRow = { wallet: string; created_at: number; paid_until: number | null; telegram_chat_id: string | null; link_code: string | null; link_code_expires: number | null; baseline: string | null; last_check_at: number | null; last_alert_at: number | null; checks: number; alerts: number; last_error: string | null };

function requireWallet(env: GuardEnv, request: Request, now: number): string {
  const t = bearer(request);
  const w = t ? verifyToken(env.SESSION_SECRET, t, now) : null;
  if (!w) throw new ApiError(401, "unauthorized", "Sign in again");
  return w;
}

async function guardRow(env: GuardEnv, wallet: string): Promise<GuardRow | null> {
  return env.DB.prepare("SELECT * FROM guards WHERE wallet = ?").bind(wallet).first<GuardRow>();
}

function status(env: GuardEnv, g: GuardRow | null, now: number) {
  const active = Boolean(g?.paid_until && g.paid_until > now);
  return {
    wallet: g?.wallet ?? null,
    active,
    paidUntil: g?.paid_until ?? null,
    telegramLinked: Boolean(g?.telegram_chat_id),
    botUsername: env.TELEGRAM_BOT_USERNAME ?? null,
    lastCheckAt: g?.last_check_at ?? null,
    checks: g?.checks ?? 0,
    alerts: g?.alerts ?? 0,
    priceUsd: GUARD_USD,
  };
}

/** Routes under /api/. Returns null for paths it doesn't own. */
export async function handleApi(request: Request, env: GuardEnv, path: string, now: number): Promise<Response | null> {
  try {
    if (!env.SESSION_SECRET) throw new ApiError(503, "not_configured", "The guard isn't set up on this deployment yet");
    const method = request.method;

    if (path === "/api/auth/nonce" && method === "POST") {
      const { wallet } = await readJson(request);
      if (!isWallet(wallet)) throw new ApiError(400, "bad_wallet");
      const nonce = makeNonce(env.SESSION_SECRET, wallet, now);
      const issuedAt = new Date(now).toISOString();
      return json({ nonce, issuedAt, message: siwsMessage(wallet, nonce, issuedAt) });
    }
    if (path === "/api/auth/verify" && method === "POST") {
      const b = await readJson(request);
      if (!isWallet(b.wallet) || typeof b.nonce !== "string" || typeof b.issuedAt !== "string" || typeof b.signature !== "string") throw new ApiError(400, "bad_request");
      const r = await checkSignIn(env.SESSION_SECRET, { wallet: b.wallet, nonce: b.nonce, issuedAt: b.issuedAt, signature: b.signature }, now);
      if (!r.ok) throw new ApiError(401, r.reason);
      await env.DB.prepare("INSERT INTO guards (wallet, created_at) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING").bind(r.wallet, now).run();
      return json({ token: issueToken(env.SESSION_SECRET, r.wallet, now), wallet: r.wallet });
    }

    if (path === "/api/guard" && method === "GET") {
      const wallet = requireWallet(env, request, now);
      return json(status(env, await guardRow(env, wallet), now));
    }

    // A one-time code the user hands to the bot: https://t.me/<bot>?start=<code>
    if (path === "/api/guard/link" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME) throw new ApiError(503, "no_telegram", "Telegram alerts aren't configured yet");
      const code = randomCode();
      await env.DB.prepare("UPDATE guards SET link_code = ?, link_code_expires = ? WHERE wallet = ?").bind(code, now + LINK_CODE_TTL_MS, wallet).run();
      return json({ code, url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresAt: now + LINK_CODE_TTL_MS });
    }
    if (path === "/api/guard/unlink" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      await env.DB.prepare("UPDATE guards SET telegram_chat_id = NULL WHERE wallet = ?").bind(wallet).run();
      return json({ ok: true });
    }

    if (path === "/api/guard/quote" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      if (!env.TREASURY) throw new ApiError(503, "no_treasury");
      const prices = await jupiterPrices([WSOL_MINT, SKR_MINT]);
      const quotes = buildQuotes(GUARD_USD, prices);
      const id = randomCode(16);
      const memo = `sealguard:guard:${id}`;
      const expiresAt = now + QUOTE_TTL_MS;
      await env.DB.batch(quotes.map((q) => env.DB.prepare("INSERT INTO quotes (id, token, wallet, base_units, display, usd, memo, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, q.token, wallet, q.baseUnits, q.display, GUARD_USD.toFixed(2), memo, expiresAt)));
      return json({ quoteId: id, usd: GUARD_USD.toFixed(2), memo, expiresAt, now, quotes, treasury: env.TREASURY });
    }

    if (path === "/api/guard/pay" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      const b = await readJson(request);
      const token = String(b.token ?? "") as PayToken;
      const quoteId = String(b.quoteId ?? "");
      const signature = String(b.signature ?? "");
      if (!quoteId || !PAY_TOKENS.includes(token) || !/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) throw new ApiError(400, "bad_payment", "payment needs quoteId, token and the transaction signature");
      if (await env.DB.prepare("SELECT signature FROM payments WHERE signature = ?").bind(signature).first()) throw new ApiError(409, "already_used", "That transaction was already counted");
      const q = await env.DB.prepare("SELECT * FROM quotes WHERE id = ? AND token = ? AND wallet = ?").bind(quoteId, token, wallet).first<{ base_units: string; memo: string; expires_at: number; used: number; usd: string }>();
      if (!q) throw new ApiError(400, "bad_quote");
      if (q.used) throw new ApiError(409, "quote_used");
      if (q.expires_at + PAY_SLACK_MS < now) throw new ApiError(400, "quote_expired", "Ask for a new price and pay again");
      const rpc = rpcOver(env.RPC_URL, 20_000);
      let tx: ParsedTx | null = null;
      try {
        tx = (await rpc<ParsedTx | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) ?? null;
      } catch (e: any) {
        // A malformed signature is the caller's mistake; a provider hiccup is retried by the page.
        if (/invalid/i.test(String(e?.message))) throw new ApiError(400, "bad_signature", "That isn't a transaction signature");
        throw new ApiError(503, "chain_busy", "Solana lookups are busy; try again in a few seconds");
      }
      const check = verifyPaymentTx(tx, { payer: wallet, treasury: env.TREASURY, token, baseUnits: BigInt(q.base_units), memo: q.memo, paidBy: q.expires_at + PAY_SLACK_MS });
      if (!check.ok) throw new ApiError(check.reason === "not_found" ? 404 : 400, check.reason);
      const g = await guardRow(env, wallet);
      const paidUntil = extendPaidUntil(g?.paid_until ?? null, now);
      // The baseline is the wallet as it is right now: the guard reports changes from here on.
      let baseline: string | null = g?.baseline ?? null;
      try { baseline = JSON.stringify(watchState(await fetchScanInput(rpc, wallet))); } catch { /* the first cron run fills it in */ }
      await env.DB.batch([
        env.DB.prepare("UPDATE quotes SET used = 1 WHERE id = ?").bind(quoteId),
        env.DB.prepare("INSERT INTO payments (signature, wallet, quote_id, token, base_units, usd, paid_at, paid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(signature, wallet, quoteId, token, q.base_units, q.usd, now, paidUntil),
        env.DB.prepare("UPDATE guards SET paid_until = ?, baseline = COALESCE(?, baseline), last_error = NULL WHERE wallet = ?").bind(paidUntil, baseline, wallet),
      ]);
      return json({ ok: true, paidUntil });
    }

    // Telegram → us. The secret header proves it's Telegram; /start <code> links a chat to a wallet.
    if (path === "/api/telegram" && method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || request.headers.get("x-telegram-bot-api-secret-token") !== webhookSecret(env.TELEGRAM_BOT_TOKEN)) return new Response("forbidden", { status: 403 });
      const update = await readJson(request);
      const s = startCode(update);
      if (s) {
        const g = await env.DB.prepare("SELECT wallet, link_code_expires FROM guards WHERE link_code = ?").bind(s.code).first<{ wallet: string; link_code_expires: number }>();
        if (g && g.link_code_expires > now) {
          await env.DB.prepare("UPDATE guards SET telegram_chat_id = ?, link_code = NULL, link_code_expires = NULL WHERE wallet = ?").bind(s.chatId, g.wallet).run();
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, s.chatId, `✅ Linked to wallet <code>${esc(g.wallet)}</code>. SealGuard will message you here when something in that wallet changes for the worse.`);
        } else {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, s.chatId, "That link code is unknown or has expired. Open https://guard.2cstudio.app, sign in and press Link Telegram again.");
        }
      } else if (update?.message?.chat?.id) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, String(update.message.chat.id), "This bot only sends SealGuard alerts. Link it from https://guard.2cstudio.app.");
      }
      return new Response("ok");
    }
    return null;
  } catch (e: any) {
    if (e instanceof ApiError) return json({ error: e.code, message: e.message }, e.status);
    console.error("api", e);
    return json({ error: "internal", message: "Something went wrong" }, 500);
  }
}

/** The cron: make sure the webhook is set, then re-scan the guards whose turn it is. */
export async function runGuards(env: GuardEnv, now: number, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<{ checked: number; alerted: number }> {
  if (env.TELEGRAM_BOT_TOKEN && env.PUBLIC_URL) {
    const want = webhookSecret(env.TELEGRAM_BOT_TOKEN) + "@" + env.PUBLIC_URL;
    const have = await env.DB.prepare("SELECT v FROM meta WHERE k = 'webhook'").first<{ v: string }>();
    if (have?.v !== want && (await setWebhook(env.TELEGRAM_BOT_TOKEN, `${env.PUBLIC_URL}/api/telegram`, fetchFn))) {
      await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('webhook', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(want).run();
    }
  }
  const due = (await env.DB.prepare("SELECT * FROM guards WHERE paid_until > ? AND telegram_chat_id IS NOT NULL AND (last_check_at IS NULL OR last_check_at < ?) ORDER BY last_check_at ASC LIMIT ?")
    .bind(now, now - CHECK_INTERVAL_MS, CHECKS_PER_RUN).all<GuardRow>()).results;
  const rpc = rpcOver(env.RPC_URL, 25_000, fetchFn);
  let checked = 0, alerted = 0;
  for (const g of due) {
    try {
      const next = watchState(await fetchScanInput(rpc, g.wallet));
      const prev: WatchState | null = g.baseline ? JSON.parse(g.baseline) : null;
      const alerts = prev ? diffWatch(prev, next, g.wallet) : [];
      let sent = false;
      if (alerts.length && env.TELEGRAM_BOT_TOKEN && g.telegram_chat_id) {
        sent = await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, formatAlerts(g.wallet, alerts, esc), fetchFn);
        if (sent) alerted++;
      }
      // Keep the old baseline when an alert couldn't be delivered, so it's retried next time.
      await env.DB.prepare("UPDATE guards SET baseline = ?, last_check_at = ?, checks = checks + 1, alerts = alerts + ?, last_alert_at = CASE WHEN ? THEN ? ELSE last_alert_at END, last_error = NULL WHERE wallet = ?")
        .bind(alerts.length && !sent ? g.baseline : JSON.stringify(next), now, sent ? alerts.length : 0, sent ? 1 : 0, now, g.wallet).run();
      checked++;
    } catch (e: any) {
      await env.DB.prepare("UPDATE guards SET last_check_at = ?, last_error = ? WHERE wallet = ?").bind(now, String(e?.message ?? e).slice(0, 200), g.wallet).run();
    }
  }
  return { checked, alerted };
}
