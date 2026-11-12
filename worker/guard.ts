// The guard: sign in, link Telegram, pay for a year, and the cron that re-scans every watched wallet and
// messages the owner when something changed for the worse.
import { fetchScanInput, rpcOver } from "../shared/chain";
import { claimText, diffWatch, formatAlerts, watchState, weeklyText, type WatchState } from "../shared/watch";
import { solWithUsd } from "../web/src/scan";
import { bearer, checkSignIn, FRESH_SIGNIN_MS, issueToken, makeNonce, safeEqualText, siwsMessage, verifySession, verifyToken, webhookSecret } from "./auth";
import { buildQuotes, extendPaidUntil, GUARD_USD, jupiterPrices, TEST_QUOTES, PAY_SLACK_MS, PAY_TOKENS, QUOTE_TTL_MS, SKR_MINT, verifyPaymentTx, WSOL_MINT, type ParsedTx, type PayToken } from "./pay";
import { esc, sendTelegram, setWebhook, startCode } from "./telegram";
import { cleanSource, logScan, ownDevice, ownWallet, SCAN_VIA, validWallet, type ScanVia } from "./scanlog";

export interface GuardEnv {
  DB: D1Database;
  RPC_URL: string;
  SESSION_SECRET: string;
  TREASURY: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_BOT_USERNAME?: string;
  PUBLIC_URL?: string;
  /** Workers Rate Limiting (wrangler.jsonc "ratelimits"): stats, sign-in, quotes, Telegram replies. */
  RL_API?: { limit(o: { key: string }): Promise<{ success: boolean }> };
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
  try { const b = await request.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; }
}

