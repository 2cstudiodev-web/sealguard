// The close fee's base is the account's rent, capped at the rent-exempt minimum for its size.
import { describe, expect, it } from "vitest";
import { feeBase, rentExempt, rentOf, TOKEN_ACCOUNT_RENT_LAMPORTS } from "../web/src/scan";

describe("close fee base", () => {
  it("matches the known rent of a classic token account", () => {
    expect(rentExempt(165)).toBe(TOKEN_ACCOUNT_RENT_LAMPORTS);
  });
  it("never charges on more than the rent an account of that size must hold", () => {
    expect(feeBase({ program: "token", lamports: 50_000_000 })).toBe(TOKEN_ACCOUNT_RENT_LAMPORTS);
    expect(feeBase({ program: "token2022", lamports: 50_000_000, space: 182 })).toBe(rentExempt(182));
    expect(feeBase({ program: "token", lamports: 1_000_000 })).toBe(1_000_000);
  });
  it("uses the reported balance for a Token-2022 account of unknown size", () => {
    expect(feeBase({ program: "token2022", lamports: 2_100_000 })).toBe(2_100_000);
  });
  it("charges on rent while returning every lamport", () => {
    const a = { kind: "close" as const, tokenAccount: "x", mint: "m", program: "token" as const, lamports: 50_000_000, rent: feeBase({ program: "token", lamports: 50_000_000 }) };
    expect(rentOf(a)).toBe(TOKEN_ACCOUNT_RENT_LAMPORTS);
    expect(a.lamports).toBe(50_000_000);
  });
});
