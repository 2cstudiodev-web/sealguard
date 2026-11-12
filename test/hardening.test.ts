// Security review fixes, 12 Nov 2026.
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { checkSignIn, makeNonce, siwsMessage } from "../worker/auth";
import { gpaFiltersOk } from "../worker/index";
import { verifyPaymentTx } from "../worker/pay";

const STAKE = "Stake11111111111111111111111111111111111111";
const SYSTEM = "11111111111111111111111111111111";
const W = "B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA";

describe("/rpc getProgramAccounts filters", () => {
  it("allows only the page's own two lookups", () => {
    expect(gpaFiltersOk(STAKE, [{ memcmp: { offset: 12, bytes: W } }])).toBe(true);
    expect(gpaFiltersOk(STAKE, [{ memcmp: { offset: 44, bytes: W } }])).toBe(true);
    expect(gpaFiltersOk(SYSTEM, [{ dataSize: 80 }, { memcmp: { offset: 8, bytes: W } }])).toBe(true);
  });
  it("refuses broad or odd filters", () => {
    expect(gpaFiltersOk(STAKE, [{ memcmp: { offset: 0, bytes: "3" } }])).toBe(false);
    expect(gpaFiltersOk(STAKE, [{ memcmp: { offset: 12, bytes: "3" } }])).toBe(false);
    expect(gpaFiltersOk(STAKE, [{ memcmp: { offset: 12, bytes: W } }, { memcmp: { offset: 44, bytes: W } }])).toBe(false);
    expect(gpaFiltersOk(SYSTEM, [{ memcmp: { offset: 8, bytes: W } }])).toBe(false);
    expect(gpaFiltersOk(SYSTEM, [{ dataSize: 80 }, { memcmp: { offset: 8, bytes: W, encoding: "base64" } }])).toBe(false);
    expect(gpaFiltersOk(STAKE, undefined)).toBe(false);
  });
});

describe("payments", () => {
  const tx = (blockTime: number | null) => ({ blockTime, meta: { err: null }, transaction: { message: { accountKeys: [], instructions: [] } } }) as any;
  it("treats a payment without a block time yet as still confirming, not as on time", () => {
    expect(verifyPaymentTx(tx(null), { payer: W, treasury: W, token: "USDC", baseUnits: 1n, memo: "m", paidBy: 1000 })).toEqual({ ok: false, reason: "pending" });
  });
  it("refuses a payment that landed after the quote ran out", () => {
    expect(verifyPaymentTx(tx(5), { payer: W, treasury: W, token: "USDC", baseUnits: 1n, memo: "m", paidBy: 1000 })).toEqual({ ok: false, reason: "price_expired" });
  });
});

describe("sign-in", () => {
  it("accepts only the Issued At time that came with the nonce", async () => {
    const kp = Keypair.generate(), wallet = kp.publicKey.toBase58(), now = Date.now();
    const nonce = makeNonce("s", wallet, now);
    const sign = (issuedAt: string) => bs58.encode(nacl.sign.detached(new TextEncoder().encode(siwsMessage(wallet, nonce, issuedAt)), kp.secretKey));
    const good = new Date(now).toISOString(), other = new Date(now - 60_000).toISOString();
    expect((await checkSignIn("s", { wallet, nonce, issuedAt: good, signature: sign(good) }, now)).ok).toBe(true);
    expect(await checkSignIn("s", { wallet, nonce, issuedAt: other, signature: sign(other) }, now)).toEqual({ ok: false, reason: "bad_nonce" });
  });
});
