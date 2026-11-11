import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@solana/web3.js";
import { scan, SYSTEM_PROGRAM, type Action, type ScanInput, type TokenAcct } from "../web/src/scan";
import { buildTransaction, MAX_ACTIONS_PACKED, packActions, TX_SIZE_LIMIT } from "../web/src/tx";
import { signAndSendMany, type Connected } from "../web/src/wallet";

const W = "JCDrnFgRf2Edrcpr5mp7LxsNYWHxsyz1ryMi8pntstB2";
const owner = Keypair.generate().publicKey;
const key = () => Keypair.generate().publicKey.toBase58();
const acct = (p: Partial<TokenAcct>): TokenAcct => ({ address: key(), mint: key(), program: "token", amount: 0n, decimals: 6, delegate: null, delegatedAmount: 0n, closeAuthority: null, frozen: false, isNative: false, lamports: 2_039_280, ...p });
const input = (p: Partial<ScanInput>): ScanInput => ({ wallet: W, walletOwner: SYSTEM_PROGRAM, tokenAccounts: [], mints: {}, assets: {}, stakes: [], nonces: [], ...p });

describe("closing safely", () => {
  it("leaves common tokens and recently used accounts unticked by default, with a reason", () => {
    const now = Date.UTC(2026, 10, 11);
    const r = scan(input({ tokenAccounts: [
      acct({ mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }),
      acct({ lastActivity: now - 3 * 86_400_000 }),
      acct({ lastActivity: now - 90 * 86_400_000 }),
      acct({}),
    ] }), { now });
    const empties = r.findings.filter((f) => f.check === "empty");
    expect(empties.map((f) => Boolean(f.keep))).toEqual([true, true, false, false]);
    expect(empties[0].title).toBe("Empty USDC account");
    expect(empties[0].keep).toMatch(/receive USDC again/);
    expect(empties[1].keep).toMatch(/last 30 days/);
    // Rent totals still count everything; only the default selection changes.
    expect(r.reclaim.accounts).toBe(4);
  });
});

describe("packing", () => {
  const closes = (n: number): Action[] => Array.from({ length: n }, () => ({ kind: "close", tokenAccount: key(), mint: key(), program: "token", lamports: 2_039_280 }));

  it("fills each transaction up to the size limit and the action cap", () => {
    const groups = packActions(closes(100), owner);
    expect(groups.reduce((s, g) => s + g.length, 0)).toBe(100);
    for (const g of groups) {
      expect(g.length).toBeLessThanOrEqual(MAX_ACTIONS_PACKED);
      const size = buildTransaction(g, owner, "11111111111111111111111111111111", 0).serialize({ requireAllSignatures: false, verifySignatures: false }).length;
      expect(size).toBeLessThanOrEqual(TX_SIZE_LIMIT);
    }
    // Far fewer transactions than the old 10-per-transaction split.
    expect(groups.length).toBeLessThan(10);
  });

  it("packs burns (bigger) too and keeps the order", () => {
    const acts: Action[] = [...closes(5), ...Array.from({ length: 30 }, () => ({ kind: "burnClose", tokenAccount: key(), mint: key(), program: "token", amount: 1n }) as Action)];
    const groups = packActions(acts, owner);
    expect(groups.flat()).toEqual(acts);
  });
});

describe("signing many", () => {
  const txs = Array.from({ length: 3 }, () => new Transaction({ feePayer: owner, blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 0 }));
  const account = { address: owner.toBase58(), publicKey: owner.toBytes(), chains: ["solana:mainnet"], features: [] } as any;

  it("uses the wallet's signAndSendAllTransactions in one approval", async () => {
    let calls = 0;
    const wallet: any = { features: { "solana:signAndSendAllTransactions": { signAndSendAllTransactions: async (inputs: any[]) => { calls++; return inputs.map((_, i) => (i === 1 ? { status: "rejected", reason: new Error("blockhash expired") } : { status: "fulfilled", value: { signature: new Uint8Array(64).fill(i + 1) } })); } } } };
    const out = await signAndSendMany({ wallet, account, address: account.address } as Connected, txs, async () => "x");
    expect(calls).toBe(1);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
  });

  it("falls back to signTransaction with several inputs, then sends each", async () => {
    let calls = 0, sends = 0;
    const wallet: any = { features: { "solana:signTransaction": { signTransaction: async (...inputs: any[]) => { calls++; return inputs.map((i) => ({ signedTransaction: i.transaction })); } } } };
    const out = await signAndSendMany({ wallet, account, address: account.address } as Connected, txs, async () => { sends++; return "sig" + sends; });
    expect(calls).toBe(1);
    expect(sends).toBe(3);
    expect(out).toEqual([{ ok: true, signature: "sig1" }, { ok: true, signature: "sig2" }, { ok: true, signature: "sig3" }]);
  });
});
