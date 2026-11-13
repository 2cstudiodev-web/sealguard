// Paid MCP checks: keys, prepaid checks, the guard allowance, the check_transaction tool, and that a pack quote
// can't pay for the guard (or the other way round). Runs on real SQLite with every migration (test/d1sqlite.ts).
import { describe, expect, it } from "vitest";
import { d1 } from "./d1sqlite";
import { handleMcp, type TxChecker } from "../worker/mcp";
import { handleApi, type GuardEnv } from "../worker/guard";
import { issueToken } from "../worker/auth";
import { account, keyFromRequest, MEMBER_MONTHLY_CHECKS, rotateKey, spendCheck, walletForKey } from "../worker/mcpkeys";
import { TxInputError, type TxCheck } from "../worker/txcheck";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const now = Date.UTC(2026, 10, 13, 12);
const env = (): GuardEnv => ({ DB: d1(), RPC_URL: "", SESSION_SECRET: "s", TREASURY: "B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA" });
const ok: TxCheck = { verdict: "no_red_flags", signer: W, summary: "fine", risks: [], balance_changes: { sol: 0, tokens: [] }, programs: [], simulated: true, simulation_error: null };
const checker: TxChecker = async () => ok;
const scanner = async () => { throw new Error("not used"); };

const mcpCall = (key: string | null, args: object = { transaction: "AQ==" }) => new Request("https://guard.2cstudio.app/mcp", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4", ...(key ? { authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_transaction", arguments: args } }),
});
const run = async (e: GuardEnv, key: string | null, c: TxChecker = checker, at = now) => ((await (await handleMcp(mcpCall(key), e, at, scanner as any, c)).json()) as any).result;

describe("keys and checks", () => {
  it("makes a key, finds its wallet, and retires the old key on rotation", async () => {
    const e = env();
    const a = await rotateKey(e.DB, e.SESSION_SECRET, W, now);
    expect(a.key).toMatch(/^sgk_[A-Za-z0-9]{32}$/);
    expect(await walletForKey(e.DB, e.SESSION_SECRET, a.key, now)).toBe(W);
    const b = await rotateKey(e.DB, e.SESSION_SECRET, W, now + 1);
    expect(await walletForKey(e.DB, e.SESSION_SECRET, a.key, now)).toBeNull();
    expect(await walletForKey(e.DB, e.SESSION_SECRET, b.key, now)).toBe(W);
    expect((await account(e.DB, W, false, now)).key?.prefix).toBe(b.prefix);
  });

  it("reads the key from Authorization or x-api-key", () => {
    const k = "sgk_" + "a".repeat(32);
    expect(keyFromRequest(new Request("https://x", { headers: { authorization: `Bearer ${k}` } }))).toBe(k);
    expect(keyFromRequest(new Request("https://x", { headers: { "x-api-key": k } }))).toBe(k);
    expect(keyFromRequest(new Request("https://x", { headers: { authorization: "Bearer nope" } }))).toBeNull();
  });

  it("spends the member allowance first, resets it monthly, then prepaid checks", async () => {
    const e = env();
    await e.DB.prepare("INSERT INTO mcp_credits (wallet, credits, member_month, member_used) VALUES (?, 2, ?, ?)").bind(W, "2026-11", MEMBER_MONTHLY_CHECKS - 1).run();
    expect((await spendCheck(e.DB, W, true, now))?.from).toBe("member");
    expect((await spendCheck(e.DB, W, true, now))?.from).toBe("credits");
    expect((await spendCheck(e.DB, W, true, now))?.from).toBe("credits");
    expect(await spendCheck(e.DB, W, true, now)).toBeNull();
    // A new month: the allowance is back.
    expect((await spendCheck(e.DB, W, true, Date.UTC(2026, 11, 1)))?.from).toBe("member");
    expect(await spendCheck(e.DB, W, false, now)).toBeNull();
  });
});

describe("check_transaction over MCP", () => {
  it("asks for a key, and says where to get one", async () => {
    const r = await run(env(), null);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/API key.*mcp-key/s);
  });

  it("refuses a key with no checks, without simulating", async () => {
    const e = env();
    const { key } = await rotateKey(e.DB, e.SESSION_SECRET, W, now);
    let simulated = false;
    const r = await run(e, key, async () => { simulated = true; return ok; });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/no checks left/);
    expect(simulated).toBe(false);
  });

  it("charges one prepaid check per answer, and nothing for a bad transaction", async () => {
    const e = env();
    const { key } = await rotateKey(e.DB, e.SESSION_SECRET, W, now);
    await e.DB.prepare("UPDATE mcp_credits SET credits = 3 WHERE wallet = ?").bind(W).run();
    const r = await run(e, key);
    expect(r.structuredContent.verdict).toBe("no_red_flags");
    expect(r.structuredContent.billing).toEqual({ charged_checks: 1, from: "prepaid checks", checks_left: 2 });
    const bad = await run(e, key, async () => { throw new TxInputError("That isn't a Solana transaction."); });
    expect(bad.isError).toBe(true);
    expect((await account(e.DB, W, false, now)).credits).toBe(2);
  });

  it("uses the guard allowance for members", async () => {
    const e = env();
    const { key } = await rotateKey(e.DB, e.SESSION_SECRET, W, now);
    await e.DB.prepare("INSERT INTO guards (wallet, created_at, paid_until) VALUES (?, ?, ?)").bind(W, now, now + 86_400_000).run();
    const r = await run(e, key);
    expect(r.structuredContent.billing.from).toBe("guard allowance");
    expect(r.structuredContent.billing.checks_left).toBe(MEMBER_MONTHLY_CHECKS - 1);
  });
});

describe("quotes are for one thing only", () => {
  const api = (e: GuardEnv, path: string, body: object) => handleApi(new Request(`https://guard.2cstudio.app${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${issueToken(e.SESSION_SECRET, W, now)}` }, body: JSON.stringify(body),
  }), e, path, now);
  const sig = "5".repeat(88);

  it("won't count a pack quote as a guard payment, nor a guard quote as a pack", async () => {
    const e = env();
    await e.DB.prepare("INSERT INTO meta (k, v) VALUES ('test_wallets', ?)").bind(W).run();
    const pack = (await (await api(e, "/api/mcp/quote", {}))!.json()) as any;
    expect(pack.memo).toMatch(/^sealguard:mcp:/);
    const r1 = await api(e, "/api/guard/pay", { quoteId: pack.quoteId, token: "USDC", signature: sig });
    expect(r1!.status).toBe(400);
    expect(((await r1!.json()) as any).error).toBe("bad_quote");
    const guard = (await (await api(e, "/api/guard/quote", {}))!.json()) as any;
    const r2 = await api(e, "/api/mcp/pay", { quoteId: guard.quoteId, token: "USDC", signature: sig });
    expect(((await r2!.json()) as any).error).toBe("bad_quote");
  });

  it("shows the account with the pack price", async () => {
    const e = env();
    const r = (await (await handleApi(new Request("https://guard.2cstudio.app/api/mcp/account", { headers: { authorization: `Bearer ${issueToken(e.SESSION_SECRET, W, now)}` } }), e, "/api/mcp/account", now))!.json()) as any;
    expect(r).toMatchObject({ credits: 0, member: false, key: null, packChecks: 500, packUsd: "5.00", checkUsd: 0.01 });
  });
});
