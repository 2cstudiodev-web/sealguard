// Token-2022 restrictions: a priced token whose only restriction is a transfer hook (PYUSD) is a note; others warn.
import { describe, expect, it } from "vitest";
import { scan, SYSTEM_PROGRAM, type ScanInput, type TokenAcct } from "../web/src/scan";

const W = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const acct: TokenAcct = { address: "ta", mint: "m", program: "token2022", amount: 5_000_000n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false };
const input = (priced: boolean, extensions: string[]): ScanInput => ({
  wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [acct], stakes: [], nonces: [],
  mints: { m: { address: "m", program: "token2022", extensions } } as any,
  assets: { m: { mint: "m", name: "PayPal USD", symbol: "PYUSD", description: "", jsonUri: "", kind: "FungibleToken", priced, priceUsd: priced ? 1 : null } },
});

describe("restrictions built into a token", () => {
  it("a priced token with only a transfer hook is a note that doesn't lower the score", () => {
    const r = scan(input(true, ["transferHook"]));
    const f = r.findings.find((x) => x.check === "mintExtensions")!;
    expect(f.severity).toBe("ok");
    expect(f.title).toBe("PayPal USD (PYUSD) runs a program on every transfer");
    expect(r.score).toBe(100);
  });
  it("an unpriced token with a transfer hook still warns, in plain grammar", () => {
    const f = scan(input(false, ["transferHook"])).findings.find((x) => x.check === "mintExtensions")!;
    expect(f.severity).toBe("low");
    expect(f.detail).toMatch(/^The token has a transfer hook/);
  });
});
