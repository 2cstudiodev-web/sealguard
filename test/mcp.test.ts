// The read-only MCP server: protocol basics, the three tools on a made-up wallet, bad addresses and the rate limit.
import { describe, expect, it } from "vitest";
import { handleMcp, MCP_CALLS_PER_HOUR, TOOLS, type Scanner } from "../worker/mcp";
import { scan, SYSTEM_PROGRAM, type ScanInput, type TokenAcct } from "../web/src/scan";
import type { GuardEnv } from "../worker/guard";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const now = 1_800_000_000_000;

const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "acct", mint: "mint", program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, lamports: 2_039_280, ...p } as TokenAcct);
const input: ScanInput = {
  wallet: W, walletOwner: SYSTEM_PROGRAM, mints: {}, assets: {}, stakes: [], nonces: [],
  tokenAccounts: [
    acct({ address: "e1", mint: "memeA" }),
    acct({ address: "e2", mint: "memeB" }),
    acct({ address: "e3", mint: USDC }),
    acct({ address: "d1", mint: "memeC", amount: 100n, delegate: OTHER, delegatedAmount: 50n }),
  ],
};
const scanner: Scanner = async () => scan(input);

// Just enough of D1 for mcp_usage.
function env(): GuardEnv {
  const rows = new Map<string, number>();
  const db: any = {
    prepare: (sql: string) => ({
      bind: (...a: any[]) => ({
        run: async () => {
          if (sql.startsWith("INSERT INTO mcp_usage")) rows.set(`${a[0]}:${a[1]}`, (rows.get(`${a[0]}:${a[1]}`) ?? 0) + 1);
          return {};
        },
        first: async () => {
          // INSERT … ON CONFLICT DO UPDATE SET n = n + 1 RETURNING n
          if (sql.startsWith("INSERT INTO mcp_usage")) { const k = `${a[0]}:${a[1]}`; rows.set(k, (rows.get(k) ?? 0) + 1); return { n: rows.get(k) }; }
          return sql.includes("SUM") ? { n: [...rows.values()].reduce((s, n) => s + n, 0) } : rows.has(`${a[0]}:${a[1]}`) ? { n: rows.get(`${a[0]}:${a[1]}`) } : null;
        },
      }),
    }),
  };
  return { DB: db, RPC_URL: "", SESSION_SECRET: "s", TREASURY: "" };
}
const rpc = (method: string, params: unknown = {}, id = 1) =>
  new Request("https://guard.2cstudio.app/mcp", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "1.2.3.4" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
const call = async (e: GuardEnv, name: string, address: string) => (await (await handleMcp(rpc("tools/call", { name, arguments: { address } }), e, now, scanner)).json()) as any;

describe("MCP server", () => {
  it("answers initialize and lists three read-only tools", async () => {
    const e = env();
    const init = (await (await handleMcp(rpc("initialize", { protocolVersion: "2025-06-18" }), e, now, scanner)).json()) as any;
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("sealguard");
    const list = (await (await handleMcp(rpc("tools/list"), e, now, scanner)).json()) as any;
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["scan_wallet", "list_empty_token_accounts", "list_token_approvals"]);
    expect(TOOLS.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("scans a wallet: score, the approval, empty-account totals and a link back", async () => {
    const r = (await call(env(), "scan_wallet", W)).result.structuredContent;
    expect(r.score).toBeLessThan(100);
    expect(r.findings.some((f: any) => /approval|spend/i.test(f.title + f.detail))).toBe(true);
    expect(r.empty_token_accounts.count).toBe(3);
    expect(r.open_in_sealguard).toBe(`https://guard.2cstudio.app/?address=${W}`);
  });

  it("lists empty accounts, keeping USDC with a reason", async () => {
    const r = (await call(env(), "list_empty_token_accounts", W)).result.structuredContent;
    expect(r.count).toBe(3);
    expect(r.suggested.count).toBe(2);
    expect(r.accounts.find((a: any) => a.account === "e3")).toMatchObject({ suggested: false });
    expect(r.fee).toMatch(/5% of the SOL returned/);
  });

  it("lists approvals as revocable", async () => {
    const r = (await call(env(), "list_token_approvals", W)).result.structuredContent;
    expect(r.count).toBe(1);
    expect(r.approvals[0]).toMatchObject({ kind: "approval", revocable: true, fixable_on_sealguard: true });
  });

  it("explains a bad address as a tool error", async () => {
    const r = (await call(env(), "scan_wallet", "not-a-wallet")).result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/isn't a Solana wallet address/);
  });

  it(`stops after ${MCP_CALLS_PER_HOUR} calls an hour from one connection`, async () => {
    const e = env();
    for (let i = 0; i < MCP_CALLS_PER_HOUR; i++) expect((await call(e, "scan_wallet", W)).result.isError).toBeUndefined();
    const over = (await call(e, "scan_wallet", W)).result;
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toMatch(/checks an hour/);
  });

  it("sends people who open /mcp in a browser to the docs", async () => {
    const r = await handleMcp(new Request("https://guard.2cstudio.app/mcp", { headers: { accept: "text/html" } }), env(), now, scanner);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://guard.2cstudio.app/docs/mcp");
  });
});
