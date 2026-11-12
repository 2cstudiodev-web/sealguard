import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { looksSecret } from "../web/src/secret";

describe("looksSecret", () => {
  it("passes public addresses and other public strings", () => {
    expect(looksSecret("JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2")).toBe(false);
    expect(looksSecret("B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA")).toBe(false);
    expect(looksSecret("")).toBe(false);
    expect(looksSecret("hello there")).toBe(false);
    // A transaction signature is also 64 bytes of base58, but not a key pair.
    expect(looksSecret(bs58.encode(Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256)))).toBe(false);
  });
  it("catches seed phrases, including a word short", () => {
    const twelve = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    expect(looksSecret(twelve)).toBe(true);
    expect(looksSecret(twelve.split(" ").slice(0, 11).join(" "))).toBe(true);
    expect(looksSecret((twelve + " " + twelve).toUpperCase())).toBe(true);
  });
  it("catches private keys in the usual formats", () => {
    const sk = Keypair.generate().secretKey;
    expect(looksSecret(bs58.encode(sk))).toBe(true);
    expect(looksSecret(JSON.stringify(Array.from(sk)))).toBe(true);
    expect(looksSecret(Array.from(sk, (b) => b.toString(16).padStart(2, "0")).join(""))).toBe(true);
  });
});
