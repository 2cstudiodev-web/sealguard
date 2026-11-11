// Smoke test of the guard API against a running Worker (default http://localhost:8798): sign in with a throwaway
// keypair, read the status, ask for a quote. Run: node tools-api-smoke.mjs [baseUrl]
import nacl from "tweetnacl";
import bs58 from "bs58";

const base = process.argv[2] || "http://localhost:8798";
const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const j = async (path, body, token) => {
  const r = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return [r.status, await r.json().catch(() => ({}))];
};

console.log("health", JSON.stringify((await j("/health"))[1]));
const [s1, n] = await j("/api/auth/nonce", { wallet });
console.log("nonce", s1, n.nonce?.slice(0, 8));
const sig = bs58.encode(nacl.sign.detached(new TextEncoder().encode(n.message), kp.secretKey));
const [s2, v] = await j("/api/auth/verify", { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: sig });
console.log("verify", s2, v.token ? "token ok" : JSON.stringify(v));
const [s3, st] = await j("/api/guard", undefined, v.token);
console.log("status", s3, JSON.stringify(st));
const [s4, q] = await j("/api/guard/quote", {}, v.token);
console.log("quote", s4, JSON.stringify({ memo: q.memo, quotes: q.quotes, treasury: q.treasury }));
const [s5, bad] = await j("/api/guard/pay", { quoteId: q.quoteId, token: "SOL", signature: "5".repeat(64) }, v.token);
console.log("pay with a bogus signature", s5, JSON.stringify(bad));
const [s6, wrongSig] = await j("/api/auth/verify", { wallet, nonce: n.nonce, issuedAt: n.issuedAt, signature: bs58.encode(new Uint8Array(64)) });
console.log("verify with a bad signature", s6, JSON.stringify(wrongSig));
const [s7] = await j("/api/guard");
console.log("status without token", s7);
