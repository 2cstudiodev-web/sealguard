// check_transaction: before an AI agent (or a person) signs a Solana transaction, SealGuard simulates it and compares
// the signing wallet's accounts before and after. What it looks for:
//   - the wallet account itself handed to another program (System Assign): the wallet is lost;
//   - a token account's owner, approval (delegate) or close authority given to someone else;
//   - stake or nonce authorities moved to another address;
//   - SOL and tokens leaving, and whether anything comes back;
//   - a durable nonce (a signed transaction that can be held and sent later), programs SealGuard doesn't know.
// Every account a transaction touches, including through other programs, has to be listed in it, so reading the
// writable ones before and after the simulation covers everything the transaction can change.
// Pure parts (decoding, the analysis) are exported for test/txcheck.test.ts; checkTransaction() does the RPC reads.
import { AddressLookupTableAccount, PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { RpcCall } from "../shared/chain";

export const SYSTEM = "11111111111111111111111111111111";
export const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const STAKE = "Stake11111111111111111111111111111111111111";
const U64_MAX = 18_446_744_073_709_551_615n;

/** Programs SealGuard recognises. Anything else is listed as "not in SealGuard's list", which is not a warning by itself. */
export const KNOWN_PROGRAMS: Record<string, string> = {
  [SYSTEM]: "System Program",
  [TOKEN]: "SPL Token",
  [TOKEN_2022]: "Token-2022",
  [STAKE]: "Stake Program",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: "Memo (v1)",
  AddressLookupTab1e1111111111111111111111111: "Address Lookup Table",
  L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95: "Lighthouse (wallet guard assertions)",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter Aggregator v6",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "Raydium CLMM",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "Raydium CPMM",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpools",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "Meteora DLMM",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "Meteora Pools",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "PumpSwap",
  metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s: "Metaplex Token Metadata",
};

// ---------- decoding ----------

export type Decoded = {
  signers: string[];
  /** Every account the transaction lists, with lookup tables resolved, and whether it may write to it. */
  keys: { address: string; writable: boolean; signer: boolean }[];
  instructions: { program: string; accounts: string[]; data: Uint8Array }[];
  /** Lookup tables still to resolve (v0 messages), filled in by resolveLookups(). */
  lookups: { table: string; writable: number[]; readonly: number[] }[];
};

export class TxInputError extends Error {}

/** Base64 (what wallets and agent kits hand around) or base58. */
export function txBytes(raw: unknown): Uint8Array {
  const s = String(raw ?? "").trim();
  if (!s) throw new TxInputError("Pass the transaction, serialized and base64-encoded (unsigned is fine).");
  if (s.length > 4000) throw new TxInputError("That's longer than any Solana transaction (1,232 bytes at most).");
  // Whichever decoding gives a transaction: base64 first (more common), then base58.
  const attempt = (f: () => Uint8Array) => { try { const b = f(); VersionedTransaction.deserialize(b); return b; } catch { return null; } };
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const b = attempt(() => Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))) ?? attempt(() => bs58.decode(s));
  if (!b) throw new TxInputError("That doesn't decode as a Solana transaction. Pass the whole serialized transaction as base64 (unsigned is fine), not a signature or a message.");
  return b;
}

export function decodeTx(bytes: Uint8Array): Decoded {
  let tx: VersionedTransaction;
  try { tx = VersionedTransaction.deserialize(bytes); } catch { throw new TxInputError("That isn't a Solana transaction. Pass the whole serialized transaction (base64), not a signature or a message hash."); }
  const m = tx.message;
  const h = m.header;
  const statics = m.staticAccountKeys.map((k) => k.toBase58());
  const keys = statics.map((address, i) => ({
    address,
    signer: i < h.numRequiredSignatures,
    writable: i < h.numRequiredSignatures ? i < h.numRequiredSignatures - h.numReadonlySignedAccounts : i < statics.length - h.numReadonlyUnsignedAccounts,
  }));
  const lookups = (m.addressTableLookups ?? []).map((l) => ({ table: l.accountKey.toBase58(), writable: [...l.writableIndexes], readonly: [...l.readonlyIndexes] }));
  const decoded: Decoded = { signers: statics.slice(0, h.numRequiredSignatures), keys, instructions: [], lookups };
  // Instructions refer to accounts by index; lookup-table accounts come after the static ones, writable first.
  (decoded as any)._compiled = m.compiledInstructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accountKeyIndexes], data: Uint8Array.from(ix.data) }));
  if (!lookups.length) finishInstructions(decoded);
  return decoded;
}

