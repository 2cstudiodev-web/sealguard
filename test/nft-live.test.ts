// Live check, run by hand: LIVE_NFT=<wallet> npx vitest run test/nft-live.test.ts
// Simulates (never signs or sends) the NFT burns SealGuard would offer for that wallet.
import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { fetchScanInput } from "../shared/chain";
import { scan } from "../web/src/scan";
import { buildTransaction } from "../web/src/tx";

const W = process.env.LIVE_NFT;
const RELAY = "https://guard.2cstudio.app/rpc", PUBLIC = "https://api.mainnet-beta.solana.com";
async function call(url: string, method: string, params: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 SealGuard-test" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const rpc: any = (m: string, p: unknown) => call(m === "getMinimumBalanceForRentExemption" ? PUBLIC : RELAY, m, p);

describe.skipIf(!W)("NFT burns (live simulation)", () => {
  it("every offered burn simulates cleanly", async () => {
    const input = await fetchScanInput(rpc, W!, () => {}, {});
    const r = scan(input, { closeFeeBps: 500 });
    const burns = r.findings.filter((f) => f.action?.kind === "burnNft");
    console.log("nfts found:", input.nfts?.length, "burns offered:", burns.length, "pnft:", input.nfts?.filter((n) => n.pnft).length, "with collection:", input.nfts?.filter((n) => n.collectionMetadata).length);
    console.log("SOL back each:", input.nfts?.map((n) => (n.lamports / 1e9).toFixed(5)).join(" "));
    const bh = await call(RELAY, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    const owner = new PublicKey(W!);
    let ok = 0;
    for (const f of burns) {
      const tx = buildTransaction([f.action!], owner, bh.value.blockhash, bh.value.lastValidBlockHeight, { feeBps: 500 });
      const sim = await call(RELAY, "simulateTransaction", [tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true }]);
      if (sim.value.err) console.log("FAIL", f.title, JSON.stringify(sim.value.err), (sim.value.logs ?? []).slice(-4).join(" | ")); else ok++;
    }
    console.log("simulated ok:", ok, "/", burns.length);
    expect(ok).toBe(burns.length);
  }, 300_000);
});
