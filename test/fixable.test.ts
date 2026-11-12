// Fixes the token program would refuse are not offered: a refused instruction fails its whole transaction batch.
import { describe, expect, it } from "vitest";
import { scan, SYSTEM_PROGRAM, type AssetMeta, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "acct", mint: "mint", program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p });
const phish = (p: Partial<AssetMeta> = {}): AssetMeta => ({ mint: "mint", name: "claim-rewards.xyz Airdrop", symbol: "", description: "", jsonUri: "", kind: "FungibleToken", priced: false, ...p });
const actions = (r: ReturnType<typeof scan>) => r.findings.filter((f) => f.action).map((f) => f.action!.kind);

describe("only fixes the chain will accept", () => {
  it("offers a close for an ordinary empty account", () => {
    expect(actions(scan(input({ tokenAccounts: [acct({})] })))).toEqual(["close"]);
  });
  it("doesn't offer a close when someone else is the close authority", () => {
    const r = scan(input({ tokenAccounts: [acct({ closeAuthority: OTHER })] }));
    expect(actions(r)).toEqual([]);
    expect(r.findings.map((f) => f.check)).toContain("closeAuthority");
  });
  it("offers it when the close authority is the wallet itself", () => {
    expect(actions(scan(input({ tokenAccounts: [acct({ closeAuthority: W })] })))).toEqual(["close"]);
  });
  it("doesn't offer a close for a Token-2022 account the program would refuse", () => {
    expect(actions(scan(input({ tokenAccounts: [acct({ program: "token2022", closeBlocked: true })] })))).toEqual([]);
  });
  it("doesn't offer to burn a phishing token from a frozen account", () => {
    const assets = { mint: phish() };
    expect(actions(scan(input({ tokenAccounts: [acct({ amount: 5n })], assets })))).toEqual(["burnClose"]);
    expect(actions(scan(input({ tokenAccounts: [acct({ amount: 5n, frozen: true })], assets })))).toEqual([]);
  });
  it("never offers to burn a token that has a price", () => {
    expect(actions(scan(input({ tokenAccounts: [acct({ amount: 5n })], assets: { mint: phish({ priced: true }) } })))).toEqual([]);
  });
});
