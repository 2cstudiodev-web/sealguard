// Wallet connection through the Wallet Standard: Phantom, Solflare, Backpack… register themselves in the page,
// and on a Seeker (or any Android phone) the Mobile Wallet Adapter shows up as one more wallet.
import { getWallets } from "@wallet-standard/app";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { registerMwa, createDefaultAuthorizationCache, createDefaultChainSelector, createDefaultWalletNotFoundHandler } from "@solana-mobile/wallet-standard-mobile";
import { Transaction } from "@solana/web3.js";
import { nativePlugin, registerNativeWallet } from "./native";

const CHAIN = "solana:mainnet";

export type Connected = { wallet: Wallet; account: WalletAccount; address: string };

let mwaRegistered = false;
export function registerMobile(): void {
  if (mwaRegistered || typeof window === "undefined") return;
  mwaRegistered = true;
  // Inside the SealGuard app the browser adapter can't reach the wallet; the app's own plugin takes its place.
  const native = nativePlugin();
  if (native) { registerNativeWallet(native); return; }
  try {
    registerMwa({
      appIdentity: { name: "SealGuard", uri: window.location.origin, icon: "icon.png" },
      authorizationCache: createDefaultAuthorizationCache(),
      chains: [CHAIN],
      chainSelector: createDefaultChainSelector(),
      onWalletNotFound: createDefaultWalletNotFoundHandler(),
    });
  } catch {
    // Not on a platform where MWA applies (or already registered by another script).
  }
}

function supports(w: Wallet): boolean {
  return w.chains.includes(CHAIN) && "standard:connect" in w.features && ("solana:signAndSendTransaction" in w.features || "solana:signTransaction" in w.features);
}

export function listWallets(): Wallet[] {
  return getWallets().get().filter(supports);
}

export function onWalletsChange(cb: () => void): () => void {
  const { on } = getWallets();
  const offs = [on("register", cb), on("unregister", cb)];
  return () => offs.forEach((f) => f());
}

export async function connect(w: Wallet): Promise<Connected> {
  const f: any = w.features["standard:connect"];
  const { accounts } = await f.connect();
  const account = (accounts as WalletAccount[]).find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
  if (!account) throw new Error("The wallet returned no account");
  return { wallet: w, account, address: account.address };
}

/** Reconnects without a prompt when the wallet already trusts this site (Wallet Standard `silent`); null otherwise. */
export async function connectSilently(w: Wallet): Promise<Connected | null> {
  try {
    const f: any = w.features["standard:connect"];
    const { accounts } = await f.connect({ silent: true });
    const account = (accounts as WalletAccount[]).find((a) => a.chains.includes(CHAIN)) ?? accounts[0];
    return account ? { wallet: w, account, address: account.address } : null;
  } catch {
    return null;
  }
}

export async function disconnect(c: Connected): Promise<void> {
  const f: any = c.wallet.features["standard:disconnect"];
  if (f) await f.disconnect().catch(() => {});
}

/** Signs and sends one legacy transaction; returns the signature (base58). Prefers the wallet's own send. */
export async function signAndSend(c: Connected, tx: Transaction, sendRaw: (raw: Uint8Array) => Promise<string>): Promise<string> {
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  const sas: any = c.wallet.features["solana:signAndSendTransaction"];
  if (sas) {
    const [out] = await sas.signAndSendTransaction({ account: c.account, chain: CHAIN, transaction: bytes, options: { preflightCommitment: "confirmed" } });
    return base58(out.signature);
  }
  const st: any = c.wallet.features["solana:signTransaction"];
  const [out] = await st.signTransaction({ account: c.account, chain: CHAIN, transaction: bytes });
  return sendRaw(out.signedTransaction);
}

export type SendResult = { ok: true; signature: string } | { ok: false; error: string };

/**
 * Signs and sends several transactions with one approval where the wallet allows it: the wallet's own
 * signAndSendAllTransactions, else signTransaction with several inputs (we send them), else one by one.
 */
export async function signAndSendMany(c: Connected, txs: Transaction[], sendRaw: (raw: Uint8Array) => Promise<string>): Promise<SendResult[]> {
  const inputs = txs.map((tx) => ({ account: c.account, chain: CHAIN, transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }) }));
  const all: any = c.wallet.features["solana:signAndSendAllTransactions"];
  if (all && txs.length > 1) {
    const settled = await all.signAndSendAllTransactions(inputs.map((i) => ({ ...i, options: { preflightCommitment: "confirmed" } })), { mode: "parallel" });
    return settled.map((r: PromiseSettledResult<any>) => (r.status === "fulfilled" ? { ok: true, signature: base58(r.value.signature) } : { ok: false, error: String((r.reason as any)?.message ?? r.reason) }));
  }
  const st: any = c.wallet.features["solana:signTransaction"];
  if (st && txs.length > 1) {
    const signed = await st.signTransaction(...inputs);
    const out: SendResult[] = [];
    for (const s of signed) {
      try { out.push({ ok: true, signature: await sendRaw(s.signedTransaction) }); } catch (e: any) { out.push({ ok: false, error: String(e?.message ?? e) }); }
    }
    return out;
  }
  const out: SendResult[] = [];
  for (const tx of txs) {
    try { out.push({ ok: true, signature: await signAndSend(c, tx, sendRaw) }); } catch (e: any) {
      out.push({ ok: false, error: String(e?.message ?? e) });
      if (/reject|denied|cancel/i.test(String(e?.message ?? e))) break;
    }
  }
  return out;
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
