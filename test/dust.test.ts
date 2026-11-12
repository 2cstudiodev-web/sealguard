// Small balances: offered for selling (never ticked), only when a sale and the close that follows can go through.
import { describe, expect, it } from "vitest";
import { DUST_KEEP, rentOf, scan, SYSTEM_PROGRAM, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "ta", mint: "bonk", program: "token", amount: 4_200_000n, decimals: 5, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, lamports: 2_039_280, ...p });
const asset = (priceUsd: number) => ({ bonk: { mint: "bonk", name: "Bonk", symbol: "BONK", description: "", jsonUri: "", kind: "FungibleToken", priced: true, priceUsd } });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [acct({})], mints: {}, assets: asset(0.00001), stakes: [], nonces: [], solPriceUsd: 150, ...p });

describe("small balances", () => {
  it("offers a sale under US$1, unticked, with the rent plus the estimated SOL", () => {
    const r = scan(input({}), { closeFeeBps: 500 });
    const f = r.findings.find((x) => x.check === "dust")!;
    expect(f.title).toMatch(/^Small balance you could sell: 42 BONK \(≈ US\$/);
    expect(f.keep).toBe(DUST_KEEP);
    expect(f.action).toMatchObject({ kind: "sellDust", tokenAccount: "ta", mint: "bonk", amount: 4_200_000n, rent: 2_039_280 });
    expect(rentOf(f.action!)).toBe(2_039_280 + (f.action as any).estLamports);
  });
  it("skips balances worth US$1 or more, frozen ones, NFTs, wrapped SOL and transfer-hook tokens", () => {
    expect(scan(input({ assets: asset(1) }), {}).findings.some((x) => x.check === "dust")).toBe(false);
    expect(scan(input({ tokenAccounts: [acct({ frozen: true })] }), {}).findings.some((x) => x.check === "dust")).toBe(false);
    expect(scan(input({ tokenAccounts: [acct({ amount: 1n, decimals: 0 })] }), {}).findings.some((x) => x.check === "dust")).toBe(false);
    expect(scan(input({ tokenAccounts: [acct({ isNative: true })] }), {}).findings.some((x) => x.check === "dust")).toBe(false);
    const mints = { bonk: { address: "bonk", program: "token2022", extensions: ["transferHook"] } } as any;
    expect(scan(input({ tokenAccounts: [acct({ program: "token2022" })], mints }), {}).findings.some((x) => x.check === "dust")).toBe(false);
    expect(scan(input({ solPriceUsd: null }), {}).findings.some((x) => x.check === "dust")).toBe(false);
  });
});