/** Fills keys and instructions once lookup tables are known (table address → its addresses). */
export function resolveLookups(d: Decoded, tables: Record<string, string[]>): void {
  const writable: string[] = [], readonly: string[] = [];
  for (const l of d.lookups) {
    const addrs = tables[l.table];
    if (!addrs) throw new TxInputError(`The transaction uses address lookup table ${l.table}, which doesn't exist on mainnet.`);
    for (const i of l.writable) { if (addrs[i] === undefined) throw new TxInputError("A lookup-table index is out of range."); writable.push(addrs[i]); }
    for (const i of l.readonly) { if (addrs[i] === undefined) throw new TxInputError("A lookup-table index is out of range."); readonly.push(addrs[i]); }
  }
  for (const a of writable) d.keys.push({ address: a, writable: true, signer: false });
  for (const a of readonly) d.keys.push({ address: a, writable: false, signer: false });
  finishInstructions(d);
}

function finishInstructions(d: Decoded): void {
  const compiled = (d as any)._compiled as { programIdIndex: number; accounts: number[]; data: Uint8Array }[];
  d.instructions = compiled.map((ix) => {
    const program = d.keys[ix.programIdIndex]?.address;
    if (!program) throw new TxInputError("An instruction points at an account the transaction doesn't list.");
    return { program, accounts: ix.accounts.map((i) => d.keys[i]?.address ?? "?"), data: ix.data };
  });
}

// ---------- account states ----------

export type TokenState = { mint: string; owner: string; amount: bigint; delegate: string | null; delegatedAmount: bigint; closeAuthority: string | null };
export type AcctState = {
  lamports: number;
  /** Program that owns the account. */
  owner: string;
  token?: TokenState;
  stake?: { staker: string; withdrawer: string };
  nonce?: { authority: string };
} | null;

const pk = (b: Uint8Array, at: number) => bs58.encode(b.subarray(at, at + 32));
const u64 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 8).getBigUint64(0, true);
const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset + at, 4).getUint32(0, true);

/** An account as getMultipleAccounts / simulateTransaction return it with base64 encoding. */
export function parseAccount(v: any): AcctState {
  if (!v) return null;
  const owner = String(v.owner ?? "");
  const lamports = Number(v.lamports ?? 0);
  const raw = Array.isArray(v.data) ? v.data[0] : typeof v.data === "string" ? v.data : "";
  let b: Uint8Array;
  try { b = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); } catch { b = new Uint8Array(); }
  const out: NonNullable<AcctState> = { lamports, owner };
  // Token accounts: 165 bytes; Token-2022 accounts with extensions are longer and say "account" (2) at byte 165.
  if ((owner === TOKEN || owner === TOKEN_2022) && (b.length === 165 || (b.length > 165 && b[165] === 2))) {
    out.token = {
      mint: pk(b, 0), owner: pk(b, 32), amount: u64(b, 64),
      delegate: u32(b, 72) ? pk(b, 76) : null, delegatedAmount: u64(b, 121),
      closeAuthority: u32(b, 129) ? pk(b, 133) : null,
    };
  } else if (owner === STAKE && b.length >= 76 && (u32(b, 0) === 1 || u32(b, 0) === 2)) {
    out.stake = { staker: pk(b, 12), withdrawer: pk(b, 44) };
  } else if (owner === SYSTEM && b.length === 80 && u32(b, 4) === 1) {
    out.nonce = { authority: pk(b, 8) };
  }
  return out;
}

