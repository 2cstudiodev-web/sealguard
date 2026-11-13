// MCP server (Model Context Protocol, Streamable HTTP, stateless JSON responses) at /mcp, so people can ask an AI
// app "is my Solana wallet safe?" or "how much SOL can I get back?" and get SealGuard's scan.
//   Read-only and public: no sign-in, no transactions. Every fix links back to the SealGuard page, where the wallet
//   owner signs it. Same rules as the page (shared web/src/scan.ts).
//   Tools: scan_wallet, list_empty_token_accounts, list_token_approvals (free, no key), and check_transaction
//   (paid: an API key with prepaid checks or a guard membership; worker/mcpkeys.ts, worker/txcheck.ts).
//   Each free call is a full chain read (RPC credits), so calls are limited per IP and per day (table mcp_usage).
// Docs for people: /docs/mcp (web/public/docs/mcp.html).
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpcOver } from "../shared/chain";
import { CLOSE_FEE_BPS, rentOf, scan, type Finding, type ScanResult } from "../web/src/scan";
import { allowed, isMember, type GuardEnv } from "./guard";
import { logScan } from "./scanlog";
import { canSpend, CHECK_USD, keyFromRequest, MEMBER_MONTHLY_CHECKS, PACK_CHECKS, PACK_USD, spendCheck, walletForKey } from "./mcpkeys";
import { checkTransaction, TxInputError, type TxCheck } from "./txcheck";

const ORIGIN = "https://guard.2cstudio.app";
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
export const MCP_CALLS_PER_HOUR = 30;
export const MCP_CALLS_PER_DAY = 2000;
const HOUR_MS = 3_600_000;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "authorization, x-api-key, content-type, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
};
// "data:" is sent as the JSON escape data\u003a (the same JSON once parsed): some directory checkers treat any
// body containing "data:" as server-sent events and then fail to find the result (the instructions say "chain data:").
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body).replace(/data:/g, "data\\u003a"), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

const SERVER_INFO = {
  name: "sealguard",
  title: "SealGuard",
  version: "1.1.0",
  websiteUrl: `${ORIGIN}/docs/mcp`,
  icons: [{ src: `${ORIGIN}/logo.svg`, mimeType: "image/svg+xml", sizes: ["any"] }, { src: `${ORIGIN}/icon.png`, mimeType: "image/png", sizes: ["512x512"] }],
};

const INSTRUCTIONS = "SealGuard checks a Solana wallet from public chain data: token approvals, phishing airdrops, Token-2022 permanent delegates, stake and nonce authorities, a taken-over wallet account, and SOL that can be taken back: empty token accounts, pump.fun deposits, small balances that can be sold, and NFTs that can be burnt. It is read-only: it never asks for a seed phrase and can't send transactions. To fix anything, send the user to the link in the result, where they connect their own wallet and approve each fix.";

