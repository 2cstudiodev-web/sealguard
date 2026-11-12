// Turning findings' actions into transactions. The wallet signs them; SealGuard never holds a key.
import { PublicKey, SystemProgram, Transaction, TransactionInstruction } from "@solana/web3.js";
import { createBurnInstruction, createCloseAccountInstruction, createRevokeInstruction, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CLOSE_FEE_BPS, closeFee, PUMP_PROGRAMS, rentOf, type Action, type TokenProgram } from "./scan";

/** Anchor discriminator of close_user_volume_accumulator (pump and pump_amm IDLs). */
const CLOSE_PUMP_ACCUMULATOR = new Uint8Array([249, 69, 164, 218, 150, 103, 84, 138]);

/** 2C Studio's treasury, where the close fee goes (the same wallet the guard subscription is paid to). */
export const TREASURY = new PublicKey("B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA");

/** Actions per transaction in the simple splitter (kept for callers that don't pack by size). */
export const MAX_ACTIONS_PER_TX = 10;
/** Solana's packet limit for a signed transaction, and the most actions we put in one (compute stays well under 200k). */
export const TX_SIZE_LIMIT = 1232;
/** Room left for instructions some wallets add before signing (priority fee, Lighthouse guards). */
export const TX_HEADROOM = 150;
export const MAX_ACTIONS_PACKED = 26;
/** Transactions a wallet is asked to approve at once. */
export const TXS_PER_APPROVAL = 20;

export function programId(p: TokenProgram): PublicKey {
  return p === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/** Splits actions into groups that fit one transaction each, keeping the order. */
export function batchActions(actions: Action[], max = MAX_ACTIONS_PER_TX): Action[][] {
  const out: Action[][] = [];
  for (let i = 0; i < actions.length; i += max) out.push(actions.slice(i, i + max));
  return out;
}

/**
 * Splits actions into transactions as full as Solana allows: each group, built with its fee transfer and a
 * placeholder blockhash, must serialize (with its one signature) within TX_SIZE_LIMIT. Keeps the order.
 */
export function packActions(actions: Action[], owner: PublicKey, opts: { treasury?: PublicKey; feeBps?: number } = {}): Action[][] {
  // web3.js refuses to serialize an oversized transaction (it throws), which also means "doesn't fit".
  const fits = (g: Action[]) => {
    try { return buildTransaction(g, owner, "11111111111111111111111111111111", 0, opts).serialize({ requireAllSignatures: false, verifySignatures: false }).length <= TX_SIZE_LIMIT - TX_HEADROOM; } catch { return false; }
  };
  const out: Action[][] = [];
  let cur: Action[] = [];
  for (const a of actions) {
    const next = [...cur, a];
    if (cur.length && (next.length > MAX_ACTIONS_PACKED || !fits(next))) {
      out.push(cur);
      cur = [a];
    } else {
      cur = next;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Metaplex Token Metadata program and the BurnV1 instruction (Burn = 41, BurnArgs::V1 = 0, amount u64). */
export const TOKEN_METADATA_PROGRAM = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
function burnNftData(): Buffer {
  const d = Buffer.alloc(10);
  d.writeUInt8(41, 0); d.writeUInt8(0, 1); d.writeBigUInt64LE(1n, 2);
  return d;
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
    case "burnNft": {
      // BurnV1 accounts in order; an optional account left out is passed as the program id itself.
      const none = { pubkey: TOKEN_METADATA_PROGRAM, isSigner: false, isWritable: false };
      const w = (k: string) => ({ pubkey: new PublicKey(k), isSigner: false, isWritable: true });
      return [new TransactionInstruction({
        programId: TOKEN_METADATA_PROGRAM,
        data: burnNftData(),
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },        // authority, receives the lamports
          a.collectionMetadata ? w(a.collectionMetadata) : none,      // collection metadata
          w(a.metadata),
          w(a.edition),                                               // master edition
          w(a.mint),
          w(a.tokenAccount),
          none, none, none, none,                                     // master edition / its mint / its token / edition marker (print editions only)
          a.tokenRecord ? w(a.tokenRecord) : none,                    // token record (programmable NFTs)
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
          { pubkey: programId("token"), isSigner: false, isWritable: false },
        ],
      })];
    }
    case "withdrawNonce":
      return [SystemProgram.nonceWithdraw({ noncePubkey: new PublicKey(a.nonceAccount), authorizedPubkey: owner, toPubkey: owner, lamports: a.lamports })];
    case "closePump": {
      // close_user_volume_accumulator: the user signs and receives every lamport in the account.
      const program = new PublicKey(PUMP_PROGRAMS[a.program].id);
      const [eventAuthority] = PublicKey.findProgramAddressSync([new TextEncoder().encode("__event_authority")], program);
      return [new TransactionInstruction({
        programId: program,
        data: Buffer.from(CLOSE_PUMP_ACCUMULATOR),
        keys: [
          { pubkey: owner, isSigner: true, isWritable: true },
          { pubkey: new PublicKey(a.account), isSigner: false, isWritable: true },
          { pubkey: eventAuthority, isSigner: false, isWritable: false },
          { pubkey: program, isSigner: false, isWritable: false },
        ],
      })];
    }
  }
}

/** The fee for the empty-account closes in a group: 5% of the rent they return. Other actions are free. */
export function groupFee(group: Action[], bps: number = CLOSE_FEE_BPS): number {
  return closeFee(group.reduce((sum, a) => sum + rentOf(a), 0), bps);
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
    case "closePump": return `Close your ${PUMP_PROGRAMS[a.program].name} volume account ${a.account} and return its ${a.lamports} lamports to you`;
    case "burnNft": return `Burn NFT ${a.mint} and return its rent (${a.lamports} lamports) to you`;
  }
}