/** Mint decimals (byte 44 of a mint account), for showing amounts. */
export function mintDecimals(v: any): number | null {
  if (!v) return null;
  const raw = Array.isArray(v.data) ? v.data[0] : "";
  try { const b = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0)); return b.length >= 45 ? b[44] : null; } catch { return null; }
}

// ---------- the analysis ----------

export type Severity = "critical" | "high" | "medium" | "low";
export type Risk = { severity: Severity; title: string; detail: string };
export type TxCheck = {
  verdict: "do_not_sign" | "review" | "no_red_flags";
  signer: string;
  summary: string;
  risks: Risk[];
  balance_changes: { sol: number; tokens: { mint: string; symbol: string | null; change: string; account: string }[] };
  programs: { id: string; name: string | null }[];
  simulated: boolean;
  simulation_error: string | null;
};

export type AnalyzeInput = {
  signer: string;
  decoded: Decoded;
  /** Before: every writable account, keyed by address. */
  pre: Record<string, AcctState>;
  /** After the simulation, same keys; null when the simulation couldn't run. */
  post: Record<string, AcctState> | null;
  simError: string | null;
  decimals: Record<string, number | null>;
  symbols?: Record<string, string>;
};

const short = (a: string) => (a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a);
const fmtUnits = (v: bigint, dec: number | null | undefined) => {
  if (dec === null || dec === undefined) return v.toString();
  const neg = v < 0n, s = (neg ? -v : v).toString().padStart(dec + 1, "0");
  const whole = dec ? s.slice(0, -dec) : s, frac = dec ? s.slice(-dec).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
};

/** First instruction is System AdvanceNonceAccount (index 4): the transaction can be held and sent much later. */
export function usesDurableNonce(d: Decoded): boolean {
  const ix = d.instructions[0];
  return Boolean(ix && ix.program === SYSTEM && ix.data.length >= 4 && u32(ix.data, 0) === 4);
}

/** What the signer's accounts look like statically: approvals, authority changes, assigns (used when there's no simulation). */
function staticRisks(d: Decoded, signer: string, pre: Record<string, AcctState>): Risk[] {
  const out: Risk[] = [];
  const mine = (a: string) => a === signer || pre[a]?.token?.owner === signer;
  for (const ix of d.instructions) {
    const tag = ix.data[0];
    if ((ix.program === TOKEN || ix.program === TOKEN_2022) && ix.data.length) {
      if ((tag === 4 || tag === 13) && mine(ix.accounts[0])) {
        const delegate = tag === 4 ? ix.accounts[1] : ix.accounts[2];
        const amount = ix.data.length >= 9 ? u64(ix.data, 1) : 0n;
        out.push({ severity: amount === U64_MAX ? "critical" : "high", title: "Gives another address an approval on your tokens", detail: `It lets ${delegate} move ${amount === U64_MAX ? "all" : "up to " + amount.toString() + " base units of"} the tokens in account ${short(ix.accounts[0])} without asking you again.` });
      }
      if (tag === 6 && mine(ix.accounts[0]) && ix.data.length >= 3) {
        const type = ix.data[1], to = ix.data[2] ? pk(ix.data, 3) : null;
        if (type === 2 && to !== signer) out.push({ severity: "critical", title: "Hands your token account to another owner", detail: `Token account ${short(ix.accounts[0])} would belong to ${to ?? "nobody"}: they could take everything in it.` });
        if (type === 3 && to && to !== signer) out.push({ severity: "high", title: "Lets another address close your token account", detail: `${to} could close ${short(ix.accounts[0])} and keep its rent.` });
      }
    }
    if (ix.program === SYSTEM && ix.data.length >= 4) {
      const t = u32(ix.data, 0);
      if ((t === 1 || t === 10) && ix.accounts[0] === signer) out.push({ severity: "critical", title: "Hands your wallet account to a program", detail: "It reassigns the wallet account itself. After that, that program, not you, controls it and every SOL in it." });
      if (t === 7 && pre[ix.accounts[0]]?.nonce?.authority === signer && ix.data.length >= 36 && pk(ix.data, 4) !== signer) out.push({ severity: "critical", title: "Gives away your nonce account", detail: `Nonce account ${short(ix.accounts[0])} would be controlled by ${pk(ix.data, 4)}.` });
    }
    if (ix.program === STAKE && ix.data.length >= 4) {
      const t = u32(ix.data, 0);
      const st = pre[ix.accounts[0]]?.stake;
      if (st && (st.staker === signer || st.withdrawer === signer) && (t === 1 || t === 8 || t === 10 || t === 11)) out.push({ severity: "critical", title: "Changes who controls your stake", detail: `It changes an authority on stake account ${short(ix.accounts[0])}. Whoever holds the withdraw authority owns that SOL.` });
    }
  }
  return out;
}

