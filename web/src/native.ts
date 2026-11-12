// Inside the SealGuard Android app (a Capacitor shell that loads this site), the browser's Mobile Wallet Adapter
// can't reach the wallet app, so the app ships a native plugin ("Wallet", sealguard-app WalletPlugin.kt). This file
// wraps that plugin as a Wallet Standard wallet, so the rest of the page connects, signs in and fixes exactly as
// it does in a browser. Every signature is still shown and approved in the wallet app; the plugin holds no key.
import { registerWallet } from "@wallet-standard/wallet";
import type { Wallet, WalletAccount } from "@wallet-standard/base";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

const CHAIN = "solana:mainnet";
const ADDR_KEY = "sg_native_addr";
// Same name the browser's adapter uses, so nothing new appears in the wallet list.
const NAME = "Mobile Wallet Adapter";
const ICON = "data:image/svg+xml;base64," + btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14f195"/><path d="M16 6l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V9z" fill="#0a0a0a"/></svg>');

type NativeWallet = {
  connect(): Promise<{ address: string }>;
  signMessage(o: { message: string }): Promise<{ signature: string }>;
  signAndSendAll(o: { txs: string[] }): Promise<{ signatures: string[] }>;
  disconnect(): Promise<void>;
};

const b64 = (u: Uint8Array): string => { let s = ""; for (const b of u) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const store = { get: (): string | null => { try { return localStorage.getItem(ADDR_KEY); } catch { return null; } },
  set: (v: string | null): void => { try { if (v) localStorage.setItem(ADDR_KEY, v); else localStorage.removeItem(ADDR_KEY); } catch { /* private mode */ } } };

/** The native plugin when this page runs inside the SealGuard app; null in a browser. */
export function nativePlugin(): NativeWallet | null {
  const cap = (window as any).Capacitor;
  if (!cap?.isNativePlatform?.() || typeof cap.registerPlugin !== "function") return null;
  return cap.registerPlugin("Wallet") as NativeWallet;
}

function account(address: string): WalletAccount {
  return { address, publicKey: new PublicKey(address).toBytes(), chains: [CHAIN], features: ["solana:signMessage", "solana:signAndSendTransaction"] };
}

/** Registers the app's wallet in the page (Wallet Standard). Call once, in place of the browser adapter. */
export function registerNativeWallet(p: NativeWallet): void {
  let accounts: WalletAccount[] = [];
  const listeners = new Set<(props: { accounts: WalletAccount[] }) => void>();
  const set = (address: string | null) => {
    accounts = address ? [account(address)] : [];
    store.set(address);
    for (const l of listeners) l({ accounts });
  };
  const sendAll = async (txs: Uint8Array[]): Promise<Uint8Array[]> => (await p.signAndSendAll({ txs: txs.map(b64) })).signatures.map((s) => bs58.decode(s));

  const wallet = {
    version: "1.0.0" as const,
    name: NAME,
    icon: ICON as `data:image/svg+xml;base64,${string}`,
    chains: [CHAIN] as const,
    get accounts() { return accounts; },
    features: {
      "standard:connect": {
        version: "1.0.0",
        // silent: the address this app connected last time (signing still goes through the wallet app).
        connect: async (input?: { silent?: boolean }) => {
          if (input?.silent) { const a = store.get(); if (a) set(a); return { accounts }; }
          set((await p.connect()).address);
          return { accounts };
        },
      },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { try { await p.disconnect(); } finally { set(null); } } },
      "standard:events": {
        version: "1.0.0",
        on: (_event: "change", listener: (props: { accounts: WalletAccount[] }) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
      },
      "solana:signMessage": {
        version: "1.0.0",
        signMessage: async (...inputs: { message: Uint8Array }[]) => {
          const out = [];
          for (const i of inputs) out.push({ signedMessage: i.message, signature: unb64((await p.signMessage({ message: b64(i.message) })).signature) });
          return out;
        },
      },
      "solana:signAndSendTransaction": {
        version: "1.0.0",
        supportedTransactionVersions: ["legacy", 0],
        signAndSendTransaction: async (...inputs: { transaction: Uint8Array }[]) => (await sendAll(inputs.map((i) => i.transaction))).map((signature) => ({ signature })),
      },
      // One approval for every transaction of a fix (wallet.ts uses this when there's more than one).
      "solana:signAndSendAllTransactions": {
        version: "1.0.0",
        signAndSendAllTransactions: async (inputs: { transaction: Uint8Array }[]) => {
          try {
            return (await sendAll(inputs.map((i) => i.transaction))).map((signature) => ({ status: "fulfilled" as const, value: { signature } }));
          } catch (reason) {
            return inputs.map(() => ({ status: "rejected" as const, reason }));
          }
        },
      },
    },
  };
  registerWallet(wallet as unknown as Wallet);
}
