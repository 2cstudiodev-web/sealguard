// Paid MCP checks: an API key per wallet, prepaid checks bought in packs, and a monthly allowance for wallets with
// the guard. Only check_transaction costs a check; the other MCP tools stay free and need no key.
//   Key: "sgk_" + 32 random characters, sent as "Authorization: Bearer sgk_…" (or "x-api-key"). Stored as an HMAC.
//   A check is taken only after the tool has an answer, so failed reads cost nothing.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const CHECK_USD = 0.01;
export const PACK_CHECKS = 500;
export const PACK_USD = PACK_CHECKS * CHECK_USD; // US$5
/** Checks a month included with the guard (US$49/yr). */
export const MEMBER_MONTHLY_CHECKS = 1000;
/** Free checks with a wallet's first key, given once per wallet, so an agent can try it before paying. */
export const TRIAL_CHECKS = 20;
export const KEY_PREFIX = "sgk_";

const utf8 = new TextEncoder();
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function newKey(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return KEY_PREFIX + Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => alphabet[b % alphabet.length]).join("");
}
export const keyHash = (secret: string, key: string) => hex(hmac(sha256, utf8.encode(secret), utf8.encode(`mcpkey:${key}`)));
/** What the owner sees of an active key: "sgk_AbCd…". */
export const keyPrefix = (key: string) => key.slice(0, KEY_PREFIX.length + 4);
export const monthOf = (now: number) => new Date(now).toISOString().slice(0, 7);

/** The key a request carries, if it looks like one. */
export function keyFromRequest(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const k = (m?.[1] ?? request.headers.get("x-api-key") ?? "").trim();
  return k.startsWith(KEY_PREFIX) && k.length === KEY_PREFIX.length + 32 ? k : null;
}

/** The wallet behind an active key, or null. */
export async function walletForKey(db: D1Database, secret: string, key: string, now: number): Promise<string | null> {
  const h = keyHash(secret, key);
  const row = await db.prepare("SELECT wallet FROM mcp_keys WHERE key_hash = ? AND revoked_at IS NULL").bind(h).first<{ wallet: string }>();
  if (!row) return null;
  await db.prepare("UPDATE mcp_keys SET last_used_at = ? WHERE key_hash = ?").bind(now, h).run();
  return row.wallet;
}

/** One free trial per network (hashed IPv4 /24 or IPv6 /48) every TRIAL_NET_DAYS, and at most TRIALS_PER_DAY overall. */
export const TRIAL_NET_DAYS = 30, TRIALS_PER_DAY = 30;

/**
 * Makes a new key for the wallet and retires the old one. The key itself is returned once and never stored.
 * The wallet's first key adds TRIAL_CHECKS free checks (once per wallet, however many keys follow) — but only when
 * the caller's network hasn't had a trial in TRIAL_NET_DAYS and today's trials are under TRIALS_PER_DAY (red-team
 * review 17 Nov 2026: throwaway wallets made the trial farmable). Without `net` (tests, tools) only the wallet rule applies.
 */
export async function rotateKey(db: D1Database, secret: string, wallet: string, now: number, net?: string): Promise<{ key: string; prefix: string; trialChecks: number; trialRefused?: string }> {
  const key = newKey();
  const before = await db.prepare("SELECT trial_given FROM mcp_credits WHERE wallet = ?").bind(wallet).first<{ trial_given: number }>();
  let trial = before?.trial_given ? 0 : TRIAL_CHECKS, trialRefused: string | undefined;
  if (trial && net) {
    const dayStart = now - (now % 86_400_000);
    const [recent, today] = await Promise.all([
      db.prepare("SELECT at FROM mcp_trial_nets WHERE net = ? AND at > ?").bind(net, now - TRIAL_NET_DAYS * 86_400_000).first(),
      db.prepare("SELECT COUNT(*) AS n FROM mcp_trial_nets WHERE at >= ?").bind(dayStart).first<{ n: number }>(),
    ]);
    if (recent) { trial = 0; trialRefused = "network"; }
    else if ((today?.n ?? 0) >= TRIALS_PER_DAY) { trial = 0; trialRefused = "daily"; }
  }
  await db.batch([
    db.prepare("UPDATE mcp_keys SET revoked_at = ? WHERE wallet = ? AND revoked_at IS NULL").bind(now, wallet),
    db.prepare("INSERT INTO mcp_keys (key_hash, wallet, prefix, created_at) VALUES (?, ?, ?, ?)").bind(keyHash(secret, key), wallet, keyPrefix(key), now),
    db.prepare("INSERT INTO mcp_credits (wallet, credits, trial_given) VALUES (?, ?, 1) ON CONFLICT(wallet) DO UPDATE SET credits = credits + CASE WHEN trial_given = 0 THEN excluded.credits ELSE 0 END, trial_given = 1").bind(wallet, trial),
    ...(trial && net ? [db.prepare("INSERT INTO mcp_trial_nets (net, at) VALUES (?, ?) ON CONFLICT(net) DO UPDATE SET at = excluded.at").bind(net, now)] : []),
  ]);
  return { key, prefix: keyPrefix(key), trialChecks: trial, ...(trialRefused ? { trialRefused } : {}) };
}