/** Effects seen in the simulation: before vs after for the signer's own accounts. */
function stateRisks(signer: string, pre: Record<string, AcctState>, post: Record<string, AcctState>, decimals: Record<string, number | null>, symbols: Record<string, string>) {
  const risks: Risk[] = [];
  const tokens: TxCheck["balance_changes"]["tokens"] = [];
  let out = false, back = false;
  const w0 = pre[signer], w1 = post[signer];
  const sol = ((w1?.lamports ?? 0) - (w0?.lamports ?? 0)) / 1e9;
  if (w0 && w1 && w1.owner !== w0.owner) risks.push({ severity: "critical", title: "Hands your wallet account to a program", detail: `After this transaction the wallet account is owned by ${w1.owner}, not the System Program: that program, not you, controls it and every SOL in it.` });
  if (w0 && !w1) risks.push({ severity: "critical", title: "Empties and closes your wallet account", detail: "Every SOL leaves the wallet." });
  if (sol < -0.00001) out = true;
  if (sol > 0.00001) back = true;
  if (w0 && w1 && w0.lamports > 0 && -sol * 1e9 >= w0.lamports * 0.5 && -sol >= 0.05) risks.push({ severity: "high", title: `Sends ${(-sol).toFixed(4)} SOL, at least half the wallet's SOL`, detail: "Check where it goes before signing." });

  for (const [addr, a] of Object.entries(pre)) {
    if (!a) continue;
    const b = post[addr];
    if (a.token && a.token.owner === signer) {
      const t = a.token, dec = decimals[t.mint], sym = symbols[t.mint] ?? null, name = sym ?? short(t.mint);
      if (!b || !b.token) {
        if (t.amount > 0n) { out = true; tokens.push({ mint: t.mint, symbol: sym, change: fmtUnits(-t.amount, dec), account: addr }); }
        continue;
      }
      const u = b.token;
      if (u.owner !== signer) risks.push({ severity: "critical", title: `Hands your ${name} account to another owner`, detail: `Token account ${short(addr)} would belong to ${u.owner}: they could take everything in it, now and later.` });
      if (u.delegate && (u.delegate !== t.delegate || u.delegatedAmount > t.delegatedAmount) && u.delegatedAmount > 0n) {
        const all = u.delegatedAmount >= u.amount || u.delegatedAmount === U64_MAX;
        risks.push({ severity: all ? "critical" : "high", title: `Leaves an approval on your ${name}`, detail: `${u.delegate} could move ${all ? "all of it" : fmtUnits(u.delegatedAmount, dec) + " " + name} later without asking you. Swaps on Solana don't need a standing approval.` });
      }
      if (u.closeAuthority && u.closeAuthority !== t.closeAuthority && u.closeAuthority !== signer) risks.push({ severity: "high", title: `Lets another address close your ${name} account`, detail: `${u.closeAuthority} could close ${short(addr)}.` });
      const diff = u.amount - t.amount;
      if (diff !== 0n) tokens.push({ mint: t.mint, symbol: sym, change: fmtUnits(diff, dec), account: addr });
      if (diff < 0n) out = true;
      if (diff > 0n) back = true;
    }
    if (a.stake && (a.stake.staker === signer || a.stake.withdrawer === signer)) {
      if (b?.stake && (b.stake.withdrawer !== a.stake.withdrawer || b.stake.staker !== a.stake.staker)) {
        const lost = b.stake.withdrawer !== a.stake.withdrawer && b.stake.withdrawer !== signer;
        risks.push({ severity: lost ? "critical" : "high", title: lost ? "Gives away your stake account" : "Changes who manages your stake", detail: `Stake account ${short(addr)}: staker ${b.stake.staker}, withdrawer ${b.stake.withdrawer}. Whoever holds the withdraw authority owns that SOL.` });
      }
    }
    if (a.nonce && a.nonce.authority === signer && b?.nonce && b.nonce.authority !== signer) risks.push({ severity: "critical", title: "Gives away your nonce account", detail: `Nonce account ${short(addr)} would be controlled by ${b.nonce.authority}.` });
  }
  // New token accounts the signer ends up owning (bought tokens land in a fresh account).
  for (const [addr, b] of Object.entries(post)) {
    if (pre[addr]?.token || !b?.token || b.token.owner !== signer || b.token.amount === 0n) continue;
    back = true;
    tokens.push({ mint: b.token.mint, symbol: symbols[b.token.mint] ?? null, change: fmtUnits(b.token.amount, decimals[b.token.mint]), account: addr });
  }
  if (out && !back) risks.push({ severity: "medium", title: "Sends tokens or SOL and nothing comes back", detail: "That's what a payment or a transfer looks like, and also what a drainer looks like. Sign only if you meant to send exactly this." });
  return { risks, sol: Number(sol.toFixed(9)), tokens };
}

const RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export function analyze(x: AnalyzeInput): TxCheck {
  const { decoded: d, signer } = x;
  const symbols = x.symbols ?? {};
  let risks: Risk[] = [];
  let balance: TxCheck["balance_changes"] = { sol: 0, tokens: [] };
  if (x.post) {
    const s = stateRisks(signer, x.pre, x.post, x.decimals, symbols);
    risks.push(...s.risks);
    balance = { sol: s.sol, tokens: s.tokens };
  } else {
    // No simulation: read the instructions instead (misses what other programs would do on the wallet's behalf).
    risks.push(...staticRisks(d, signer, x.pre));
    risks.push({ severity: "medium", title: "Couldn't simulate this transaction", detail: `${x.simError ? `The simulation failed (${x.simError}). ` : ""}Without it, only the instructions written in the transaction were read; what other programs would do on your behalf is unknown.` });
  }
  if (usesDurableNonce(d)) risks.push({ severity: "medium", title: "Uses a durable nonce: it can be sent much later", detail: "Normal transactions expire within about a minute. This one stays valid until the nonce account moves, so a site could keep your signature and send it when you've forgotten about it." });
  const programs = [...new Set(d.instructions.map((i) => i.program))].map((id) => ({ id, name: KNOWN_PROGRAMS[id] ?? null }));
  const unknown = programs.filter((p) => !p.name);
  if (unknown.length) risks.push({ severity: "low", title: `Calls ${unknown.length} program${unknown.length > 1 ? "s" : ""} SealGuard doesn't know`, detail: `${unknown.map((p) => p.id).join(", ")}. New and small apps aren't on SealGuard's list; that alone isn't a problem. The effects above are what matters.` });
  // Same title twice (static and simulated readings of one approval) shows once.
  risks = risks.filter((r, i) => risks.findIndex((o) => o.title === r.title && o.detail === r.detail) === i).sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const worst = risks[0]?.severity;
  const verdict: TxCheck["verdict"] = worst === "critical" ? "do_not_sign" : worst === "high" || worst === "medium" ? "review" : "no_red_flags";
  const summary = verdict === "do_not_sign" ? "Don't sign this: it would give someone else control of this wallet's assets."
    : verdict === "review" ? "Check the points below before signing."
    : x.post ? "No red flags in the simulation: nothing in this wallet would be handed over, approved or left exposed." : "No red flags in the instructions, but it couldn't be simulated.";
  return { verdict, signer, summary, risks, balance_changes: balance, programs, simulated: Boolean(x.post), simulation_error: x.simError };
}

