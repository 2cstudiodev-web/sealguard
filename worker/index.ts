// SealGuard's Worker: serves the built page (dist/) and relays a short list of read-only RPC methods
// to the RPC provider so the API key never reaches the browser. Nothing here signs anything.
export interface Env {
  ASSETS: Fetcher;
  /** Helius (or any DAS-capable) RPC URL with its key, set as a secret. */
  RPC_URL: string;
}

/** Methods the page may call. Reads, a simulation, and sending a transaction the wallet already signed. */
const METHODS = new Set([
  "getAccountInfo", "getBalance", "getTokenAccountsByOwner", "getMultipleAccounts", "getProgramAccounts",
  "getAssetsByOwner", "getLatestBlockhash", "simulateTransaction", "sendTransaction", "getSignatureStatuses",
]);
/** getProgramAccounts is only allowed against these programs (stake and system accounts), and only with filters. */
const GPA_PROGRAMS = new Set(["Stake11111111111111111111111111111111111111", "11111111111111111111111111111111"]);

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function checkRequest(body: any): string | null {
  const method = typeof body?.method === "string" ? body.method : "";
  if (!METHODS.has(method)) return `Method not allowed: ${method}`;
  const params = body?.params;
  if (JSON.stringify(params ?? null).length > 400_000) return "Params too large";
  if (method === "getProgramAccounts") {
    const [program, opts] = Array.isArray(params) ? params : [];
    if (!GPA_PROGRAMS.has(String(program))) return "getProgramAccounts is only allowed for stake and system accounts";
    if (!Array.isArray(opts?.filters) || !opts.filters.some((f: any) => f?.memcmp)) return "getProgramAccounts needs a memcmp filter";
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true, rpc: Boolean(env.RPC_URL) });
    if (url.pathname === "/rpc") {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (!env.RPC_URL) return json({ error: "RPC not configured" }, 503);
      let body: any;
      try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400); }
      const bad = checkRequest(body);
      if (bad) return json({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32601, message: bad } }, 400);
      const upstream = await fetch(env.RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id ?? 1, method: body.method, params: body.params }) });
      const text = await upstream.text();
      return new Response(text, { status: upstream.ok ? 200 : 502, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
