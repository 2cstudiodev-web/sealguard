import { describe, expect, it } from "vitest";
import { diffWatch, formatAlerts, watchState } from "../shared/watch";
import { SYSTEM_PROGRAM, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const OTHER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: "acct", mint: "mint", program: "token", amount: 1n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p });

describe("watch", () => {
  it("captures only the parts a thief changes", () => {
    const s = watchState(input({
      tokenAccounts: [acct({ address: "a", delegate: OTHER, delegatedAmount: 5n }), acct({ address: "b", delegate: OTHER, delegatedAmount: 0n }), acct({ address: "c", frozen: true })],
      stakes: [{ address: "s1", staker: W, withdrawer: OTHER, lamports: 1 }, { address: "s2", staker: OTHER, withdrawer: W, lamports: 1 }],
      nonces: [{ address: "n1", authority: W, lamports: 1 }],
    }));
    expect(s.delegates).toEqual({ a: OTHER });
    expect(s.stakeWithdrawers).toEqual({ s1: OTHER });
    expect(s.nonces).toEqual(["n1"]);
    expect(s.frozen).toEqual(["c"]);
    expect(s.owner).toBe(SYSTEM_PROGRAM);
  });

  it("alerts on new approvals, owner change, nonces and phishing, but not on improvements", () => {
    const before = watchState(input({ tokenAccounts: [acct({ address: "a", delegate: OTHER, delegatedAmount: 5n })] }));
    const after = watchState(input({
      walletOwner: OTHER,
      tokenAccounts: [acct({ address: "b", delegate: OTHER, delegatedAmount: 5n }), acct({ address: "p", mint: "pm" })],
      assets: { pm: { mint: "pm", name: "jupfinally.com 🎁 Airdrop", symbol: "", description: "", jsonUri: "", kind: "FungibleToken", priced: false } },
      nonces: [{ address: "n1", authority: W, lamports: 1 }],
    }));
    const alerts = diffWatch(before, after, W);
    expect(alerts.map((a) => a.severity)).toEqual(["critical", "high", "medium", "medium"]);
    expect(alerts[0].text).toContain("owner was changed");
    // Revoking the old approval on "a" produced no alert.
    expect(diffWatch(after, before, W).filter((a) => a.severity === "high")).toHaveLength(1); // "a" is new relative to after
    expect(diffWatch(before, before, W)).toEqual([]);
  });

  it("formats a Telegram message", () => {
    const msg = formatAlerts(W, [{ severity: "high", text: "New approval: x <y>" }], (s) => s.replace(/</g, "&lt;"));
    expect(msg).toContain("<b>SealGuard</b>");
    expect(msg).toContain("⚠️ New approval: x &lt;y>");
    expect(msg).toContain("guard.2cstudio.app");
  });
});