// ---------- the chain reads ----------

/** Decode, resolve lookup tables, read the writable accounts, simulate, read them again, analyze. */
export async function checkTransaction(rpc: RpcCall, rawTx: unknown, rawSigner: unknown): Promise<TxCheck> {
  const d = decodeTx(txBytes(rawTx));
  if (d.lookups.length) {
    const res = await rpc<any>("getMultipleAccounts", [d.lookups.map((l) => l.table), { encoding: "base64" }]);
    const tables: Record<string, string[]> = {};
    (res?.value ?? []).forEach((v: any, i: number) => {
      if (!v) return;
      try { tables[d.lookups[i].table] = AddressLookupTableAccount.deserialize(Uint8Array.from(atob(v.data[0]), (c) => c.charCodeAt(0))).addresses.map((a) => a.toBase58()); } catch { /* reported below as missing */ }
    });
    resolveLookups(d, tables);
  }
  let signer = typeof rawSigner === "string" && rawSigner.trim() ? rawSigner.trim() : d.signers[0];
  try { signer = new PublicKey(signer).toBase58(); } catch { throw new TxInputError("signer isn't a Solana address."); }
  if (!d.signers.includes(signer)) throw new TxInputError(`${signer} doesn't sign this transaction. Its signers are: ${d.signers.join(", ")}.`);

  // Every writable account plus the signer, capped (a transaction lists at most 256; real ones far fewer).
  const watch = [...new Set([signer, ...d.keys.filter((k) => k.writable).map((k) => k.address)])].slice(0, 64);
  const before = await rpc<any>("getMultipleAccounts", [watch, { encoding: "base64", commitment: "confirmed" }]);
  const pre: Record<string, AcctState> = {};
  watch.forEach((a, i) => { pre[a] = parseAccount(before?.value?.[i]); });

  let post: Record<string, AcctState> | null = null, simError: string | null = null;
  try {
    const sim = await rpc<any>("simulateTransaction", [btoa(String.fromCharCode(...txBytes(rawTx))), {
      encoding: "base64", sigVerify: false, commitment: "confirmed",
      // A durable-nonce transaction must keep its own blockhash (the nonce) or it won't run at all.
      replaceRecentBlockhash: !usesDurableNonce(d),
      accounts: { encoding: "base64", addresses: watch },
    }]);
    const v = sim?.value;
    if (v?.err) simError = typeof v.err === "string" ? v.err : JSON.stringify(v.err);
    else if (Array.isArray(v?.accounts)) { post = {}; watch.forEach((a, i) => { post![a] = parseAccount(v.accounts[i]); }); }
    else simError = "no account data returned";
  } catch (e: any) {
    simError = String(e?.message ?? e).slice(0, 200);
  }

  // Decimals for every mint that shows up, to print amounts.
  const mints = [...new Set([...Object.values(pre), ...Object.values(post ?? {})].map((a) => a?.token?.mint).filter((m): m is string => Boolean(m)))].slice(0, 100);
  const decimals: Record<string, number | null> = {};
  if (mints.length) {
    try { const r = await rpc<any>("getMultipleAccounts", [mints, { encoding: "base64" }]); mints.forEach((m, i) => { decimals[m] = mintDecimals(r?.value?.[i]); }); } catch { /* amounts in base units */ }
  }
  const symbols: Record<string, string> = {};
  if (mints.length) {
    try {
      const r = await rpc<any>("getAssetBatch", { ids: mints });
      (Array.isArray(r) ? r : []).forEach((a: any) => { const s = a?.content?.metadata?.symbol ?? a?.token_info?.symbol; if (a?.id && typeof s === "string" && s.trim()) symbols[a.id] = s.trim().slice(0, 16); });
    } catch { /* no DAS on this RPC: mints only */ }
  }
  return analyze({ signer, decoded: d, pre, post, simError, decimals, symbols });
}
