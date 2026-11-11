// Turning findings' actions into transactions. The wallet signs them; SealGuard never holds a key.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createBurnInstruction, createCloseAccountInstruction, createRevokeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CLOSE_FEE_BPS, closeFee, type Action, type TokenProgram } from "./scan";

/** 2C Studio's treasury, where the close fee goes (the same wallet the guard subscription is paid to). */
export const TREASURY = new PublicKey("B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA");

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

/** The fee for the empty-account closes in a group: 5% of the rent they return. Other actions are free. */
export function groupFee(group: Action[], bps: number = CLOSE_FEE_BPS): number {
  return closeFee(group.reduce((sum, a) => sum + (a.kind === "close" ? a.lamports : 0), 0), bps);
}

/**
 * The group's instructions, then (when it closes empty accounts) one transfer of the fee to the treasury. The
 * transfer comes last, so it's paid out of the rent the closes just returned; the wallet shows it before signing.
 */
export function buildTransaction(group: Action[], owner: PublicKey, recentBlockhash: string, lastValidBlockHeight: number, opts: { treasury?: PublicKey; feeBps?: number } = {}): Transaction {
  const tx = new Transaction({ feePayer: owner, blockhash: recentBlockhash, lastValidBlockHeight });
  for (const a of group) tx.add(...instructionsFor(a, owner));
  const fee = groupFee(group, opts.feeBps ?? CLOSE_FEE_BPS);
  if (fee > 0) tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: opts.treasury ?? TREASURY, lamports: fee }));
  return tx;
}

/** The line shown for the fee in the "what will be sent" list. */
export function describeFee(lamports: number): string {
  return `Send SealGuard's ${CLOSE_FEE_BPS / 100}% fee on the returned rent (${(lamports / 1e9).toFixed(9).replace(/0+$/, "")} SOL) to 2C Studio's wallet ${TREASURY.toBase58()}`;
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
