// MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses) at /mcp, so people can ask an AI
// app "is my Solana wallet safe?" or "how much SOL can I get back?" and get SealGuard's scan.
//   Read-only and public: no sign-in, no transactions. Every fix links back to the SealGuard page, where the wallet
//   owner signs it. Same rules as the page (shared web/src/scan.ts).
//   Tools: scan_wallet, list_empty_token_accounts, list_token_approvals.
//   Each tool call is a full chain read (RPC credits), so calls are limited per IP and per day (table mcp_usage).
// Docs for people: /docs/mcp (web/public/docs/mcp.html).
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpcOver } from "../shared/chain";
import { CLOSE_FEE_BPS, scan, type Finding, type ScanResult } from "../web/src/scan";
import type { GuardEnv } from "./guard";
import { logScan } from "./scanlog";

const ORIGIN = "https://guard.2cstudio.app";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_CALLS_PER_HOUR = 30;
export const MCP_CALLS_PER_DAY = 2000;
const HOUR_MS = 3_600_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

const SERVER_INFO = {
  name: "sealguard",
  title: "SealGuard",
  version: "1.0.0",
  websiteUrl: `${ORIGIN}/docs/mcp`,
  icons: [{ src: `${ORIGIN}/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] }, { src: `${ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
};

const INSTRUCTIONS = "SealGuard checks a Solana wallet from public chain data: token approvals, phishing airdrops, Token-2022 permanent delegates, stake and nonce authorities, a taken-over wallet account, and empty token accounts holding SOL rent that can be taken back. It is read-only: it never asks for a seed phrase and can't send transactions. To fix anything, send the user to the link in the result, where they connect their own wallet and approve each fix.";

const ADDRESS = { type: "object", properties: { address: { type: "string", description: "The Solana wallet address (base58 public key) to check." } }, required: ["address"], additionalProperties: false };
export const TOOLS = [
  {
    name: "scan_wallet",
    title: "Check a Solana wallet",
    description: "Checks a Solana wallet for risks and gives a 0-100 safety score: open token approvals, phishing airdrops, Token-2022 permanent delegates and transfer restrictions, stake and nonce accounts controlled by someone else, and whether the wallet account itself has been taken over. Also totals the SOL locked in empty token accounts. Read-only; returns a link where the owner can fix what was found.",
    inputSchema: ADDRESS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_empty_token_accounts",
    title: "List empty token accounts and the SOL in them",
    description: "Lists a Solana wallet's empty token accounts (left behind by sold or sent tokens), the SOL rent locked in each, and which ones SealGuard suggests closing. Accounts for tokens the owner will likely receive again, or used in the last 30 days, are marked to keep, with the reason. Also lists pump.fun and PumpSwap deposits the wallet can take back. Read-only; returns a link where the owner can close them.",
    inputSchema: ADDRESS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_token_approvals",
    title: "List open token approvals",
    description: "Lists every token approval (delegate) on a Solana wallet: which address can still move which token, and how much. Also lists Token-2022 permanent delegates, which holders can't revoke. Read-only; returns a link where the owner can revoke approvals for free.",
    inputSchema: ADDRESS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}
/** Problems the AI can explain to the user (bad address, limit reached): returned as tool results with isError. */
class ToolError extends Error {}

const sol = (lamports: number) => Number((lamports / 1e9).toFixed(9));
const usd = (lamports: number, price: number | null) => (price ? Number(((lamports / 1e9) * price).toFixed(2)) : null);

function checkAddress(raw: unknown): string {
  const s = String(raw ?? "").trim();
  try {
    const pk = new PublicKey(s);
    if (!PublicKey.isOnCurve(pk.toBytes())) throw new Error("off curve");
    return pk.toBase58();
  } catch {
    throw new ToolError("That isn't a Solana wallet address. Give the wallet's public address (base58), not a token, program or transaction.");
  }
}

const fixLink = (wallet: string) => `${ORIGIN}/?address=${wallet}`;
const NOTE = "SealGuard only reads public chain data. To fix anything, the wallet owner opens the link, connects that wallet and approves each fix; nothing is sent without their signature.";

function finding(f: Finding) {
  return { severity: f.severity, title: f.title, detail: f.detail, fixable_on_sealguard: Boolean(f.action), ...(f.keep ? { note: f.keep } : {}) };
}

export function scanSummary(wallet: string, r: ScanResult) {
  const risks = r.findings.filter((f) => f.check !== "empty");
  return {
    wallet,
    score: r.score,
    counts: r.counts,
    findings: risks.slice(0, 50).map(finding),
    ...(risks.length > 50 ? { more_findings: risks.length - 50 } : {}),
    empty_token_accounts: { count: r.reclaim.accounts, rent_sol: sol(r.reclaim.lamports), rent_usd: usd(r.reclaim.lamports, r.solPriceUsd) },
    checked: r.checked,
    open_in_sealguard: fixLink(wallet),
    note: NOTE,
  };
}

export function emptyAccounts(wallet: string, r: ScanResult) {
  const empty = r.findings.filter((f) => f.check === "empty" && f.action?.kind === "close");
  const lamportsOf = (f: Finding) => (f.action?.kind === "close" ? f.action.lamports : 0);
  const suggested = empty.filter((f) => !f.keep);
  const suggestedLamports = suggested.reduce((s, f) => s + lamportsOf(f), 0);
  const fee = Math.floor((suggestedLamports * CLOSE_FEE_BPS) / 10_000);
  return {
    wallet,
    count: empty.length,
    rent_sol: sol(empty.reduce((s, f) => s + lamportsOf(f), 0)),
    suggested: { count: suggested.length, rent_sol: sol(suggestedLamports), rent_usd: usd(suggestedLamports, r.solPriceUsd) },
    accounts: empty.slice(0, 100).map((f) => ({ title: f.title, account: f.accounts[0], mint: f.accounts[1], rent_sol: sol(lamportsOf(f)), suggested: !f.keep, ...(f.keep ? { keep_reason: f.keep } : {}) })),
    ...(empty.length > 100 ? { more_accounts: empty.length - 100 } : {}),
    pump_fun_deposits: r.findings.filter((f) => f.check === "pumpDeposit").map((f) => ({ title: f.title, account: f.accounts[0], sol: f.action?.kind === "closePump" ? sol(f.action.lamports) : null, can_close_now: Boolean(f.action), detail: f.detail })),
    fee: `Closing through SealGuard costs ${CLOSE_FEE_BPS / 100}% of the rent returned (${sol(fee)} SOL on the suggested ones), paid in the same transaction; wallets with the SealGuard guard pay no fee.`,
    close_on_sealguard: `${ORIGIN}/?address=${wallet}`,
    note: NOTE,
  };
}

export function approvals(wallet: string, r: ScanResult) {
  const list = r.findings.filter((f) => f.check === "delegate" || f.check === "permanentDelegate");
  return {
    wallet,
    count: list.length,
    approvals: list.map((f) => ({ kind: f.check === "delegate" ? "approval" : "permanent_delegate", revocable: f.check === "delegate", ...finding(f) })),
    revoke_on_sealguard: fixLink(wallet),
    note: `${NOTE} Revoking is free apart from the Solana network fee.`,
  };
}

/** One call per IP-hash and hour, plus a daily total across everyone. Throws ToolError when over. */
async function countCall(env: GuardEnv, ip: string, now: number): Promise<void> {
  const hour = Math.floor(now / HOUR_MS);
  const key = await ipKey(env.SESSION_SECRET, ip.includes(":") ? ip.split(":").slice(0, 4).join(":") : ip); // IPv6: per /64
  const day = Math.floor(now / (24 * HOUR_MS));
  await env.DB.prepare("DELETE FROM mcp_usage WHERE hour < ?").bind(hour - 48).run();
  // Count first and read the new total in the same statement, so parallel calls can't all slip under the limit.
  const mine = await env.DB.prepare("INSERT INTO mcp_usage (hour, ip, n) VALUES (?, ?, 1) ON CONFLICT(hour, ip) DO UPDATE SET n = n + 1 RETURNING n").bind(hour, key).first<{ n: number }>();
  if ((mine?.n ?? 1) > MCP_CALLS_PER_HOUR) throw new ToolError(`SealGuard allows ${MCP_CALLS_PER_HOUR} checks an hour from one connection. Try again later, or open ${ORIGIN} in a browser.`);
  const all = await env.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM mcp_usage WHERE hour >= ?").bind(day * 24).first<{ n: number }>();
  if ((all?.n ?? 0) > MCP_CALLS_PER_DAY) throw new ToolError(`SealGuard's AI checks are busy today. Open ${ORIGIN} in a browser instead.`);
}
async function ipKey(secret: string, ip: string): Promise<string> {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${secret}:mcp:${ip}`));
  return Array.from(new Uint8Array(h).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export type Scanner = (wallet: string) => Promise<ScanResult>;
const chainScanner = (env: GuardEnv): Scanner => async (wallet) => scan(await fetchScanInput(rpcOver(env.RPC_URL, 30_000), wallet, () => {}, { activityUpTo: 40 }), { closeFeeBps: CLOSE_FEE_BPS });

async function callTool(env: GuardEnv, ip: string, name: string, args: any, now: number, scanner: Scanner, country: string | null = null): Promise<object> {
  const wallet = checkAddress(args?.address);
  await countCall(env, ip, now);
  const r = await scanner(wallet);
  await logScan(env.DB, {
    at: now, address: wallet, via: "mcp", score: name === "scan_wallet" ? r.score : null,
    critical: r.counts.critical ?? 0, high: r.counts.high ?? 0, medium: r.counts.medium ?? 0, low: r.counts.low ?? 0,
    reclaimAccounts: r.reclaim.accounts, reclaimLamports: r.reclaim.lamports, source: `mcp:${name}`, country,
  });
  if (name === "scan_wallet") return scanSummary(wallet, r);
  if (name === "list_empty_token_accounts") return emptyAccounts(wallet, r);
  return approvals(wallet, r);
}

async function dispatch(env: GuardEnv, ip: string, method: string, params: any, now: number, scanner: Scanner, country: string | null = null): Promise<object> {
  switch (method) {
    case "initialize": {
      const asked = String(params?.protocolVersion ?? "");
      return { protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = String(params?.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(env, ip, name, params?.arguments ?? {}, now, scanner, country);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (err: any) {
        if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
        console.error("mcp tool", err);
        return { content: [{ type: "text", text: "SealGuard couldn't read this wallet from the Solana network just now. Try again in a minute." }], isError: true };
      }
    }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
  }
  throw new RpcError(-32601, `Method not found: ${method}`);
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function handleMessage(env: GuardEnv, ip: string, msg: any, now: number, scanner: Scanner, country: string | null = null): Promise<object | null> {
  const isRequest = msg && typeof msg === "object" && msg.jsonrpc === "2.0" && typeof msg.method === "string";
  if (!isRequest) return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg) ? rpcError(msg.id ?? null, -32600, "Invalid request") : null;
  if (!("id" in msg)) return null; // notifications get no answer
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await dispatch(env, ip, msg.method, msg.params ?? {}, now, scanner, country) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(msg.id, err.code, err.message);
    console.error("mcp", err);
    return rpcError(msg.id, -32603, "Internal error");
  }
}

export async function handleMcp(request: Request, env: GuardEnv, now: number, scanner: Scanner = chainScanner(env)): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // A person opening the URL in a browser gets the setup guide.
  if (request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html")) return Response.redirect(`${ORIGIN}/docs/mcp`, 302);
  // No server-to-client stream and no sessions: every request is answered on its own.
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed", message: "POST JSON-RPC messages to this URL" }), { status: 405, headers: { "content-type": "application/json", allow: "POST, OPTIONS", ...CORS } });
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const country = typeof (request as any).cf?.country === "string" ? String((request as any).cf.country).slice(0, 2).toUpperCase() : null;
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return json(rpcError(null, -32700, "Parse error"), 400);
  if (Array.isArray(body)) {
    if (!body.length) return json(rpcError(null, -32600, "Empty batch"), 400);
    const out = [];
    for (const m of body.slice(0, 10)) { const r = await handleMessage(env, ip, m, now, scanner, country); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await handleMessage(env, ip, body, now, scanner, country);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}
