// A real read of mainnet through a public RPC, only when LIVE_RPC is set:
//   LIVE_RPC=https://api.mainnet-beta.solana.com LIVE_WALLET=<address> npx vitest run test/live.test.ts
// It patches fetch so rpc.ts's "/rpc" goes straight to that URL (no Worker needed) and prints the findings.
import { describe, expect, it } from "vitest";
import { fetchScanInput } from "../web/src/rpc";
import { scan } from "../web/src/scan";

const url = process.env.LIVE_RPC;
const wallet = process.env.LIVE_WALLET;

describe.skipIf(!url || !wallet)("live scan", () => {
  it("reads a wallet and scans it", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) => real(typeof input === "string" && input === "/rpc" ? url! : input, init)) as typeof fetch;
    try {
      const data = await fetchScanInput(wallet!, (s) => console.log("…", s));
      const r = scan(data);
      const lines = [JSON.stringify({ score: r.score, counts: r.counts, checked: r.checked, warnings: r.warnings })];
      for (const f of r.findings) lines.push(`[${f.severity}] ${f.title}\n   ${f.detail}`);
      const out = process.env.LIVE_OUT;
      if (out) (await import("node:fs")).writeFileSync(out, lines.join("\n") + "\n");
      else console.log(lines.join("\n"));
      expect(r.checked.tokenAccounts).toBeGreaterThanOrEqual(0);
    } finally {
      globalThis.fetch = real;
    }
  }, 120_000);
});
