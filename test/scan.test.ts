import { describe, expect, it } from "vitest";
import { hardwareCardReason, holdingsUsd, looksLikePhishing, scan, SYSTEM_PROGRAM, type AssetMeta, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

function acct(p: Partial<TokenAcct>): TokenAcct {
  return { address: "acct", mint: "mint", program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, ...p };
}
function input(p: Partial<ScanInput>): ScanInput {
  return { wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p };
}
const asset = (p: Partial<AssetMeta>): AssetMeta => ({ mint: "mint", name: "", symbol: "", description: "", jsonUri: "", kind: "FungibleToken", priced: false, ...p });

describe("scan", () => {
  it("gives a clean wallet 100 and no findings", () => {
    const r = scan(input({ tokenAccounts: [acct({ amount: 5n })] }));
    expect(r.score).toBe(100);
    expect(r.findings).toEqual([]);
    expect(r.checked.tokenAccounts).toBe(1);
  });

  it("treats a reassigned wallet owner as critical and scores 0", () => {
    const r = scan(input({ walletOwner: OTHER }));
    expect(r.findings[0].check).toBe("owner");
    expect(r.findings[0].severity).toBe("critical");
    expect(r.score).toBe(0);
  });

  it("flags a live delegate as high with a revoke action, a stale one as low", () => {
    const live = scan(input({ tokenAccounts: [acct({ amount: 100n, delegate: OTHER, delegatedAmount: 50n })] }));
    expect(live.findings[0]).toMatchObject({ check: "delegate", severity: "high", action: { kind: "revoke", tokenAccount: "acct" } });
    expect(live.score).toBe(75);
    const stale = scan(input({ tokenAccounts: [acct({ amount: 100n, delegate: OTHER, delegatedAmount: 0n })] }));
    expect(stale.findings[0].severity).toBe("low");
  });

  it("flags Token-2022 permanent delegates (low when the token has a market price) and restrictions", () => {
    const mints = { mint: { mint: "mint", extensions: ["permanentDelegate", "transferHook"], permanentDelegate: OTHER, defaultState: null } };
    const r = scan(input({ tokenAccounts: [acct({ program: "token2022", amount: 10n })], mints }));
    expect(r.findings.map((f) => [f.check, f.severity])).toEqual([["permanentDelegate", "medium"], ["mintExtensions", "low"]]);
    expect(r.findings[0].action).toMatchObject({ kind: "burnClose", amount: 10n, program: "token2022" });
    const priced = scan(input({ tokenAccounts: [acct({ program: "token2022", amount: 10n })], mints, assets: { mint: asset({ name: "Tesla xStock", symbol: "TSLAx", priced: true }) } }));
    const pd = priced.findings.find((f) => f.check === "permanentDelegate")!;
    expect(pd.severity).toBe("low");
    // A token with a market price is never offered for burning.
    expect(pd.action).toBeUndefined();
    expect(r.findings[0].keep).toMatch(/Burning destroys/);
  });

  it("scores repeated findings of one kind with diminishing weight", () => {
    const one = scan(input({ tokenAccounts: [acct({ amount: 1n, delegate: OTHER, delegatedAmount: 1n })] }));
    expect(one.score).toBe(75);
    const two = scan(input({ tokenAccounts: [acct({ amount: 1n, delegate: OTHER, delegatedAmount: 1n }), acct({ address: "b", amount: 1n, delegate: OTHER, delegatedAmount: 1n })] }));
    expect(two.score).toBe(69); // 68.75, shown in whole points
    const many = scan(input({ tokenAccounts: Array.from({ length: 20 }, (_, i) => acct({ address: `a${i}`, amount: 1n, delegate: OTHER, delegatedAmount: 1n })) }));
    expect(many.score).toBe(50);
  });

  it("offers to close empty accounts (tidy-up, no penalty) and skips frozen ones", () => {
    const r = scan(input({ tokenAccounts: [acct({ amount: 0n }), acct({ address: "fz", amount: 0n, frozen: true })] }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ check: "empty", severity: "ok", action: { kind: "close", tokenAccount: "acct" } });
    expect(r.score).toBe(100);
  });

  it("gives known soulbound tokens (Seeker Genesis Token) one calm note instead of warnings", () => {
    const SGT = "8fcgPVhFCtFLtyCDc2FSfgxeUHbSwvtMLzD3QrDXqYfs";
    const r = scan(input({
      tokenAccounts: [acct({ mint: SGT, program: "token2022", amount: 1n, decimals: 0, frozen: true })],
      mints: { [SGT]: { mint: SGT, extensions: ["permanentDelegate", "nonTransferable"], permanentDelegate: OTHER, defaultState: "frozen" } },
    }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ severity: "ok", title: "Seeker Genesis Token: locked to your wallet by design" });
    expect(r.findings[0].action).toBeUndefined();
    expect(r.score).toBe(100);
  });

  it("notes frozen holdings as low", () => {
    const r = scan(input({ tokenAccounts: [acct({ amount: 5n, frozen: true })] }));
    expect(r.findings[0]).toMatchObject({ check: "frozen", severity: "low" });
    expect(r.score).toBe(98);
  });

  it("spots phishing airdrops by URL or bait words in the name, but not priced tokens or websites in descriptions", () => {
    expect(looksLikePhishing(asset({ name: "jupfinally.com 🎁 Airdrop" }))).toMatch(/web address/);
    expect(looksLikePhishing(asset({ name: "$MUMU Reward | mumusol.org" }))).toMatch(/web address/);
    expect(looksLikePhishing(asset({ name: "AIRDROP VOUCHER" }))).toMatch(/claim or reward/);
    expect(looksLikePhishing(asset({ name: "🎁2024 Jupiter AirDrop" }))).not.toBeNull();
    expect(looksLikePhishing(asset({ name: "Metawhips Allowlist" }))).not.toBeNull();
    expect(looksLikePhishing(asset({ name: "Free Bonus", priced: true }))).toBeNull();
    expect(looksLikePhishing(asset({ name: "Jupiter", symbol: "JUP" }))).toBeNull();
    // Ordinary tokens put their website in the description; that alone is not phishing.
    expect(looksLikePhishing(asset({ name: "Wassup Homie", symbol: "HOMIE", description: "The homie coin. https://wassuphomie.com" }))).toBeNull();
    expect(looksLikePhishing(asset({ name: "Unicorn Fart Dust", description: "Free for all, join t.me/ufd" }))).toBeNull();
    expect(looksLikePhishing(asset({ name: "Bonk Drop #5", description: "Claim your airdrop reward at bonk-claim.xyz" }))).toMatch(/claim a reward/);
    const r = scan(input({ tokenAccounts: [acct({ amount: 1000n })], assets: { mint: asset({ name: "visit t.me/claimsol" }) } }));
    expect(r.findings[0]).toMatchObject({ check: "phishing", severity: "medium", action: { kind: "burnClose" } });
  });

  it("flags phishing NFTs without a burn action", () => {
    const r = scan(input({ tokenAccounts: [acct({ amount: 1n, decimals: 0 })], assets: { mint: asset({ name: "Reward Pass", kind: "V1_NFT" }) } }));
    expect(r.findings[0].check).toBe("phishing");
    expect(r.findings[0].action).toBeUndefined();
  });

  it("flags stake accounts whose withdrawer is someone else, and nonce accounts", () => {
    const r = scan(input({
      stakes: [{ address: "s1", staker: W, withdrawer: OTHER, lamports: 1_000_000_000 }, { address: "s2", staker: OTHER, withdrawer: W, lamports: 1 }],
      nonces: [{ address: "n1", authority: W, lamports: 1_500_000 }],
    }));
    expect(r.findings.map((f) => [f.check, f.severity])).toEqual([["stake", "high"], ["nonce", "medium"], ["stake", "low"]]);
    expect(r.findings[1].action).toMatchObject({ kind: "withdrawNonce", nonceAccount: "n1", lamports: 1_500_000 });
  });

  it("sorts by severity and never scores below 0", () => {
    const r = scan(input({
      walletOwner: OTHER,
      tokenAccounts: Array.from({ length: 6 }, (_, i) => acct({ address: `a${i}`, amount: 1n, delegate: OTHER, delegatedAmount: 1n })),
    }));
    expect(r.score).toBe(0);
    expect(r.counts.high).toBe(6);
    expect(r.findings[0].severity).toBe("critical");
  });
});

describe("hardware wallet card", () => {
  const counts = (p: Partial<Record<"critical" | "high" | "medium" | "low" | "ok", number>>) =>
    ({ counts: { critical: 0, high: 0, medium: 0, low: 0, ok: 0, ...p } });

  it("adds wallet SOL, staked SOL and priced tokens", () => {
    const usd = holdingsUsd(input({
      solPriceUsd: 100,
      walletLamports: 2_000_000_000,
      stakes: [{ address: "s", staker: W, withdrawer: W, lamports: 1_000_000_000 }],
      tokenAccounts: [
        acct({ mint: "usdc", amount: 50_000_000n, decimals: 6 }),
        acct({ mint: "nopr", amount: 9_000_000n, decimals: 6 }),
        acct({ mint: "frz", amount: 1_000_000n, decimals: 6, frozen: true }),
      ],
      assets: { usdc: asset({ mint: "usdc", priced: true, priceUsd: 1 }), frz: asset({ mint: "frz", priced: true, priceUsd: 1000 }) },
    }));
    expect(usd).toBeCloseTo(350);
  });

  it("has no value without a SOL price", () => {
    expect(holdingsUsd(input({ walletLamports: 5_000_000_000 }))).toBeNull();
  });

  it("shows for serious findings, for big wallets, and not for small clean ones", () => {
    expect(hardwareCardReason(counts({ high: 1 }), 10)).toBe("risk");
    expect(hardwareCardReason(counts({ critical: 1 }), null)).toBe("risk");
    expect(hardwareCardReason(counts({ medium: 3 }), 1000)).toBe("value");
    expect(hardwareCardReason(counts({ medium: 3, low: 2 }), 999)).toBeNull();
    expect(hardwareCardReason(counts({}), null)).toBeNull();
  });
});
