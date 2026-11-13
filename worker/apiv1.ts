// /api/v1: wallet checks for programs (the "SealGuard Solana Wallet Check" Actor on Apify uses it).
//   POST /api/v1/scan { address, client? } with the API key (x-api-key or Authorization: Bearer) = secret API_SCAN_KEY
//   → { result } (the same summary as the MCP scan_wallet tool) or { error, message }.
//   No per-IP limit (Apify runs from shared IPs); a daily total across all callers instead (API_DAILY_CAP, default
//   200 per UTC day), so bulk runs can't use up the Helius credits the page and the free MCP tools need.
//   Rows go in mcp_usage keyed "api:<client>", which the free MCP daily total leaves out.
import { safeEqualText } from "./auth";
import type { GuardEnv } from "./guard";
import { chainScanner, checkAddress, scanSummary, ToolError, type Scanner } from "./mcp";
import { logScan } from "./scanlog";

export interface ApiEnv extends GuardEnv {
  API_SCAN_KEY?: string;
  API_DAILY_CAP?: string;
}

const HOUR_MS = 3_600_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export const dailyCap = (env: ApiEnv) => Math.max(1, Number(env.API_DAILY_CAP) || 200);

/** The request carries the API key (unset or short secret = every request refused). */
export function apiKeyOk(request: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 24) return false;
  const bearer = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  const got = (request.headers.get("x-api-key") ?? bearer).trim();
  return got.length > 0 && safeEqualText(got, expected);
}

/** "api" or "api:apify": the client label, lower-case letters, digits, - and _ only. */
export function apiClient(raw: unknown): string {
  const c = String(raw ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 30);
  return c ? `api:${c}` : "api";
}

/** Counts one check against today's total; false when today's cap is already used. */
async function takeFromCap(env: ApiEnv, client: string, now: number): Promise<boolean> {
  const hour = Math.floor(now / HOUR_MS);
  const day = Math.floor(now / (24 * HOUR_MS));
  const used = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM mcp_usage WHERE hour >= ? AND ip LIKE 'api%'").bind(day * 24).first<{ n: number }>();
  if ((used?.n ?? 0) >= dailyCap(env)) return false;
  await env.DB.prepare("INSERT INTO mcp_usage (hour, ip, n) VALUES (?, ?, 1) ON CONFLICT(hour, ip) DO UPDATE SET n = n + 1").bind(hour, client).run();
  return true;
}

export async function handleApiV1(request: Request, env: ApiEnv, path: string, now: number, scanner: Scanner = chainScanner(env)): Promise<Response | null> {
  if (path !== "/api/v1/scan") return null;
  if (request.method !== "POST") return json({ error: "method_not_allowed", message: "POST { address } to this URL" }, 405);
  if (!apiKeyOk(request, env.API_SCAN_KEY)) return json({ error: "unauthorized", message: "Send a valid API key in x-api-key." }, 401);
  const body = (await request.json().catch(() => null)) as { address?: unknown; client?: unknown } | null;
  let wallet: string;
  try {
    wallet = checkAddress(body?.address);
  } catch (e) {
    if (e instanceof ToolError) return json({ error: "bad_address", message: e.message }, 400);
    throw e;
  }
  const client = apiClient(body?.client);
  if (!(await takeFromCap(env, client, now)))
    return json({ error: "daily_cap", message: `This API checks at most ${dailyCap(env)} wallets a day (UTC). Try again tomorrow.` }, 429);
  let r;
  try {
    r = await scanner(wallet);
  } catch (e: any) {
    console.error("api scan", e?.message ?? e);
    return json({ error: "chain_unavailable", message: "Couldn't read the Solana chain just now. Try again in a minute." }, 502);
  }
  await logScan(env.DB, {
    at: now, address: wallet, via: "api", score: r.score,
    critical: r.counts.critical ?? 0, high: r.counts.high ?? 0, medium: r.counts.medium ?? 0, low: r.counts.low ?? 0,
    reclaimAccounts: r.reclaim.accounts, reclaimLamports: r.reclaim.lamports, source: client, country: null,
  });
  return json({ result: scanSummary(wallet, r) });
}
