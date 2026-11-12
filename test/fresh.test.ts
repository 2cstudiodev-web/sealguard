// Linking or unlinking Telegram needs a recent sign-in or a new signature.
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { issueToken, makeNonce, siwsMessage } from "../worker/auth";
import { handleApi, type GuardEnv } from "../worker/guard";

const SECRET = "test-secret";
const kp = Keypair.generate();
const W = kp.publicKey.toBase58();
const now = 1_800_000_000_000;

// Just enough of D1 for the link and unlink routes.
function env(): GuardEnv & { writes: string[] } {
  const writes: string[] = [];
  const db: any = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => ({ wallet: W, paid_until: now + 86_400_000 }),
        run: async () => { writes.push(sql); return { meta: { changes: 1 } }; },
      }),
    }),
  };
  return { DB: db, RPC_URL: "", SESSION_SECRET: SECRET, TREASURY: "", TELEGRAM_BOT_TOKEN: "1:x", TELEGRAM_BOT_USERNAME: "seal_guard_bot", writes };
}
const post = (path: string, token: string, body: unknown = {}) =>
  new Request(`https://guard.2cstudio.app${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

function proof(at: number) {
  const nonce = makeNonce(SECRET, W, at);
  const issuedAt = new Date(at).toISOString();
  const sig = nacl.sign.detached(new TextEncoder().encode(siwsMessage(W, nonce, issuedAt)), kp.secretKey);
  return { nonce, issuedAt, signature: bs58.encode(sig) };
}

describe("fresh signature for Telegram changes", () => {
  it("lets a sign-in from the last 10 minutes link without signing again", async () => {
    const e = env();
    const r = await handleApi(post("/api/guard/link", issueToken(SECRET, W, now - 5 * 60_000)), e, "/api/guard/link", now);
    expect(r!.status).toBe(200);
  });

  it("asks an older sign-in to sign again, then accepts the signature and renews the token", async () => {
    const e = env();
    const old = issueToken(SECRET, W, now - 2 * 86_400_000);
    const refused = await handleApi(post("/api/guard/unlink", old), e, "/api/guard/unlink", now);
    expect(refused!.status).toBe(403);
    expect(((await refused!.json()) as any).error).toBe("resign");
    expect(e.writes).toHaveLength(0);
    const ok = await handleApi(post("/api/guard/unlink", old, { proof: proof(now) }), e, "/api/guard/unlink", now);
    expect(ok!.status).toBe(200);
    expect(typeof ((await ok!.json()) as any).token).toBe("string");
    // The signed proof's nonce is recorded (so it can't be used again), then the change itself.
    expect(e.writes.filter((w) => w.includes("used_nonces"))).toHaveLength(1);
    expect(e.writes.filter((w) => !w.includes("used_nonces"))).toHaveLength(1);
  });

  it("refuses a signature from another wallet", async () => {
    const e = env();
    const other = Keypair.generate();
    const p = proof(now);
    p.signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(siwsMessage(W, p.nonce, p.issuedAt)), other.secretKey));
    const r = await handleApi(post("/api/guard/link", issueToken(SECRET, W, now - 86_400_000), { proof: p }), e, "/api/guard/link", now);
    expect(r!.status).toBe(403);
  });
});
