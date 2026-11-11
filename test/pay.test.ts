import { describe, expect, it } from "vitest";
import { buildQuotes, extendPaidUntil, GUARD_USD, SKR_MINT, USDC_MINT, verifyPaymentTx, WSOL_MINT, type ParsedTx } from "../worker/pay";

const PAYER = "7Lk1W1R8rz8ZYzvYc7Yx7oqk9kV1uC2Q7u7eQ2Q6n2Qe";
const TREASURY = "B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA";
const MEMO = "sealguard:guard:abc";

function solTx(lamports: number, memo = MEMO, err: unknown = null): ParsedTx {
  return {
    blockTime: 1_762_800_000,
    meta: { err, preBalances: [10_000_000_000, 0], postBalances: [10_000_000_000 - lamports - 5000, lamports] },
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true, writable: true }, { pubkey: TREASURY, signer: false, writable: true }], instructions: [{ programId: "11111111111111111111111111111111" }, { program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: memo }] } },
  };
}
function usdcTx(amount: string): ParsedTx {
  return {
    blockTime: 1_762_800_000,
    meta: {
      err: null, preBalances: [1, 1], postBalances: [1, 1],
      preTokenBalances: [{ accountIndex: 1, mint: USDC_MINT, owner: TREASURY, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 1, mint: USDC_MINT, owner: TREASURY, uiTokenAmount: { amount: String(1_000_000 + Number(amount)) } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: PAYER, signer: true, writable: true }, { pubkey: "ata", signer: false, writable: true }], instructions: [{ program: "spl-memo", programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: MEMO }] } },
  };
}

describe("pay", () => {
  it("quotes US$49 in USDC, SOL and SKR, rounding up", () => {
    expect(GUARD_USD).toBe(49);
    const q = buildQuotes(GUARD_USD, { [WSOL_MINT]: 83.2, [SKR_MINT]: 0.0123 });
    expect(q.find((x) => x.token === "USDC")).toEqual({ token: "USDC", display: "49.00", baseUnits: "49000000" });
    const sol = q.find((x) => x.token === "SOL")!;
    expect(Number(sol.display)).toBeGreaterThanOrEqual(49 / 83.2);
    expect(sol.baseUnits).toBe(String(Math.ceil((49 / 83.2) * 10_000) * 100_000));
    expect(q.find((x) => x.token === "SKR")).toEqual({ token: "SKR", display: "3984", baseUnits: "3984000000" });
    expect(buildQuotes(GUARD_USD, {}).map((x) => x.token)).toEqual(["USDC"]);
  });

  it("verifies SOL and USDC payments and refuses the wrong ones", () => {
    const ok = { payer: PAYER, treasury: TREASURY, token: "SOL" as const, baseUnits: 60_000_000n, memo: MEMO };
    expect(verifyPaymentTx(solTx(60_000_000), ok)).toEqual({ ok: true });
    expect(verifyPaymentTx(solTx(59_000_000), ok)).toMatchObject({ ok: false, reason: "underpaid" });
    expect(verifyPaymentTx(solTx(60_000_000, "other"), ok)).toMatchObject({ ok: false, reason: "wrong_memo" });
    expect(verifyPaymentTx(solTx(60_000_000, MEMO, { InstructionError: [0, "x"] }), ok)).toMatchObject({ ok: false, reason: "tx_failed" });
    expect(verifyPaymentTx(null, ok)).toMatchObject({ ok: false, reason: "not_found" });
    expect(verifyPaymentTx(solTx(60_000_000), { ...ok, paidBy: 1_762_700_000_000 })).toMatchObject({ ok: false, reason: "price_expired" });
    expect(verifyPaymentTx(usdcTx("4990000"), { ...ok, token: "USDC", baseUnits: 4_990_000n })).toEqual({ ok: true });
    expect(verifyPaymentTx(usdcTx("4000000"), { ...ok, token: "USDC", baseUnits: 4_990_000n })).toMatchObject({ ok: false, reason: "underpaid" });
  });

  it("extends a running guard from its end, an expired one from now", () => {
    const now = 1_000_000;
    const year = 365 * 86_400_000;
    expect(extendPaidUntil(null, now)).toBe(now + year);
    expect(extendPaidUntil(now - 5, now)).toBe(now + year);
    expect(extendPaidUntil(now + 100, now)).toBe(now + 100 + year);
  });
});
