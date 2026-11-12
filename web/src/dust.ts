// Selling a small balance for SOL: a Jupiter swap (Swap API V2 /build: raw instructions, Metis routing, no Jupiter
// fee), then the close of the emptied token account and SealGuard's fee, all in one v0 transaction. Built at fix time
// because a quote only lasts seconds; the wallet shows the whole transaction before the owner signs it.
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createCloseAccountInstruction } from "@solana/spl-token";
import { closeFee, type Action } from "./scan";
import { programId, TREASURY, TX_HEADROOM, TX_SIZE_LIMIT } from "./tx";

export const JUPITER_BUILD = "https://api.jup.ag/swap/v2/build";
export const WSOL = "So11111111111111111111111111111111111111112";
/** Jupiter's keyless limit is one call every two seconds per visitor; callers wait this long between sales. */
export const JUPITER_GAP_MS = 2100;
const CU_MAX = 1_400_000;

type SellDust = Extract<Action, { kind: "sellDust" }>;
type ApiIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export type DustBuild =
  | { ok: true; tx: VersionedTransaction; outLamports: number; feeLamports: number }
  | { ok: false; reason: "noroute" | "refused" };

const ix = (i: ApiIx) => new TransactionInstruction({
  programId: new PublicKey(i.programId),
  keys: i.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
  data: Buffer.from(i.data, "base64"),
});

/** Asks Jupiter for the swap; null when it has no route (or doesn't answer). One retry after a rate limit. */
async function fetchBuild(a: SellDust, owner: PublicKey, maxBytes: number, fetchFn: typeof fetch): Promise<any | null> {
  const q = new URLSearchParams({
    inputMint: a.mint, outputMint: WSOL, amount: a.amount.toString(), taker: owner.toBase58(),
    slippageBps: "rtse", maxBytes: String(maxBytes),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetchFn(`${JUPITER_BUILD}?${q}`, { signal: AbortSignal.timeout(15_000) });
      if (r.status === 429 && attempt === 0) { await new Promise((ok) => setTimeout(ok, JUPITER_GAP_MS + 500)); continue; }
      if (!r.ok) return null;
      const b: any = await r.json();
      return b?.swapInstruction && b?.otherAmountThreshold ? b : null;
    } catch { return null; }
  }
  return null;
}

function compile(b: any, a: SellDust, owner: PublicKey, blockhash: string, units: number, fee: number, treasury: PublicKey): VersionedTransaction {
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ...(b.computeBudgetInstructions ?? []).filter((i: ApiIx) => Buffer.from(i.data, "base64")[0] !== 2).map(ix), // Jupiter's price; the limit is ours
    ...(b.setupInstructions ?? []).map(ix),
    ix(b.swapInstruction),
    ...(b.cleanupInstruction ? [ix(b.cleanupInstruction)] : []),
    ...(b.otherInstructions ?? []).map(ix),
    // The swap sold the whole balance, so the account is empty: close it, rent back to the owner.
    createCloseAccountInstruction(new PublicKey(a.tokenAccount), owner, owner, [], programId(a.program)),
    ...(fee > 0 ? [SystemProgram.transfer({ fromPubkey: owner, toPubkey: treasury, lamports: fee })] : []),
  ];
  const alts = Object.entries((b.addressesByLookupTableAddress ?? {}) as Record<string, string[]>).map(([key, addresses]) => new AddressLookupTableAccount({
    key: new PublicKey(key),
    state: { deactivationSlot: BigInt("18446744073709551615"), lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0, addresses: addresses.map((x) => new PublicKey(x)) },
  }));
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  return new VersionedTransaction(msg);
}

/**
 * The sale of one small balance as a ready-to-sign transaction, simulated first. The fee is SealGuard's share of what
 * comes back: the least SOL the swap may return (Jupiter's otherAmountThreshold, after slippage) plus the account's
 * rent, so a worse fill never raises it.
 */
export async function buildDustTx(
  a: SellDust, owner: PublicKey,
  opts: { feeBps: number; blockhash: string; rpc: Rpc; fetchFn?: typeof fetch; treasury?: PublicKey },
): Promise<DustBuild> {
  const fetchFn = opts.fetchFn ?? ((i, o) => fetch(i, o));
  const treasury = opts.treasury ?? TREASURY;
  for (const maxBytes of [950, 750]) {
    const b = await fetchBuild(a, owner, maxBytes, fetchFn);
    if (!b) return { ok: false, reason: "noroute" };
    const outLamports = Number(b.otherAmountThreshold);
    const feeLamports = closeFee(outLamports + a.rent, opts.feeBps);
    let tx: VersionedTransaction;
    try {
      tx = compile(b, a, owner, opts.blockhash, CU_MAX, feeLamports, treasury);
      if (tx.serialize().length > TX_SIZE_LIMIT - TX_HEADROOM) continue; // try a smaller route
    } catch { continue; } // too large to serialize at all
    const sim = await opts.rpc<any>("simulateTransaction", [Buffer.from(tx.serialize()).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
    if (sim?.value?.err) return { ok: false, reason: "refused" };
    const used = Number(sim?.value?.unitsConsumed ?? 0);
    const units = used > 0 ? Math.min(CU_MAX, Math.ceil(used * 1.2) + 10_000) : CU_MAX;
    return { ok: true, tx: compile(b, a, owner, opts.blockhash, units, feeLamports, treasury), outLamports, feeLamports };
  }
  return { ok: false, reason: "refused" };
}
