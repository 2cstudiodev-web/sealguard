// The guard's yearly fee: a quote in USDC, SOL or SKR with a memo, paid by the wallet itself, checked on chain.
// Same shape as SealDraw's hosting payments.
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SKR_MINT = "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const PRICE_URL = "https://lite-api.jup.ag/price/v3?ids=";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

export type PayToken = "USDC" | "SOL" | "SKR";
export const PAY_TOKENS: PayToken[] = ["USDC", "SOL", "SKR"];
export const TOKEN_DECIMALS: Record<PayToken, number> = { USDC: 6, SOL: 9, SKR: 6 };
export const GUARD_USD = 4.99;
export const GUARD_DAYS = 365;
/** A quote's price is good for this long; the payment may land a little later. */
export const QUOTE_TTL_MS = 15 * 60 * 1000;
export const PAY_SLACK_MS = 10 * 60 * 1000;

export function mintOf(token: PayToken): string {
  return token === "USDC" ? USDC_MINT : token === "SKR" ? SKR_MINT : WSOL_MINT;
}

export type Quote = { token: PayToken; display: string; baseUnits: string };

/** USD prices from Jupiter, keyed by mint. Missing or failed = no quote for that token. */
export async function jupiterPrices(mints: string[], fetchFn: typeof fetch = (i, o) => fetch(i, o), priceUrl = PRICE_URL): Promise<Record<string, number>> {
  try {
    const res = await fetchFn(priceUrl + mints.join(","), { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return {};
    const json: any = await res.json();
    const out: Record<string, number> = {};
    for (const m of mints) {
      const p = Number(json?.[m]?.usdPrice);
      if (p > 0) out[m] = p;
    }
    return out;
  } catch {
    return {};
  }
}

/** The three ways to pay `usd`, from the prices we have. SOL to 4 decimals, SKR to whole tokens, both rounded up. */
export function buildQuotes(usd: number, prices: Record<string, number>): Quote[] {
  const out: Quote[] = [];
  const micro = BigInt(Math.ceil(usd * 1_000_000));
  out.push({ token: "USDC", display: usd.toFixed(2), baseUnits: micro.toString() });
  if (prices[WSOL_MINT]) {
    const sol4 = Math.ceil((usd / prices[WSOL_MINT]) * 10_000);
    out.push({ token: "SOL", display: (sol4 / 10_000).toFixed(4), baseUnits: (BigInt(sol4) * 100_000n).toString() });
  }
  if (prices[SKR_MINT]) {
    const skr = Math.ceil(usd / prices[SKR_MINT]);
    out.push({ token: "SKR", display: String(skr), baseUnits: (BigInt(skr) * 10n ** BigInt(TOKEN_DECIMALS.SKR)).toString() });
  }
  return out;
}

export interface ParsedTx {
  slot?: number;
  blockTime?: number | null;
  meta: { err: unknown; preBalances: number[]; postBalances: number[]; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null;
  transaction: { message: { accountKeys: { pubkey: string; signer: boolean; writable: boolean }[]; instructions: { program?: string; programId: string; parsed?: unknown }[] } };
}
interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }

export interface ExpectedPayment { payer: string; treasury: string; token: PayToken; baseUnits: bigint; memo: string; paidBy?: number }
export type PaymentCheck = { ok: true } | { ok: false; reason: string };

/** Is tx a successful payment of at least baseUnits of token from payer to treasury, carrying memo? Reads balances, not instructions. */
export function verifyPaymentTx(tx: ParsedTx | null, expect: ExpectedPayment): PaymentCheck {
  if (!tx || !tx.meta) return { ok: false, reason: "not_found" };
  if (tx.meta.err) return { ok: false, reason: "tx_failed" };
  if (expect.paidBy !== undefined && typeof tx.blockTime === "number" && tx.blockTime * 1000 > expect.paidBy) return { ok: false, reason: "price_expired" };
  const keys = tx.transaction.message.accountKeys;
  if (!keys.some((k) => k.signer && k.pubkey === expect.payer)) return { ok: false, reason: "wrong_payer" };
  const memos = tx.transaction.message.instructions
    .filter((ix) => ix.program === "spl-memo" || ix.programId === MEMO_PROGRAM)
    .map((ix) => (typeof ix.parsed === "string" ? ix.parsed : ""));
  if (!memos.includes(expect.memo)) return { ok: false, reason: "wrong_memo" };
  let received = 0n;
  if (expect.token === "SOL") {
    const i = keys.findIndex((k) => k.pubkey === expect.treasury);
    if (i < 0) return { ok: false, reason: "wrong_recipient" };
    received = BigInt(tx.meta.postBalances[i] ?? 0) - BigInt(tx.meta.preBalances[i] ?? 0);
  } else {
    const mint = mintOf(expect.token);
    const sum = (list: TokenBalance[] | undefined) => (list ?? []).filter((b) => b.mint === mint && b.owner === expect.treasury).reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
    received = sum(tx.meta.postTokenBalances) - sum(tx.meta.preTokenBalances);
    if (received === 0n && !(tx.meta.postTokenBalances ?? []).some((b) => b.owner === expect.treasury && b.mint === mint)) return { ok: false, reason: "wrong_recipient" };
  }
  if (received < expect.baseUnits) return { ok: false, reason: "underpaid" };
  return { ok: true };
}

/** Paid-until after a payment: a year from now, or from the current end if the guard is still running. */
export function extendPaidUntil(current: number | null, now: number, days = GUARD_DAYS): number {
  return Math.max(current ?? 0, now) + days * 86_400_000;
}
