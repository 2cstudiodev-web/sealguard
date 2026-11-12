// SealGuard's Worker: serves the built page (dist/), relays a short list of read-only RPC methods to the RPC
// provider so the API key never reaches the browser, and runs the guard (sign-in, Telegram link, payment,
// cron re-scans). Nothing here signs anything.
import { allowed, handleApi, pruneOld, runGuards, type GuardEnv } from "./guard";
import { safeEqualText, webhookSecret } from "./auth";
import bs58 from "bs58";
import { handleMcp } from "./mcp";

export interface Env extends GuardEnv {
  ASSETS: Fetcher;
  /** Workers Rate Limiting for the /rpc relay (wrangler.jsonc "ratelimits"). */
  RL_RPC?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

/** Methods the page may call. Reads, a simulation, and sending a transaction the wallet already signed. */
const METHODS = new Set([
  "getAccountInfo", "getBalance", "getTokenAccountsByOwner", "getMultipleAccounts", "getProgramAccounts", "getProgramAccountsV2",
  "getAssetsByOwner", "getAsset", "getAssetBatch", "getSignaturesForAddress", "getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses",
]);
/** getProgramAccounts is only allowed against these programs (stake and system accounts), and only with filters. */
const GPA_PROGRAMS = new Set(["Stake11111111111111111111111111111111111111", "11111111111111111111111111111111"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const isKey = (b: unknown) => { try { return typeof b === "string" && bs58.decode(b).length === 32; } catch { return false; } };
/** Only the two lookups the page makes: stake accounts by staker/withdrawer, nonce accounts by authority. */
export function gpaFiltersOk(program: string, filters: unknown): boolean {
  if (!Array.isArray(filters)) return false;
  const mem = filters.filter((f: any) => f?.memcmp), size = filters.filter((f: any) => f?.dataSize !== undefined);
  if (mem.length !== 1 || mem.length + size.length !== filters.length) return false;
  const m: any = (mem[0] as any).memcmp;
  if (!isKey(m?.bytes) || (m.encoding !== undefined && m.encoding !== "base58")) return false;
  if (program === "Stake11111111111111111111111111111111111111") return (m.offset === 12 || m.offset === 44) && size.length === 0;
  return m.offset === 8 && size.length === 1 && (size[0] as any).dataSize === 80;
}

function checkRequest(body: any): string | null {
  const method = typeof body?.method === "string" ? body.method : "";
  if (!METHODS.has(method)) return `Method not allowed: ${method}`;
  const params = body?.params;
  if (JSON.stringify(params ?? null).length > 400_000) return "Params too large";
  if (method === "getProgramAccounts" || method === "getProgramAccountsV2") {
    const [program, opts] = Array.isArray(params) ? params : [];
    if (!GPA_PROGRAMS.has(String(program))) return "getProgramAccounts is only allowed for stake and system accounts";
    if (!gpaFiltersOk(String(program), opts?.filters)) return "getProgramAccounts filters must be the page's own (one wallet's stake or nonce accounts)";
    if (opts?.limit !== undefined && !(Number.isInteger(opts.limit) && opts.limit > 0 && opts.limit <= 1000)) return "limit must be 1–1000";
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/health") {
      let db = false;
      try { await env.DB.prepare("SELECT 1").first(); db = true; } catch { /* no binding or no table yet */ }
      // ?telegram=1 also asks Telegram how webhook delivery is going (no token in the answer).
      let webhook: unknown = undefined;
      // Webhook details only for whoever has the webhook secret (?telegram=<secret>).
      if (env.TELEGRAM_BOT_TOKEN && safeEqualText(url.searchParams.get("telegram") ?? "", webhookSecret(env.TELEGRAM_BOT_TOKEN))) {
        try {
          const r: any = await (await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) })).json();
          const i = r?.result ?? {};
          webhook = { ok: Boolean(r?.ok), url: i.url ?? null, pending: i.pending_update_count ?? null, lastError: i.last_error_message ?? null, lastErrorAt: i.last_error_date ? new Date(i.last_error_date * 1000).toISOString() : null, allowed: i.allowed_updates ?? null };
        } catch (e: any) {
          webhook = { ok: false, error: String(e?.message ?? e) };
        }
      }
      return json({ ok: true, rpc: Boolean(env.RPC_URL), db, guard: Boolean(env.SESSION_SECRET), telegram: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME), webhook });
    }
    if (url.pathname === "/rpc") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await allowed(env.RL_RPC, ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip))) return json({ jsonrpc: "2.0", id: null, error: { code: 429, message: "Too many requests" } }, 429);
      if (!env.RPC_URL) return json({ error: "RPC not configured" }, 503);
      let body: any;
      try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
      const bad = checkRequest(body);
      if (bad) return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: bad } }, 400);
      const upstream = await fetch(env.RPC_URL, { signal: AbortSignal.timeout(25_000), method: "POST", headers: { "content-type": "application/json", "user-agent": "SealGuard/0.1 (+https://guard.2cstudio.app)" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, method: body.method, params: body.params }) });
      const text = await upstream.text();
      return new Response(text, { status: upstream.ok ? 200 : 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    // Read-only MCP server for AI apps (worker/mcp.ts).
    if (url.pathname === "/mcp") return handleMcp(request, env, now);
    if (url.pathname.startsWith("/api/")) {
      const r = await handleApi(request, env, url.pathname, now);
      if (r) return r;
      return json({ error: "not_found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runGuards(env, Date.now()).then((r) => console.log("guards", JSON.stringify(r))));
    ctx.waitUntil(pruneOld(env, Date.now()));
  },
} satisfies ExportedHandler<Env>;
