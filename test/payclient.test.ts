import { describe, expect, it } from "vitest";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { MEMO_PROGRAM, paymentInstructions, paymentTransaction } from "../web/src/payclient";

const payer = Keypair.generate().publicKey;
const treasury = Keypair.generate().publicKey;

describe("payment transaction", () => {
  it("SOL: a transfer plus the memo, signed only by the payer", () => {
    const ix = paymentInstructions("SOL", 60_000_000n, payer, treasury, "sealguard:guard:x");
    expect(ix).toHaveLength(2);
    expect(ix[0].programId.equals(SystemProgram.programId)).toBe(true);
    expect(ix[1].programId.equals(MEMO_PROGRAM)).toBe(true);
    expect(Buffer.from(ix[1].data).toString()).toBe("sealguard:guard:x");
    const tx = paymentTransaction("SOL", 60_000_000n, payer, treasury, "m", "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 1);
    const msg = tx.compileMessage();
    expect(msg.accountKeys.slice(0, msg.header.numRequiredSignatures).every((k) => k.equals(payer))).toBe(true);
  });

  it("USDC: creates the treasury's token account if needed, then transferChecked, then the memo", () => {
    const ix = paymentInstructions("USDC", 4_990_000n, payer, treasury, "m");
    expect(ix).toHaveLength(3);
    expect(ix[1].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(ix[2].programId.equals(MEMO_PROGRAM)).toBe(true);
  });

  it("refuses unknown tokens", () => {
    expect(() => paymentInstructions("DOGE", 1n, payer, treasury, "m")).toThrow(/Unknown token/);
  });
});