const ADDRESS = { type: "object", properties: { address: { type: "string", description: "The Solana wallet address (base58 public key) to check." } }, required: ["address"], additionalProperties: false };
export const TOOLS = [
  {
    name: "scan_wallet",
    title: "Check a Solana wallet",
    description: "Checks a Solana wallet for risks and gives a 0-100 safety score: open token approvals, phishing airdrops, Token-2022 permanent delegates and transfer restrictions, stake and nonce accounts controlled by someone else, and whether the wallet account itself has been taken over. Also totals the SOL the wallet could take back: empty token accounts, pump.fun deposits, small balances it could sell, and NFTs it could burn. Read-only; returns a link where the owner can fix what was found.",
    inputSchema: ADDRESS,
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "list_empty_token_accounts",
    title: "List the SOL a wallet can take back",
    description: "Lists the SOL a Solana wallet could take back: empty token accounts (left behind by sold or sent tokens) with the rent in each and which ones SealGuard suggests closing (accounts for tokens the owner will likely receive again, or used in the last 30 days, are marked to keep, with the reason); pump.fun and PumpSwap deposits; small balances worth under US$1 that could be sold for SOL through Jupiter; and NFTs whose burn would return their rent. Selling and burning are never suggested by default: they're the owner's call. Read-only; returns a link where the owner can do it.",
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
  {
    name: "check_transaction",
    title: "Check a Solana transaction before signing",
    description: "Before a wallet signs a Solana transaction, simulates it on mainnet and says whether it would hand anything over: the wallet account itself, a token account's owner, a standing approval on its tokens, a close authority, stake or nonce authorities. Also lists the SOL and token amounts that would leave and arrive, flags durable nonces (a signed transaction that can be sent much later) and programs SealGuard doesn't know. Verdict: do_not_sign, review or no_red_flags. Read-only: nothing is signed or sent. Paid: needs a SealGuard API key (Authorization: Bearer sgk_…); US$0.01 a check, or 1,000 a month included with the SealGuard guard. Keys at https://guard.2cstudio.app/mcp-key",
    inputSchema: {
      type: "object",
      properties: {
        transaction: { type: "string", description: "The serialized transaction, base64 (base58 also accepted). Unsigned is fine." },
        signer: { type: "string", description: "The wallet about to sign. Defaults to the fee payer (the first signer)." },
      },
      required: ["transaction"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
] as const;

const KEY_PAGE = `${ORIGIN}/mcp-key`;
const PRICE_TEXT = `US$${CHECK_USD.toFixed(2)} a check (${PACK_CHECKS} for US$${PACK_USD.toFixed(0)}), or ${MEMBER_MONTHLY_CHECKS.toLocaleString("en-US")} a month included with the SealGuard guard`;

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

/** Sales and NFT burns, with what each would bring back (rent, plus the estimated sale for small balances). */
const optional = (r: ScanResult, check: "dust" | "nftRent") => r.findings.filter((f) => f.check === check && f.action);
const lamportsBack = (fs: Finding[]) => fs.reduce((s, f) => s + (f.action ? rentOf(f.action) : 0), 0);

/** Everything the wallet could take back, by kind (before SealGuard's fee). */
function takeBack(r: ScanResult) {
  const pumps = r.findings.filter((f) => f.check === "pumpDeposit" && f.action);
  const pumpLamports = pumps.reduce((s, f) => s + (f.action?.kind === "closePump" ? f.action.lamports : 0), 0);
  const dust = optional(r, "dust"), nfts = optional(r, "nftRent");
  const total = r.reclaim.lamports + pumpLamports + lamportsBack(dust) + lamportsBack(nfts);
  return {
    empty_token_accounts: { count: r.reclaim.accounts, sol: sol(r.reclaim.lamports) },
    pump_deposits: { count: pumps.length, sol: sol(pumpLamports) },
    small_balances: { count: dust.length, about_sol: sol(lamportsBack(dust)), suggested: false },
    nfts_to_burn: { count: nfts.length, about_sol: sol(lamportsBack(nfts)), suggested: false },
    total_about_sol: sol(total),
    total_about_usd: usd(total, r.solPriceUsd),
  };
}

export function scanSummary(wallet: string, r: ScanResult) {
  const risks = r.findings.filter((f) => f.check !== "empty" && f.check !== "dust" && f.check !== "nftRent");
  return {
    wallet,
    score: r.score,
    counts: r.counts,
    findings: risks.slice(0, 50).map(finding),
    ...(risks.length > 50 ? { more_findings: risks.length - 50 } : {}),
    empty_token_accounts: { count: r.reclaim.accounts, rent_sol: sol(r.reclaim.lamports), rent_usd: usd(r.reclaim.lamports, r.solPriceUsd) },
    take_back: takeBack(r),
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
    small_balances: optional(r, "dust").slice(0, 100).map((f) => ({ title: f.title, account: f.accounts[0], mint: f.accounts[1], about_sol: sol(rentOf(f.action!)), suggested: false, ...(f.keep ? { note: f.keep } : {}) })),
    nfts_to_burn: optional(r, "nftRent").slice(0, 100).map((f) => ({ title: f.title, account: f.accounts[0], mint: f.accounts[1], about_sol: sol(rentOf(f.action!)), suggested: false, ...(f.keep ? { note: f.keep } : {}) })),
    take_back: takeBack(r),
    fee: `Closing, selling and burning through SealGuard cost ${CLOSE_FEE_BPS / 100}% of the SOL returned (${sol(fee)} SOL on the suggested closes), paid in the same transaction; wallets with the SealGuard guard pay no fee.`,
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
export type TxChecker = (transaction: unknown, signer: unknown) => Promise<TxCheck>;
const chainTxChecker = (env: GuardEnv): TxChecker => (transaction, signer) => checkTransaction(rpcOver(env.RPC_URL, 30_000), transaction, signer);
export type Tools = { scanner: Scanner; txChecker: TxChecker };

/** The paid tool: key → wallet → a check available → simulate → take the check. Failures cost nothing. */
async function paidCheck(env: GuardEnv, key: string | null, args: any, now: number, txChecker: TxChecker): Promise<object> {
  if (!key) throw new ToolError(`check_transaction needs a SealGuard API key, sent as "Authorization: Bearer sgk_…". ${PRICE_TEXT}. Get a key at ${KEY_PAGE}. The other SealGuard tools are free and need no key.`);
  const wallet = await walletForKey(env.DB, env.SESSION_SECRET, key, now);
  if (!wallet) throw new ToolError(`That SealGuard API key isn't active (it may have been replaced). See your key at ${KEY_PAGE}.`);
  if (!(await allowed(env.RL_API, `mcpkey:${wallet}`))) throw new ToolError("Too many checks in the last minute on this key. Wait a moment and try again.");
  const g = await env.DB.prepare("SELECT paid_until FROM guards WHERE wallet = ?").bind(wallet).first<{ paid_until: number | null }>();
  const member = isMember(g, now);
  if (!(await canSpend(env.DB, wallet, member, now))) throw new ToolError(`This key has no checks left${member ? " this month" : ""}. ${PRICE_TEXT}. Top up at ${KEY_PAGE}.`);
  let result: TxCheck;
  try {
    result = await txChecker(args?.transaction, args?.signer);
  } catch (e) {
    if (e instanceof TxInputError) throw new ToolError(e.message);
    throw e;
  }
  const spent = await spendCheck(env.DB, wallet, member, now);
  if (!spent) throw new ToolError(`This key ran out of checks just now. Top up at ${KEY_PAGE}.`);
  await env.DB.prepare("INSERT INTO daily_stats (day, kind, n, closes, lamports, fee) VALUES (?, 'mcp_tx', 1, 0, 0, 0) ON CONFLICT(day, kind) DO UPDATE SET n = n + 1").bind(new Date(now).toISOString().slice(0, 10)).run().catch(() => {});
  return { ...result, note: "SealGuard simulated this transaction on Solana mainnet just now; the chain can change before it's sent. It reads effects on the signer's own accounts and can't judge prices or whether a payment is one you meant to make.", billing: { charged_checks: 1, from: spent.from === "member" ? "guard allowance" : "prepaid checks", checks_left: spent.left } };
}

async function callTool(env: GuardEnv, ip: string, name: string, args: any, now: number, tools: Tools, country: string | null = null, key: string | null = null): Promise<object> {
  if (name === "check_transaction") return paidCheck(env, key, args, now, tools.txChecker);
  const scanner = tools.scanner;
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

async function dispatch(env: GuardEnv, ip: string, method: string, params: any, now: number, tools: Tools, country: string | null = null, key: string | null = null): Promise<object> {
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
        const result = await callTool(env, ip, name, params?.arguments ?? {}, now, tools, country, key);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
      } catch (err: any) {
        if (err instanceof ToolError) return { content: [{ type: "text", text: err.message }], isError: true };
        console.error("mcp tool", err);
        return { content: [{ type: "text", text: name === "check_transaction" ? "SealGuard couldn't simulate this transaction on the Solana network just now. No check was charged; try again in a minute." : "SealGuard couldn't read this wallet from the Solana network just now. Try again in a minute." }], isError: true };
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

async function handleMessage(env: GuardEnv, ip: string, msg: any, now: number, tools: Tools, country: string | null = null, key: string | null = null): Promise<object | null> {
  const isRequest = msg && typeof msg === "object" && msg.jsonrpc === "2.0" && typeof msg.method === "string";
  if (!isRequest) return msg && typeof msg === "object" && "id" in msg && !("result" in msg || "error" in msg) ? rpcError(msg.id ?? null, -32600, "Invalid request") : null;
  if (!("id" in msg)) return null; // notifications get no answer
  try {
    return { jsonrpc: "2.0", id: msg.id, result: await dispatch(env, ip, msg.method, msg.params ?? {}, now, tools, country, key) };
  } catch (err) {
    if (err instanceof RpcError) return rpcError(msg.id, err.code, err.message);
    console.error("mcp", err);
    return rpcError(msg.id, -32603, "Internal error");
  }
}

export async function handleMcp(request: Request, env: GuardEnv, now: number, scanner: Scanner = chainScanner(env), txChecker: TxChecker = chainTxChecker(env)): Promise<Response> {
  const tools: Tools = { scanner, txChecker };
  const key = keyFromRequest(request);
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
    for (const m of body.slice(0, 10)) { const r = await handleMessage(env, ip, m, now, tools, country, key); if (r) out.push(r); }
    return out.length ? json(out) : new Response(null, { status: 202, headers: CORS });
  }
  const out = await handleMessage(env, ip, body, now, tools, country, key);
  return out ? json(out) : new Response(null, { status: 202, headers: CORS });
}
