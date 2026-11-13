// check_transaction against mainnet, only when LIVE_RPC is set (simulation needs a real RPC; nothing is sent):
//   LIVE_RPC=<rpc url> npx vitest run test/txcheck-live.test.ts
// Builds unsigned transactions for a public wallet with SOL and token accounts, and checks what the simulation says.
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { createApproveInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { rpcOver } from "../shared/chain";
import { checkTransaction } from "../worker/txcheck";

const url = process.env.LIVE_RPC;
// 2C Studio's treasury (public, in wrangler.jsonc): holds SOL and USDC.
const WALLET = new PublicKey(process.env.LIVE_WALLET ?? "B3BCTvv1LUpXZ2PpB4HeppxuSsS8Y1GSjYYG6NB6xTUA");

describe.skipIf(!url)("check_transaction on mainnet", () => {
  const rpc = rpcOver(url!, 30_000);
  async function tx(ixs: TransactionInstruction[]): Promise<string> {
    const { value } = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const msg = new TransactionMessage({ payerKey: WALLET, recentBlockhash: value.blockhash, instructions: ixs }).compileToV0Message();
    return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
  }

  it("simulates a small SOL transfer: no red flags beyond a one-way payment", async () => {
    const r = await checkTransaction(rpc, await tx([SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: Keypair.generate().publicKey, lamports: 1_000_000 })]), undefined);
    console.log(JSON.stringify(r, null, 1));
    expect(r.simulated).toBe(true);
    expect(r.balance_changes.sol).toBeLessThan(0);
    expect(r.verdict).not.toBe("do_not_sign");
  }, 60_000);

  it("simulates an unlimited approval on a real token account: don't sign", async () => {
    const accts = await rpc<any>("getTokenAccountsByOwner", [WALLET.toBase58(), { programId: TOKEN_PROGRAM_ID.toBase58() }, { encoding: "jsonParsed" }]);
    const first = accts?.value?.find((a: any) => BigInt(a.account.data.parsed.info.tokenAmount.amount) > 0n);
    if (!first) return console.log("no funded token account on this wallet; skipped");
    const r = await checkTransaction(rpc, await tx([createApproveInstruction(new PublicKey(first.pubkey), Keypair.generate().publicKey, WALLET, 2n ** 64n - 1n)]), WALLET.toBase58());
    console.log(JSON.stringify(r, null, 1));
    expect(r.simulated).toBe(true);
    expect(r.verdict).toBe("do_not_sign");
  }, 60_000);
});
