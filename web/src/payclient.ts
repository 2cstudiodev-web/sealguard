// Building the guard payment in the browser: a plain transfer to the treasury with the quote's memo, which the
// wallet signs. Mirrors worker/pay.ts's verifyPaymentTx: balances to the treasury plus the memo instruction.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const MINTS: Record<string, { mint: string; decimals: number }> = {
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
  SKR: { mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", decimals: 6 },
};

export function memoInstruction(memo: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [{ pubkey: signer, isSigner: true, isWritable: false }], data: Buffer.from(memo, "utf8") });
}

export function paymentInstructions(token: string, baseUnits: bigint, payer: PublicKey, treasury: PublicKey, memo: string): TransactionInstruction[] {
  if (token === "SOL") return [SystemProgram.transfer({ fromPubkey: payer, toPubkey: treasury, lamports: baseUnits }), memoInstruction(memo, payer)];
  const t = MINTS[token];
  if (!t) throw new Error(`Unknown token ${token}`);
  const mint = new PublicKey(t.mint);
  const from = getAssociatedTokenAddressSync(mint, payer);
  const to = getAssociatedTokenAddressSync(mint, treasury);
  return [
    createAssociatedTokenAccountIdempotentInstruction(payer, to, treasury, mint),
    createTransferCheckedInstruction(from, mint, to, payer, baseUnits, t.decimals),
    memoInstruction(memo, payer),
  ];
}

export function paymentTransaction(token: string, baseUnits: bigint, payer: PublicKey, treasury: PublicKey, memo: string, blockhash: string, lastValidBlockHeight: number): Transaction {
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight });
  tx.add(...paymentInstructions(token, baseUnits, payer, treasury, memo));
  return tx;
}
