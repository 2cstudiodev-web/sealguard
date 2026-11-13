import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { AccountLayout, AuthorityType, createApproveInstruction, createSetAuthorityInstruction, createTransferInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { analyze, checkTransaction, decodeTx, parseAccount, TOKEN, TxInputError, txBytes, type AcctState } from "../worker/txcheck";

const me = Keypair.generate().publicKey;
const thief = Keypair.generate().publicKey;
const tokAcct = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const BH = "EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k";

function txOf(ixs: TransactionInstruction[], payer = me): Uint8Array {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: BH, instructions: ixs }).compileToV0Message();
  return new VersionedTransaction(msg).serialize();
}
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const tokenState = (p: Partial<{ owner: PublicKey; amount: bigint; delegate: PublicKey | null; delegatedAmount: bigint }> = {}): AcctState => ({
  lamports: 2_039_280, owner: TOKEN,
  token: { mint: mint.toBase58(), owner: (p.owner ?? me).toBase58(), amount: p.amount ?? 1_000_000n, delegate: p.delegate ? p.delegate.toBase58() : null, delegatedAmount: p.delegatedAmount ?? 0n, closeAuthority: null },
});
const wallet = (lamports: number, owner = "11111111111111111111111111111111"): AcctState => ({ lamports, owner });

describe("decoding", () => {
  it("reads signers, writable accounts and instructions from base64 and base58", () => {
    const bytes = txOf([SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 5 })]);
    const d = decodeTx(txBytes(b64(bytes)));
    expect(d.signers).toEqual([me.toBase58()]);
    expect(d.keys.find((k) => k.address === thief.toBase58())?.writable).toBe(true);
    expect(d.instructions[0].program).toBe("11111111111111111111111111111111");
    expect(() => txBytes("not a transaction")).toThrow(TxInputError);
  });

  it("parses a token account", () => {
    const data = Buffer.alloc(165);
    AccountLayout.encode({ mint, owner: me, amount: 42n, delegateOption: 1, delegate: thief, state: 1, isNativeOption: 0, isNative: 0n, delegatedAmount: 7n, closeAuthorityOption: 0, closeAuthority: PublicKey.default }, data);
    const a = parseAccount({ lamports: 1, owner: TOKEN, data: [data.toString("base64"), "base64"] });
    expect(a?.token).toMatchObject({ owner: me.toBase58(), amount: 42n, delegate: thief.toBase58(), delegatedAmount: 7n });
  });
});

describe("analysis from the simulation", () => {
  const base = (ixs: TransactionInstruction[]) => decodeTx(txOf(ixs));
  const signer = me.toBase58(), acct = tokAcct.toBase58();

  it("says don't sign when an approval for everything is left behind", () => {
    const r = analyze({
      signer, decoded: base([createApproveInstruction(tokAcct, thief, me, 2n ** 64n - 1n)]),
      pre: { [signer]: wallet(1e9), [acct]: tokenState() },
      post: { [signer]: wallet(1e9 - 5000), [acct]: tokenState({ delegate: thief, delegatedAmount: 2n ** 64n - 1n }) },
      simError: null, decimals: { [mint.toBase58()]: 6 },
    });
    expect(r.verdict).toBe("do_not_sign");
    expect(r.risks[0].title).toMatch(/approval/);
  });

  it("says don't sign when the wallet account is reassigned", () => {
    const r = analyze({
      signer, decoded: base([SystemProgram.assign({ accountPubkey: me, programId: thief })]),
      pre: { [signer]: wallet(1e9) }, post: { [signer]: wallet(1e9, thief.toBase58()) }, simError: null, decimals: {},
    });
    expect(r.verdict).toBe("do_not_sign");
  });

  it("flags a one-way transfer of most of the SOL for review", () => {
    const r = analyze({
      signer, decoded: base([SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 9e8 })]),
      pre: { [signer]: wallet(1e9), [thief.toBase58()]: wallet(0) }, post: { [signer]: wallet(1e8 - 5000), [thief.toBase58()]: wallet(9e8) },
      simError: null, decimals: {},
    });
    expect(r.verdict).toBe("review");
    expect(r.balance_changes.sol).toBeCloseTo(-0.900005);
    expect(r.risks.map((x) => x.severity)).toEqual(["high", "medium"]);
  });

  it("finds nothing in a swap-like exchange", () => {
    const other = Keypair.generate().publicKey.toBase58();
    const r = analyze({
      signer, decoded: base([createTransferInstruction(tokAcct, thief, me, 10n)]),
      pre: { [signer]: wallet(1e9), [acct]: tokenState({ amount: 100n }), [other]: null },
      post: { [signer]: wallet(1.2e9), [acct]: tokenState({ amount: 90n }), [other]: { ...tokenState({ amount: 5n })!, token: { ...tokenState()!.token!, mint: other, amount: 5n } } },
      simError: null, decimals: {},
    });
    expect(r.verdict).toBe("no_red_flags");
    expect(r.balance_changes.tokens).toHaveLength(2);
  });
});

describe("analysis without a simulation", () => {
  it("reads a SetAuthority that hands the token account away", () => {
    const d = decodeTx(txOf([createSetAuthorityInstruction(tokAcct, me, AuthorityType.AccountOwner, thief, [], TOKEN_PROGRAM_ID)]));
    const r = analyze({ signer: me.toBase58(), decoded: d, pre: { [me.toBase58()]: wallet(1e9), [tokAcct.toBase58()]: tokenState() }, post: null, simError: "BlockhashNotFound", decimals: {} });
    expect(r.verdict).toBe("do_not_sign");
    expect(r.simulated).toBe(false);
    expect(r.risks.some((x) => x.title.startsWith("Couldn't simulate"))).toBe(true);
  });
});

describe("checkTransaction", () => {
  it("rejects a signer that doesn't sign the transaction", async () => {
    const rpc = async () => ({ value: [] }) as any;
    await expect(checkTransaction(rpc, b64(txOf([SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 1 })])), thief.toBase58())).rejects.toThrow(/doesn't sign/);
  });

  it("runs the reads in order and reports the simulation's effects", async () => {
    const calls: string[] = [];
    const rpc = async (method: string, params: any) => {
      calls.push(method);
      if (method === "simulateTransaction") return { value: { err: null, accounts: params[1].accounts.addresses.map((a: string) => (a === me.toBase58() ? { lamports: 5e8, owner: "11111111111111111111111111111111", data: ["", "base64"] } : { lamports: 5e8, owner: "11111111111111111111111111111111", data: ["", "base64"] })) } };
      if (method === "getMultipleAccounts") return { value: params[0].map((a: string) => (a === me.toBase58() ? { lamports: 1e9, owner: "11111111111111111111111111111111", data: ["", "base64"] } : null)) };
      throw new Error("unexpected " + method);
    };
    const r = await checkTransaction(rpc as any, b64(txOf([SystemProgram.transfer({ fromPubkey: me, toPubkey: thief, lamports: 5e8 })])), undefined);
    expect(calls).toEqual(["getMultipleAccounts", "simulateTransaction"]);
    expect(r.simulated).toBe(true);
    expect(r.balance_changes.sol).toBe(-0.5);
    expect(r.verdict).toBe("review");
  });
});
