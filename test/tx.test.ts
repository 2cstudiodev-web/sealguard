import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { batchActions, buildTransaction, describeAction, instructionsFor } from "../web/src/tx";
import type { Action } from "../web/src/scan";

const owner = Keypair.generate().publicKey;
const ta = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();

describe("tx", () => {
  it("batches actions ten per transaction", () => {
    const acts: Action[] = Array.from({ length: 23 }, () => ({ kind: "close", tokenAccount: ta, mint, program: "token", lamports: 2_039_280 }));
    expect(batchActions(acts).map((g) => g.length)).toEqual([10, 10, 3]);
    expect(batchActions([])).toEqual([]);
  });

  it("builds the right instructions for each action", () => {
    const rev = instructionsFor({ kind: "revoke", tokenAccount: ta, mint, program: "token" }, owner);
    expect(rev).toHaveLength(1);
    expect(rev[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const close22 = instructionsFor({ kind: "close", tokenAccount: ta, mint, program: "token2022", lamports: 2_039_280 }, owner);
    expect(close22[0].programId.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
    // Close sends the rent to the owner.
    expect(close22[0].keys[1].pubkey.equals(owner)).toBe(true);
    const bc = instructionsFor({ kind: "burnClose", tokenAccount: ta, mint, program: "token", amount: 5n }, owner);
    expect(bc).toHaveLength(2);
    const nonce = instructionsFor({ kind: "withdrawNonce", nonceAccount: ta, lamports: 123 }, owner);
    expect(nonce[0].programId.equals(new PublicKey("11111111111111111111111111111111"))).toBe(true);
  });

  it("builds a transaction with the owner as fee payer and every signer being the owner", () => {
    const tx = buildTransaction(
      [{ kind: "revoke", tokenAccount: ta, mint, program: "token" }, { kind: "close", tokenAccount: ta, mint, program: "token", lamports: 2_039_280 }],
      owner, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 100,
    );
    expect(tx.feePayer!.equals(owner)).toBe(true);
    // revoke, close, then the 5% fee on the closed account's rent
    expect(tx.instructions).toHaveLength(3);
    const signers = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
    expect(signers.every((k) => k.equals(owner))).toBe(true);
  });

  it("describes actions in plain words", () => {
    expect(describeAction({ kind: "close", tokenAccount: ta, mint, program: "token", lamports: 2_039_280 })).toContain("Close empty token account");
  });
});

describe("close fee", () => {
  it("adds one transfer of 5% of the returned rent to the treasury, after the closes", async () => {
    const { groupFee, TREASURY } = await import("../web/src/tx");
    const closes: Action[] = Array.from({ length: 4 }, () => ({ kind: "close", tokenAccount: ta, mint, program: "token", lamports: 2_039_280 }));
    expect(groupFee(closes)).toBe(Math.floor(4 * 2_039_280 * 0.05));
    const tx = buildTransaction(closes, owner, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 1);
    expect(tx.instructions).toHaveLength(5);
    const last = tx.instructions[4];
    expect(last.programId.equals(new PublicKey("11111111111111111111111111111111"))).toBe(true);
    expect(last.keys[1].pubkey.equals(TREASURY)).toBe(true);
    // lamports are a little-endian u64 after the 4-byte instruction index
    expect(Number(Buffer.from(last.data).readBigUInt64LE(4))).toBe(Math.floor(4 * 2_039_280 * 0.05));
  });

  it("charges nothing for revokes, burns and nonce withdrawals", async () => {
    const { groupFee } = await import("../web/src/tx");
    const free: Action[] = [
      { kind: "revoke", tokenAccount: ta, mint, program: "token" },
      { kind: "burnClose", tokenAccount: ta, mint, program: "token", amount: 5n },
      { kind: "withdrawNonce", nonceAccount: ta, lamports: 1_500_000 },
    ];
    expect(groupFee(free)).toBe(0);
    expect(buildTransaction(free, owner, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 1).instructions).toHaveLength(4);
  });
});
