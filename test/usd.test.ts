import { describe, expect, it } from "vitest";
import { formatUsd, scan, solWithUsd, SYSTEM_PROGRAM, TOKEN_ACCOUNT_RENT_LAMPORTS, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "acct", mint: "mint", program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p });

describe("USD next to amounts", () => {
  it("formats USD by size and stays quiet without a price", () => {
    expect(formatUsd(5.6)).toBe("≈ US$5.60");
    expect(formatUsd(0.0034)).toBe("≈ US$0.003");
    expect(formatUsd(1234.5)).toBe("≈ US$1,235");
    expect(formatUsd(null)).toBe("");
    expect(solWithUsd(TOKEN_ACCOUNT_RENT_LAMPORTS, 170)).toBe("0.00203928 SOL (≈ US$0.35)");
    expect(solWithUsd(2_500_000_000, null)).toBe("2.5 SOL");
  });

  it("totals the rent to reclaim and prices a delegate's allowance", () => {
    const r = scan(input({
      solPriceUsd: 170,
      tokenAccounts: [acct({ address: "a" }), acct({ address: "b" }), acct({ address: "c", amount: 50_000_000n, delegate: OTHER, delegatedAmount: 12_500_000n })],
      assets: { mint: { mint: "mint", name: "USD Coin", symbol: "USDC", description: "", jsonUri: "", kind: "FungibleToken", priced: true, priceUsd: 1 } },
    }));
    const gross = 2 * TOKEN_ACCOUNT_RENT_LAMPORTS, fee = Math.floor(gross * 0.05);
    expect(r.reclaim).toEqual({ accounts: 2, lamports: gross, fee, net: gross - fee, usd: ((gross - fee) / 1e9) * 170 });
    expect(r.findings.find((f) => f.check === "delegate")!.detail).toContain("12.5 USDC (≈ US$12.50)");
    expect(r.findings.find((f) => f.check === "empty")!.detail).toContain("(≈ US$0.35)");
  });

  it("leaves amounts in SOL when there is no price", () => {
    const r = scan(input({ tokenAccounts: [acct({})] }));
    expect(r.reclaim.usd).toBeNull();
    expect(r.findings[0].detail).toContain("0.00203928 SOL rent deposit");
    expect(r.findings[0].detail).toContain("5% fee");
    expect(r.findings[0].detail).not.toContain("US$");
  });
});
