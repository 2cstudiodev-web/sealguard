// Red-team review 17 Nov 2026: the free check_transaction trial is limited per network, and the /rpc relay only
// serves SealGuard's own pages and refuses oversized transactions.
import { describe, expect, it } from "vitest";
import { d1 } from "./d1sqlite";
import { account, rotateKey, trialNet, TRIALS_PER_DAY } from "../worker/mcpkeys";
import { rpcOriginOk } from "../worker/index";

const now = Date.UTC(2026, 10, 17, 12);
const wallet = (i: number) => `Wa11et${String(i).padStart(4, "0")}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44);

describe("free trial per network", () => {
  it("gives the trial once per network, even to new wallets", async () => {
    const db = d1();
    const net = await trialNet("s", "203.0.113.7");
    const a = await rotateKey(db, "s", wallet(1), now, net);
    const b = await rotateKey(db, "s", wallet(2), now + 1, await trialNet("s", "203.0.113.99")); // same /24
    expect(a.trialChecks).toBe(20);
    expect(b.trialChecks).toBe(0);
    expect(b.trialRefused).toBe("network");
    expect((await account(db, wallet(2), false, now)).credits).toBe(0);
    // The refused wallet doesn't get it later from another network either: one trial per wallet, as before.
    const c = await rotateKey(db, "s", wallet(2), now + 2, await trialNet("s", "198.51.100.1"));
    expect(c.trialChecks).toBe(0);
  });

  it("groups IPv6 by /48 and allows a new trial after 30 days", async () => {
    const db = d1();
    const a = await rotateKey(db, "s", wallet(1), now, await trialNet("s", "2001:db8:1:1::1"));
    const b = await rotateKey(db, "s", wallet(2), now, await trialNet("s", "2001:db8:1:ffff::2"));
    const later = await rotateKey(db, "s", wallet(3), now + 31 * 86_400_000, await trialNet("s", "2001:db8:1:2::3"));
    expect([a.trialChecks, b.trialChecks, later.trialChecks]).toEqual([20, 0, 20]);
  });

  it("caps trials per day across all networks", async () => {
    const db = d1();
    for (let i = 0; i < TRIALS_PER_DAY; i++) expect((await rotateKey(db, "s", wallet(i), now, await trialNet("s", `10.${i}.0.1`))).trialChecks).toBe(20);
    const over = await rotateKey(db, "s", wallet(999), now, await trialNet("s", "10.250.0.1"));
    expect(over.trialChecks).toBe(0);
    expect(over.trialRefused).toBe("daily");
  });

  it("keeps the old behaviour without a network (tools, tests)", async () => {
    const db = d1();
    expect((await rotateKey(db, "s", wallet(1), now)).trialChecks).toBe(20);
  });
});

describe("/rpc origin", () => {
  const site = { PUBLIC_URL: "https://guard.2cstudio.app" };
  const req = (origin: string | null) => new Request("https://guard.2cstudio.app/rpc", { method: "POST", headers: origin ? { origin } : {} });
  it("allows SealGuard's own page and refuses other sites and scripts without an Origin", () => {
    const u = new URL("https://guard.2cstudio.app/rpc");
    expect(rpcOriginOk(req("https://guard.2cstudio.app"), u, site)).toBe(true);
    expect(rpcOriginOk(req("https://evil.example"), u, site)).toBe(false);
    expect(rpcOriginOk(req(null), u, site)).toBe(false);
  });
  it("allows local development pages on localhost only", () => {
    const local = new URL("http://localhost:8787/rpc");
    expect(rpcOriginOk(new Request(local, { method: "POST", headers: { origin: "http://localhost:5173" } }), local, site)).toBe(true);
    expect(rpcOriginOk(new Request(local, { method: "POST" }), local, site)).toBe(true);
    const prod = new URL("https://guard.2cstudio.app/rpc");
    expect(rpcOriginOk(req("http://localhost:5173"), prod, site)).toBe(false);
  });
});