/** The caller's network for the trial rule: IPv4 /24 or IPv6 /48, hashed with the secret (no raw address stored). */
export async function trialNet(secret: string, ip: string): Promise<string> {
  const net = ip.includes(":") ? ip.split(":").slice(0, 3).join(":") : ip.split(".").slice(0, 3).join(".");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:trial:${net}`));
  return Array.from(new Uint8Array(h).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function revokeKeys(db: D1Database, wallet: string, now: number): Promise<void> {
  await db.prepare("UPDATE mcp_keys SET revoked_at = ? WHERE wallet = ? AND revoked_at IS NULL").bind(now, wallet).run();
}

export type Account = { credits: number; member: boolean; memberMonthly: number; memberUsed: number; usedTotal: number; key: { prefix: string; createdAt: number; lastUsedAt: number | null } | null };

export async function account(db: D1Database, wallet: string, member: boolean, now: number): Promise<Account> {
  const c = await db.prepare("SELECT * FROM mcp_credits WHERE wallet = ?").bind(wallet).first<{ credits: number; member_month: string | null; member_used: number; used_total: number }>();
  const k = await db.prepare("SELECT prefix, created_at, last_used_at FROM mcp_keys WHERE wallet = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").bind(wallet).first<{ prefix: string; created_at: number; last_used_at: number | null }>();
  return {
    credits: c?.credits ?? 0,
    member,
    memberMonthly: MEMBER_MONTHLY_CHECKS,
    memberUsed: c && c.member_month === monthOf(now) ? c.member_used : 0,
    usedTotal: c?.used_total ?? 0,
    key: k ? { prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at } : null,
  };
}

/** Whether the wallet can pay for one check right now (looked at before the work; taken after). */
export async function canSpend(db: D1Database, wallet: string, member: boolean, now: number): Promise<boolean> {
  const a = await account(db, wallet, member, now);
  return (member && a.memberUsed < MEMBER_MONTHLY_CHECKS) || a.credits > 0;
}

/** Takes one check: the member allowance first, then prepaid checks. Atomic per statement. */
export async function spendCheck(db: D1Database, wallet: string, member: boolean, now: number): Promise<{ from: "member" | "credits"; left: number } | null> {
  await db.prepare("INSERT INTO mcp_credits (wallet) VALUES (?) ON CONFLICT(wallet) DO NOTHING").bind(wallet).run();
  const month = monthOf(now);
  if (member) {
    const r = await db.prepare(
      "UPDATE mcp_credits SET member_used = CASE WHEN member_month = ?1 THEN member_used + 1 ELSE 1 END, member_month = ?1, used_total = used_total + 1 " +
      "WHERE wallet = ?2 AND (member_month IS NOT ?1 OR member_used < ?3) RETURNING member_used, credits",
    ).bind(month, wallet, MEMBER_MONTHLY_CHECKS).first<{ member_used: number; credits: number }>();
    if (r) return { from: "member", left: MEMBER_MONTHLY_CHECKS - r.member_used + r.credits };
  }
  const r = await db.prepare("UPDATE mcp_credits SET credits = credits - 1, used_total = used_total + 1 WHERE wallet = ? AND credits > 0 RETURNING credits").bind(wallet).first<{ credits: number }>();
  return r ? { from: "credits", left: r.credits } : null;
}
