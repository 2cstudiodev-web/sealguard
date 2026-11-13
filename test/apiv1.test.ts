// /api/v1/scan for the Apify Actor: key check, address check, daily cap, and the free MCP total leaving api rows out.
// Runs on real SQLite with every migration (test/d1sqlite.ts).
import { describe, expect, it } from "vitest";
import { apiClient, apiKeyOk, handleApiV1, type ApiEnv } from "../worker/apiv1";
import { scan, SYSTEM_PROGRAM, type ScanInput } from "../web/src/scan";
import { d1 } from "./d1sqlite";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const KEY = "k".repeat(40);
const now = 1_800_000_000_000;
const input: ScanInput = { wallet: W, walletOwner: SYSTEM_PROGRAM, mints: {}, assets: {}, stakes: [], nonces: [], tokenAccounts: [] };
const scanner = async () => scan(input);
const env = (cap = "3"): ApiEnv => ({ DB: d1(), RPC_URL: "", SESSION_SECRET: "s".repeat(32), TREASURY: W, API_SCAN_KEY: KEY, API_DAILY_CAP: cap });
const req = (body: unknown, key = KEY) => new Request("https://guard.2cstudio.app/api/v1/scan", { method: "POST", headers: { "x-api-key": key, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("/api/v1/scan", () => {
  it("checks the key", () => {
    expect(apiKeyOk(new Request("https://x", { headers: { authorization: `Bearer ${KEY}` } }), KEY)).toBe(true);
    expect(apiKeyOk(new Request("https://x", { headers: { "x-api-key": KEY + "x" } }), KEY)).toBe(false);
    expect(apiKeyOk(new Request("https://x", { headers: { "x-api-key": "short" } }), "short")).toBe(false);
    expect(apiKeyOk(new Request("https://x", { headers: { "x-api-key": KEY } }), undefined)).toBe(false);
  });

  it("labels the client", () => {
    expect(apiClient("Apify")).toBe("api:apify");
    expect(apiClient("")).toBe("api");
  });

  it("refuses a wrong key and a bad address", async () => {
    const e = env();
    expect((await handleApiV1(req({ address: W }, "nope".repeat(10)), e, "/api/v1/scan", now, scanner))!.status).toBe(401);
    const bad = await handleApiV1(req({ address: "not-a-wallet" }), e, "/api/v1/scan", now, scanner);
    expect(bad!.status).toBe(400);
    expect((await bad!.json() as any).error).toBe("bad_address");
  });

  it("returns the scan summary and stops at the daily cap", async () => {
    const e = env("2");
    const ok = await handleApiV1(req({ address: W, client: "apify" }), e, "/api/v1/scan", now, scanner);
    expect(ok!.status).toBe(200);
    const body = (await ok!.json()) as any;
    expect(body.result.wallet).toBe(W);
    expect(typeof body.result.score).toBe("number");
    expect((await handleApiV1(req({ address: W, client: "apify" }), e, "/api/v1/scan", now, scanner))!.status).toBe(200);
    const capped = await handleApiV1(req({ address: W, client: "apify" }), e, "/api/v1/scan", now, scanner);
    expect(capped!.status).toBe(429);
    // a failed address doesn't use the cap: it is checked first
    expect((await handleApiV1(req({ address: "x" }), e, "/api/v1/scan", now, scanner))!.status).toBe(400);
    // the free MCP daily total leaves api rows out
    const free = await e.DB.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM mcp_usage WHERE ip NOT LIKE 'api:%'").first<{ n: number }>();
    expect(free?.n).toBe(0);
  });

  it("ignores other paths", async () => {
    expect(await handleApiV1(req({}), env(), "/api/v1/other", now, scanner)).toBeNull();
  });
});
