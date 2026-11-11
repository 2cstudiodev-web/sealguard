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
    const acts: Action[] = Array.from({ length: 23 }, () => ({ kind: "close", tokenAccount: ta, mint, program: "token" }));
    expect(batchActions(acts).map((g) => g.length)).toEqual([10, 10, 3]);
    expect(batchActions([])).toEqual([]);
  });

  it("builds the right instructions for each action", () => {
    const rev = instructionsFor({ kind: "revoke", tokenAccount: ta, mint, program: "token" }, owner);
    expect(rev).toHaveLength(1);
    expect(rev[0].programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    const close22 = instructionsFor({ kind: "close", tokenAccount: ta, mint, program: "token2022" }, owner);
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
      [{ kind: "revoke", tokenAccount: ta, mint, program: "token" }, { kind: "close", tokenAccount: ta, mint, program: "token" }],
      owner, "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", 100,
    );
    expect(tx.feePayer!.equals(owner)).toBe(true);
    expect(tx.instructions).toHaveLength(2);
    const signers = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures);
    expect(signers.every((k) => k.equals(owner))).toBe(true);
  });

  it("describes actions in plain words", () => {
    expect(describeAction({ kind: "close", tokenAccount: ta, mint, program: "token" })).toContain("Close empty token account");
  });
});
