import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { checkSignIn, issueToken, makeNonce, nonceIssuedAt, siwsMessage, verifyToken, webhookSecret } from "../worker/auth";

const SECRET = "test-secret-please-change";
const kp = Keypair.generate();
const W = kp.publicKey.toBase58();
const now = 1_762_800_000_000;

describe("auth", () => {
  it("mints nonces that verify and expire", () => {
    const n = makeNonce(SECRET, W, now);
    expect(nonceIssuedAt(SECRET, W, n)).toBe(now);
    expect(nonceIssuedAt(SECRET, "other", n)).toBeNull();
    expect(nonceIssuedAt("other-secret", W, n)).toBeNull();
  });

  it("accepts a correctly signed sign-in and rejects a bad one", async () => {
    const nonce = makeNonce(SECRET, W, now);
    const issuedAt = new Date(now).toISOString();
    const msg = new TextEncoder().encode(siwsMessage(W, nonce, issuedAt));
    const sig = bs58.encode(nacl.sign.detached(msg, kp.secretKey));
    expect(await checkSignIn(SECRET, { wallet: W, nonce, issuedAt, signature: sig }, now + 1000)).toEqual({ ok: true, wallet: W });
    expect((await checkSignIn(SECRET, { wallet: W, nonce, issuedAt, signature: sig }, now + 11 * 60_000)).ok).toBe(false);
    const other = Keypair.generate();
    const badSig = bs58.encode(nacl.sign.detached(msg, other.secretKey));
    expect(await checkSignIn(SECRET, { wallet: W, nonce, issuedAt, signature: badSig }, now)).toMatchObject({ ok: false, reason: "bad_signature" });
  });

  it("issues session tokens that verify, expire and can't be forged", () => {
    const t = issueToken(SECRET, W, now);
    expect(verifyToken(SECRET, t, now + 1000)).toBe(W);
    expect(verifyToken(SECRET, t, now + 31 * 86_400_000)).toBeNull();
    expect(verifyToken("other", t, now)).toBeNull();
    expect(verifyToken(SECRET, t.slice(0, -2) + "zz", now)).toBeNull();
  });

  it("derives a stable webhook secret from the bot token", () => {
    expect(webhookSecret("123:abc")).toBe(webhookSecret("123:abc"));
    expect(webhookSecret("123:abc")).not.toBe(webhookSecret("123:abd"));
    expect(webhookSecret("123:abc")).toMatch(/^[0-9a-f]{32}$/);
  });
});
