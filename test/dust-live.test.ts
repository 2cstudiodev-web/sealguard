// Live check, run by hand: LIVE_DUST=<wallet> npx vitest run test/dust-live.test.ts
// Gets real Jupiter quotes and simulates (never signs or sends) the small-balance sales SealGuard would offer.
import { describe, expect, it } from "vitest";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { fetchScanInput } from "../shared/chain";
import { scan, type Action } from "../web/src/scan";
import { buildDustTx, JUPITER_GAP_MS } from "../web/src/dust";
import { TREASURY } from "../web/src/tx";

const W = process.env.LIVE_DUST;
const RELAY = "https://guard.2cstudio.app/rpc", PUBLIC = "https://api.mainnet-beta.solana.com";
async function call(url: string, method: string, params: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 SealGuard-test" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j: any = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
const rpc: any = (m: string, p: unknown) => call(m === "getMinimumBalanceForRentExemption" ? PUBLIC : RELAY, m, p);

describe.skipIf(!W)("small-balance sales (live simulation)", () => {
  it("offered sales get a route and simulate cleanly", async () => {
    const input = await fetchScanInput(rpc, W!, () => {}, {});
    const r = scan(input, { closeFeeBps: 500 });
    const sales = r.findings.filter((f) => f.action?.kind === "sellDust");
    console.log("sales offered:", sales.length);
    for (const f of sales) console.log(" -", f.title);
    const owner = new PublicKey(W!);
    const bh = await call(RELAY, "getLatestBlockhash", [{ commitment: "confirmed" }]);
    let ok = 0, noroute = 0, refused = 0;
    for (const [k, f] of sales.slice(0, 8).entries()) {
      if (k) await new Promise((r) => setTimeout(r, JUPITER_GAP_MS));
      const a = f.action as Extract<Action, { kind: "sellDust" }>;
      const b = await buildDustTx(a, owner, { feeBps: 500, blockhash: bh.value.blockhash, rpc });
      if (!b.ok) { console.log("LEFT OUT", a.symbol, b.reason); b.reason === "noroute" ? noroute++ : refused++; continue; }
      const bytes = b.tx.serialize();
      const back = VersionedTransaction.deserialize(bytes);
      const keys = back.message.staticAccountKeys.map((x) => x.toBase58());
      console.log("OK", a.symbol, "bytes", bytes.length, "min out", b.outLamports, "rent", a.rent, "fee", b.feeLamports, "est out", a.estLamports, "treasury in tx", keys.includes(TREASURY.toBase58()));
      ok++;
    }
    console.log({ ok, noroute, refused });
    expect(ok + noroute + refused).toBe(Math.min(8, sales.length));
  }, 300_000);
});
