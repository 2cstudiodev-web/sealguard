// Turning findings' actions into transactions. The wallet signs them; SealGuard never holds a key.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createBurnInstruction, createCloseAccountInstruction, createRevokeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { Action, TokenProgram } from "./scan";

/** Actions per transaction. Revoke/close are tiny; burn+close is two instructions. 10 keeps every mix well under the size limit. */
export const MAX_ACTIONS_PER_TX = 10;

export function programId(p: TokenProgram): PublicKey {
  return p === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Splits actions into groups that fit one transaction each, keeping the order. */
export function batchActions(actions: Action[], max = MAX_ACTIONS_PER_TX): Action[][] {
  const out: Action[][] = [];
  for (let i = 0; i < actions.length; i += max) out.push(actions.slice(i, i + max));
  return out;
}

/** The instructions one action needs, in order. */
export function instructionsFor(a: Action, owner: PublicKey): TransactionInstruction[] {
  switch (a.kind) {
    case "revoke":
      return [createRevokeInstruction(new PublicKey(a.tokenAccount), owner, [], programId(a.program))];
    case "close":
      return [createCloseAccountInstruction(new PublicKey(a.tokenAccount), owner, owner, [], programId(a.program))];
    case "burnClose":
      return [
        createBurnInstruction(new PublicKey(a.tokenAccount), new PublicKey(a.mint), owner, a.amount, [], programId(a.program)),
        createCloseAccountInstruction(new PublicKey(a.tokenAccount), owner, owner, [], programId(a.program)),
      ];
    case "withdrawNonce":
      return [SystemProgram.nonceWithdraw({ noncePubkey: new PublicKey(a.nonceAccount), authorizedPubkey: owner, toPubkey: owner, lamports: a.lamports })];
  }
}

export function buildTransaction(group: Action[], owner: PublicKey, recentBlockhash: string, lastValidBlockHeight: number): Transaction {
  const tx = new Transaction({ feePayer: owner, blockhash: recentBlockhash, lastValidBlockHeight });
  for (const a of group) tx.add(...instructionsFor(a, owner));
  return tx;
}

/** One line per action for the "what you're about to sign" list. */
export function describeAction(a: Action): string {
  switch (a.kind) {
    case "revoke": return `Revoke the approval on token account ${a.tokenAccount}`;
    case "close": return `Close empty token account ${a.tokenAccount} and return its rent to you`;
    case "burnClose": return `Burn ${a.amount.toString()} base units of ${a.mint} and close its account`;
    case "withdrawNonce": return `Withdraw nonce account ${a.nonceAccount} (${a.lamports} lamports) to you`;
  }
}
