// Simulates (never sends) the "close empty accounts" transactions for a real wallet, fee included:
//   LIVE_RPC=<url> LIVE_WALLET=<address> LIVE_OUT=<file> npx vitest run test/live-sim.test.ts
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput, rpcOver } from "../shared/chain";
import { scan, type Action } from "../web/src/scan";
import { buildTransaction, groupFee, packActions } from "../web/src/tx";

const url = process.env.LIVE_RPC;
const wallet = process.env.LIVE_WALLET;

describe.skipIf(!url || !wallet)("live close simulation", () => {
  it("simulates every close batch with its fee", async () => {
    const rpc = rpcOver(url!, 30_000);
    const r = scan(await fetchScanInput(rpc, wallet!, () => {}, { activityUpTo: 40 }));
    const kept = r.findings.filter((f) => f.action?.kind === "close" && f.keep).map((f) => `${f.title}: ${f.keep}`);
    const closes = r.findings.filter((f) => f.action?.kind === "close" && !f.keep).map((f) => f.action!) as Action[];
    const owner = new PublicKey(wallet!);
    const lines = [`ticked by default ${closes.length}, kept ${kept.length}`, ...kept.map((k) => `  kept: ${k}`), ...r.findings.filter((f) => f.check === "empty").slice(0, 5).map((f) => `  name: ${f.title}`)];
    for (const g of packActions(closes, owner)) {
      const bh = await rpc<any>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      const tx = buildTransaction(g, owner, bh.value.blockhash, bh.value.lastValidBlockHeight);
      const sim = await rpc<any>("simulateTransaction", [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
      lines.push(`batch of ${g.length}: fee ${groupFee(g)} lamports, ${tx.instructions.length} instructions, size ${tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes, err ${JSON.stringify(sim?.value?.err)}, units ${sim?.value?.unitsConsumed}`);
      expect(sim?.value?.err).toBeNull();
    }
    const out = process.env.LIVE_OUT;
    if (out) (await import("node:fs")).writeFileSync(out, lines.join("\n") + "\n");
  }, 120_000);
});