/** A signed sign-in works once: the nonce is recorded until it would have expired anyway. */
async function useNonce(env: GuardEnv, nonce: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare("INSERT OR IGNORE INTO used_nonces (nonce, exp) VALUES (?, ?)").bind(nonce, now + 24 * 3_600_000).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Workers Rate Limiting, per caller; true when allowed (and when the binding isn't there, e.g. in tests). */
export async function allowed(limiter: { limit(o: { key: string }): Promise<{ success: boolean }> } | undefined, key: string): Promise<boolean> {
  if (!limiter) return true;
  try { return (await limiter.limit({ key })).success; } catch { return true; }
}
const callerKey = (request: Request) => {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // IPv6: one /64 is one customer.
  return ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip;
};

function randomCode(len = 24): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

type GuardRow = { wallet: string; created_at: number; paid_until: number | null; telegram_chat_id: string | null; link_code: string | null; link_code_expires: number | null; baseline: string | null; last_check_at: number | null; last_alert_at: number | null; checks: number; alerts: number; last_error: string | null; activated_at?: number | null; last_weekly_at?: number | null; weekly_checks_base?: number; weekly_alerts_base?: number; last_claim_notice_at?: number | null; last_test_at?: number | null };

function requireWallet(env: GuardEnv, request: Request, now: number): string {
  const t = bearer(request);
  const w = t ? verifyToken(env.SESSION_SECRET, t, now) : null;
  if (!w) throw new ApiError(401, "unauthorized", "Sign in again");
  return w;
}

/** Linking or unlinking Telegram changes where alerts go, so someone at an unlocked computer with an old sign-in
 *  can't redirect them: it needs a sign-in from the last 10 minutes or a new signed message (`proof`). A new
 *  signature also renews the session token, returned as `token`. */
async function requireFreshWallet(env: GuardEnv, request: Request, body: any, now: number): Promise<{ wallet: string; token?: string }> {
  const t = bearer(request);
  const s = t ? verifySession(env.SESSION_SECRET, t, now) : null;
  if (!s) throw new ApiError(401, "unauthorized", "Sign in again");
  if (now - s.iat <= FRESH_SIGNIN_MS) return { wallet: s.wallet };
  const p = body?.proof;
  if (p && typeof p.nonce === "string" && typeof p.issuedAt === "string" && typeof p.signature === "string") {
    const r = await checkSignIn(env.SESSION_SECRET, { wallet: s.wallet, nonce: p.nonce, issuedAt: p.issuedAt, signature: p.signature }, now);
    if (r.ok && (await useNonce(env, p.nonce, now))) return { wallet: s.wallet, token: issueToken(env.SESSION_SECRET, s.wallet, now) };
  }
  throw new ApiError(403, "resign", "Sign once more to change where alerts go.");
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

    // Daily counters from the page (no session): how many scans and fixes, what was closed. A scan also leaves a
    // record with its address and result (worker/scanlog.ts; privacy notice, "Scanning").
    if (path === "/api/stat" && method === "POST") {
      // Over the limit: quietly not counted (the page never shows this call's answer).
      if (!(await allowed(env.RL_API, callerKey(request)))) return json({ ok: true });
      const b = await readJson(request);
      const kind = b.kind === "scan" || b.kind === "fix" ? b.kind : null;
      if (!kind) throw new ApiError(400, "bad_stat");
      const num = (v: unknown, max: number) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : 0);
      // 2C Studio's own browsers and wallets are not counted (the fix's wallet is only checked, never stored).
      if (ownDevice(request) || (await ownWallet(env.DB, validWallet(b.address)))) return json({ ok: true });
      const day = new Date(now).toISOString().slice(0, 10);
      await env.DB.prepare("INSERT INTO daily_stats (day, kind, n, closes, lamports, fee) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1, closes = closes + excluded.closes, lamports = lamports + excluded.lamports, fee = fee + excluded.fee")
        .bind(day, kind, num(b.closes, 100_000), num(b.lamports, 1e13), num(b.fee, 1e12)).run();
      const scanned = kind === "scan" ? validWallet(b.address) : null;
      if (scanned) {
        await logScan(env.DB, {
          at: now, address: scanned, via: SCAN_VIA.includes(b.via) && b.via !== "mcp" ? (b.via as ScanVia) : "paste",
          score: Number.isInteger(b.score) && b.score >= 0 && b.score <= 100 ? b.score : null,
          critical: num(b.critical, 10_000), high: num(b.high, 10_000), medium: num(b.medium, 10_000), low: num(b.low, 10_000),
          reclaimAccounts: num(b.reclaimAccounts, 100_000), reclaimLamports: num(b.reclaimLamports, 1e13),
          source: cleanSource(b.source), country: cleanSource((request as any).cf?.country)?.toUpperCase() ?? null,
        });
      }
      return json({ ok: true });
    }

    if ((path === "/api/auth/nonce" || path === "/api/auth/verify" || path === "/api/guard/quote") && method === "POST" && !(await allowed(env.RL_API, callerKey(request)))) {
      throw new ApiError(429, "slow_down", "Too many requests");
    }
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
      if (!(await useNonce(env, b.nonce, now))) throw new ApiError(401, "nonce_used", "Sign in again");
      await env.DB.prepare("INSERT INTO guards (wallet, created_at) VALUES (?, ?) ON CONFLICT(wallet) DO NOTHING").bind(r.wallet, now).run();
      return json({ token: issueToken(env.SESSION_SECRET, r.wallet, now), wallet: r.wallet });
    }

    if (path === "/api/guard" && method === "GET") {
      const wallet = requireWallet(env, request, now);
      return json(status(env, await guardRow(env, wallet), now));
    }

    // A one-time code the user hands to the bot: https://t.me/<bot>?start=<code>
    if (path === "/api/guard/link" && method === "POST") {
      const { wallet, token } = await requireFreshWallet(env, request, await readJson(request), now);
      if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_BOT_USERNAME) throw new ApiError(503, "no_telegram", "Telegram alerts aren't configured yet");
      // Telegram is for members: the link code is only handed out once the guard is paid for.
      const paid = await guardRow(env, wallet);
      if (!paid?.paid_until || paid.paid_until <= now) throw new ApiError(402, "pay_first", "Pay for the guard first; Telegram alerts are for members.");
      const code = randomCode();
      await env.DB.prepare("UPDATE guards SET link_code = ?, link_code_expires = ? WHERE wallet = ?").bind(code, now + LINK_CODE_TTL_MS, wallet).run();
      return json({ code, url: `https://t.me/${env.TELEGRAM_BOT_USERNAME}?start=${code}`, expiresAt: now + LINK_CODE_TTL_MS, token });
    }
    if (path === "/api/guard/unlink" && method === "POST") {
      const { wallet, token } = await requireFreshWallet(env, request, await readJson(request), now);
      const before = await guardRow(env, wallet);
      await env.DB.prepare("UPDATE guards SET telegram_chat_id = NULL WHERE wallet = ?").bind(wallet).run();
      // Say so in the chat too, so it's clear there that alerts have stopped.
      if (before?.telegram_chat_id && env.TELEGRAM_BOT_TOKEN) await sendTelegram(env.TELEGRAM_BOT_TOKEN, before.telegram_chat_id, unlinkedText(wallet)).catch(() => {});
      return json({ ok: true, token });
    }

    // A sample alert to the linked chat, to see what alerts look like and that they arrive. One a minute.
    if (path === "/api/guard/test" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      const g = await guardRow(env, wallet);
      if (!g?.paid_until || g.paid_until <= now) throw new ApiError(402, "pay_first", "Test alerts are for wallets with the guard.");
      if (!g.telegram_chat_id || !env.TELEGRAM_BOT_TOKEN) throw new ApiError(409, "no_telegram", "Link Telegram first.");
      if (g.last_test_at && now - g.last_test_at < TEST_ALERT_GAP_MS) throw new ApiError(429, "too_soon", "One test alert a minute; try again shortly.");
      await env.DB.prepare("UPDATE guards SET last_test_at = ? WHERE wallet = ?").bind(now, wallet).run();
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, testAlertText(wallet));
      return json({ ok: true });
    }

    if (path === "/api/guard/quote" && method === "POST") {
      const wallet = requireWallet(env, request, now);
      if (!env.TREASURY) throw new ApiError(503, "no_treasury");
      const testList = (await env.DB.prepare("SELECT v FROM meta WHERE k = 'test_wallets'").first<{ v: string }>())?.v ?? "";
      const test = testList.split(",").map((x) => x.trim()).includes(wallet);
      const quotes = test ? TEST_QUOTES : buildQuotes(GUARD_USD, await jupiterPrices([WSOL_MINT, SKR_MINT]));
      const id = randomCode(16);
      const memo = `sealguard:guard:${id}`;
      const expiresAt = now + QUOTE_TTL_MS;
      await env.DB.batch(quotes.map((q) => env.DB.prepare("INSERT INTO quotes (id, token, wallet, base_units, display, usd, memo, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, q.token, wallet, q.baseUnits, q.display, test ? "test" : GUARD_USD.toFixed(2), memo, expiresAt)));
      return json({ quoteId: id, usd: GUARD_USD.toFixed(2), memo, expiresAt, now, quotes, treasury: env.TREASURY, test });
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
      // No request-time expiry: a payment that landed in time counts even if the page comes back late (the
      // transaction's own block time is checked against the quote below).
      const rpc = rpcOver(env.RPC_URL, 20_000);
      let tx: ParsedTx | null = null;
      try {
        tx = (await rpc<ParsedTx | null>("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 1 }])) ?? null;
      } catch (e: any) {
        // A malformed signature is the caller's mistake; a provider hiccup is retried by the page.
        if (/invalid/i.test(String(e?.message))) throw new ApiError(400, "bad_signature", "That isn't a transaction signature");
        throw new ApiError(503, "chain_busy", "Solana lookups are busy; try again in a few seconds");
      }
      const check = verifyPaymentTx(tx, { payer: wallet, treasury: env.TREASURY, token, baseUnits: BigInt(q.base_units), memo: q.memo, paidBy: q.expires_at + PAY_SLACK_MS });
      if (!check.ok) {
        if (check.reason === "pending") throw new ApiError(503, "chain_busy", "The payment is still confirming; try again in a few seconds");
        throw new ApiError(check.reason === "not_found" ? 404 : 400, check.reason);
      }
      // Count the transaction by its first signature, whichever of its signatures the page sent.
      const first = (tx as any)?.transaction?.signatures?.[0];
      if (typeof first === "string" && first !== signature) throw new ApiError(400, "bad_signature", "Send the transaction's first signature");
      const g = await guardRow(env, wallet);
      const paidUntil = extendPaidUntil(g?.paid_until ?? null, now);
      // The baseline is the wallet as it is right now: the guard reports changes from here on.
      let baseline: string | null = g?.baseline ?? null;
      try { baseline = JSON.stringify(watchState(await fetchScanInput(rpc, wallet))); } catch { /* the first cron run fills it in */ }
      await env.DB.batch([
        env.DB.prepare("UPDATE quotes SET used = 1 WHERE id = ?").bind(quoteId),
        env.DB.prepare("INSERT INTO payments (signature, wallet, quote_id, token, base_units, usd, paid_at, paid_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(signature, wallet, quoteId, token, q.base_units, q.usd, now, paidUntil),
        env.DB.prepare("UPDATE guards SET activated_at = CASE WHEN paid_until IS NULL OR paid_until < ? THEN ? ELSE activated_at END, paid_until = ?, baseline = COALESCE(?, baseline), last_error = NULL WHERE wallet = ?").bind(now, now, paidUntil, baseline, wallet),
      ]);
      return json({ ok: true, paidUntil });
    }

    // Telegram → us. The secret header proves it's Telegram; /start <code> links a chat to a wallet.
    if (path === "/api/telegram" && method === "POST") {
      if (!env.TELEGRAM_BOT_TOKEN || !safeEqualText(request.headers.get("x-telegram-bot-api-secret-token") ?? "", webhookSecret(env.TELEGRAM_BOT_TOKEN))) return new Response("forbidden", { status: 403 });
      const update = await readJson(request);
      const s = startCode(update);
      if (s) {
        const g = await env.DB.prepare("SELECT wallet, link_code_expires, telegram_chat_id FROM guards WHERE link_code = ?").bind(s.code).first<{ wallet: string; link_code_expires: number; telegram_chat_id: string | null }>();
        if (g && g.link_code_expires > now) {
          if (g.telegram_chat_id && g.telegram_chat_id !== s.chatId) await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, movedText(g.wallet)).catch(() => {});
          await env.DB.prepare("UPDATE guards SET telegram_chat_id = ?, link_code = NULL, link_code_expires = NULL, baseline = NULL WHERE wallet = ?").bind(s.chatId, g.wallet).run();
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, s.chatId, `✅ Linked to wallet <code>${esc(g.wallet)}</code>. SealGuard will message you here when something in that wallet changes for the worse.`);
        } else {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, s.chatId, "That link code is unknown or has expired. Open https://guard.2cstudio.app, sign in and press Link Telegram again.");
        }
      } else if (update?.message?.chat?.id && (await allowed(env.RL_API, `tg:${update.message.chat.id}`))) {
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

const DAY_MS = 86_400_000;
const TEST_ALERT_GAP_MS = 60_000;

export function unlinkedText(wallet: string): string {
  return `🔌 Unlinked from wallet <code>${esc(wallet)}</code>. SealGuard won't send alerts for it here any more. To link again, open https://guard.2cstudio.app/ and press Link Telegram.`;
}
export function movedText(wallet: string): string {
  return `🔌 Alerts for wallet <code>${esc(wallet)}</code> now go to another Telegram chat, so this chat won't get them any more. If that wasn't you, open https://guard.2cstudio.app/ and link this chat again.`;
}
export function testAlertText(wallet: string): string {
  return `🧪 <b>Test alert</b>, sent from the SealGuard page. Nothing has changed in your wallet; this shows what an alert looks like.\n\n` +
    formatAlerts(wallet, [{ severity: "high", text: "Example: address 9xQe…VFin can now spend up to 1,000 USDC from this wallet. Real alerts end with a Fix it link that opens the fix on SealGuard." }], esc);
}
export const REMIND_BEFORE_MS = 7 * DAY_MS;
const shortWallet = (w: string) => `${w.slice(0, 4)}…${w.slice(-4)}`;
const dayText = (ms: number) => new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const priceText = () => `US$${Number.isInteger(GUARD_USD) ? GUARD_USD : GUARD_USD.toFixed(2)}`;

export function reminderText(wallet: string, paidUntil: number): string {
  return `⏰ Your SealGuard guard for wallet <code>${esc(shortWallet(wallet))}</code> ends on ${dayText(paidUntil)}. To keep the alerts coming, renew for another year (${priceText()}) at https://guard.2cstudio.app/: sign in with the same wallet and press Extend by a year.`;
}

export function endedText(wallet: string): string {
  return `Your SealGuard guard for wallet <code>${esc(shortWallet(wallet))}</code> ended today, so alerts have stopped. You can renew any time at https://guard.2cstudio.app/.`;
}

/** One reminder a week before the guard ends and one note when it has ended, each once per paid period. */
export async function sendRenewalNotices(env: GuardEnv, now: number, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<{ reminded: number; ended: number }> {
  if (!env.TELEGRAM_BOT_TOKEN) return { reminded: 0, ended: 0 };
  let reminded = 0, ended = 0;
  const soon = (await env.DB.prepare("SELECT wallet, paid_until, telegram_chat_id FROM guards WHERE telegram_chat_id IS NOT NULL AND paid_until > ? AND paid_until <= ? AND (reminded_until IS NULL OR reminded_until <> paid_until) LIMIT 50")
    .bind(now, now + REMIND_BEFORE_MS).all<{ wallet: string; paid_until: number; telegram_chat_id: string }>()).results;
  for (const g of soon) {
    if (await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, reminderText(g.wallet, g.paid_until), fetchFn)) {
      await env.DB.prepare("UPDATE guards SET reminded_until = ? WHERE wallet = ?").bind(g.paid_until, g.wallet).run();
      reminded++;
    }
  }
  // Only guards that ended in the last three days: older ones were told already, or ended before this existed.
  const gone = (await env.DB.prepare("SELECT wallet, paid_until, telegram_chat_id FROM guards WHERE telegram_chat_id IS NOT NULL AND paid_until <= ? AND paid_until > ? AND (ended_notice_until IS NULL OR ended_notice_until <> paid_until) LIMIT 50")
    .bind(now, now - 3 * DAY_MS).all<{ wallet: string; paid_until: number; telegram_chat_id: string }>()).results;
  for (const g of gone) {
    if (await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, endedText(g.wallet), fetchFn)) {
      await env.DB.prepare("UPDATE guards SET ended_notice_until = ? WHERE wallet = ?").bind(g.paid_until, g.wallet).run();
      ended++;
    }
  }
  return { reminded, ended };
}

const WEEK_MS = 7 * DAY_MS;
const CLAIM_EVERY_MS = 30 * DAY_MS;
/** The monthly rent reminder only goes out when closing would return at least this much (0.01 SOL). */
export const CLAIM_MIN_LAMPORTS = 10_000_000;

/** After a check: the weekly all-clear, and the monthly reminder of rent to claim back. */
export async function sendDigests(env: GuardEnv, g: GuardRow, next: WatchState, solPriceUsd: number | null, alertsJustSent: number, now: number, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !g.telegram_chat_id || !g.paid_until) return;
  const started = g.activated_at ?? g.created_at;
  if (now - (g.last_weekly_at ?? started) >= WEEK_MS) {
    const checks = g.checks + 1 - (g.weekly_checks_base ?? 0);
    const alerts = g.alerts + alertsJustSent - (g.weekly_alerts_base ?? 0);
    if (await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, weeklyText(g.wallet, checks, alerts, g.paid_until, esc), fetchFn)) {
      await env.DB.prepare("UPDATE guards SET last_weekly_at = ?, weekly_checks_base = ?, weekly_alerts_base = ? WHERE wallet = ?").bind(now, g.checks + 1, g.alerts + alertsJustSent, g.wallet).run();
    }
  }
  const lamports = next.reclaimLamports ?? 0;
  if (now - (g.last_claim_notice_at ?? started) >= CLAIM_EVERY_MS && lamports >= CLAIM_MIN_LAMPORTS) {
    if (await sendTelegram(env.TELEGRAM_BOT_TOKEN, g.telegram_chat_id, claimText(g.wallet, next.emptyAccounts ?? 0, solWithUsd(lamports, solPriceUsd), esc), fetchFn)) {
      await env.DB.prepare("UPDATE guards SET last_claim_notice_at = ? WHERE wallet = ?").bind(now, g.wallet).run();
    }
  }
}

/** The cron: make sure the webhook is set, send renewal notices, then re-scan the guards whose turn it is. */
/** Housekeeping with the cron: spent quotes, used sign-in nonces, and sign-ins that never became a guard. */
export async function pruneOld(env: GuardEnv, now: number): Promise<void> {
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM quotes WHERE expires_at < ?").bind(now - 7 * 86_400_000),
      env.DB.prepare("DELETE FROM used_nonces WHERE exp < ?").bind(now),
      env.DB.prepare("DELETE FROM guards WHERE paid_until IS NULL AND telegram_chat_id IS NULL AND created_at < ? AND wallet NOT IN (SELECT wallet FROM payments)").bind(now - 30 * 86_400_000),
    ]);
  } catch (e) {
    console.error("prune", e);
  }
}

export async function runGuards(env: GuardEnv, now: number, fetchFn: typeof fetch = (i, o) => fetch(i, o)): Promise<{ checked: number; alerted: number }> {
  if (env.TELEGRAM_BOT_TOKEN && env.PUBLIC_URL) {
    const want = webhookSecret(env.TELEGRAM_BOT_TOKEN) + "@" + env.PUBLIC_URL;
    const have = await env.DB.prepare("SELECT v FROM meta WHERE k = 'webhook'").first<{ v: string }>();
    if (have?.v !== want && (await setWebhook(env.TELEGRAM_BOT_TOKEN, `${env.PUBLIC_URL}/api/telegram`, fetchFn))) {
      await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('webhook', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(want).run();
    }
  }
  try { await sendRenewalNotices(env, now, fetchFn); } catch (e) { console.error("renewal notices", e); }
  const due = (await env.DB.prepare("SELECT * FROM guards WHERE paid_until > ? AND telegram_chat_id IS NOT NULL AND (last_check_at IS NULL OR last_check_at < ?) ORDER BY last_check_at ASC LIMIT ?")
    .bind(now, now - CHECK_INTERVAL_MS, CHECKS_PER_RUN).all<GuardRow>()).results;
  const rpc = rpcOver(env.RPC_URL, 25_000, fetchFn);
  let checked = 0, alerted = 0;
  for (const g of due) {
    try {
      const input = await fetchScanInput(rpc, g.wallet);
      const next = watchState(input);
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
      try { await sendDigests(env, g, next, input.solPriceUsd ?? null, sent ? alerts.length : 0, now, fetchFn); } catch (e) { console.error("digests", e); }
    } catch (e: any) {
      await env.DB.prepare("UPDATE guards SET last_check_at = ?, last_error = ? WHERE wallet = ?").bind(now, String(e?.message ?? e).slice(0, 200), g.wallet).run();
    }
  }
  return { checked, alerted };
}
