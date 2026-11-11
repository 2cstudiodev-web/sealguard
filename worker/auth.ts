// Sign-in: the wallet signs a Sign In With Solana message holding a nonce we minted; we check the Ed25519
// signature and hand back a session token. Nonces and tokens are HMACs, so nothing is stored for them.
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";

const utf8 = new TextEncoder();
const NONCE_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DOMAIN = "guard.2cstudio.app";
export const STATEMENT = "Sign in to SealGuard. This is a signature, not a transaction: it moves nothing and costs nothing.";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

/** hex(ms) + HMAC(secret, wallet|ms): checked without storage. */
export function makeNonce(secret: string, wallet: string, now: number): string {
  const ts = now.toString(16).padStart(12, "0");
  const mac = hmac(sha256, utf8.encode(secret), utf8.encode(`nonce:${wallet}:${ts}`));
  return ts + hex(mac.slice(0, 12));
}

export function nonceIssuedAt(secret: string, wallet: string, nonce: string): number | null {
  if (!/^[0-9a-f]{36}$/.test(nonce)) return null;
  const ts = parseInt(nonce.slice(0, 12), 16);
  if (!Number.isFinite(ts)) return null;
  return makeNonce(secret, wallet, ts) === nonce ? ts : null;
}

/** The SIWS message the wallet signs (the same text the server rebuilds to verify). */
export function siwsMessage(wallet: string, nonce: string, issuedAt: string, domain = DOMAIN): string {
  return [`${domain} wants you to sign in with your Solana account:`, wallet, "", STATEMENT, "", `URI: https://${domain}`, "Version: 1", "Chain ID: mainnet", `Nonce: ${nonce}`, `Issued At: ${issuedAt}`].join("\n");
}

export async function verifyEd25519(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): Promise<boolean> {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}

export type SignIn = { wallet: string; nonce: string; issuedAt: string; signature: string };

/** Checks a signed sign-in; returns the wallet or the reason it was refused. */
export async function checkSignIn(secret: string, s: SignIn, now: number): Promise<{ ok: true; wallet: string } | { ok: false; reason: string }> {
  const issued = nonceIssuedAt(secret, s.wallet, s.nonce);
  if (issued === null) return { ok: false, reason: "bad_nonce" };
  if (now - issued > NONCE_TTL_MS || issued > now + 60_000) return { ok: false, reason: "nonce_expired" };
  let pk: Uint8Array, sig: Uint8Array;
  try {
    pk = bs58.decode(s.wallet);
    sig = bs58.decode(s.signature);
  } catch {
    return { ok: false, reason: "bad_encoding" };
  }
  const ok = await verifyEd25519(utf8.encode(siwsMessage(s.wallet, s.nonce, s.issuedAt)), sig, pk);
  return ok ? { ok: true, wallet: s.wallet } : { ok: false, reason: "bad_signature" };
}

/** base64url(JSON{w, exp}) + "." + base64url(HMAC). */
export function issueToken(secret: string, wallet: string, now: number, ttlMs = SESSION_TTL_MS): string {
  const payload = b64url(utf8.encode(JSON.stringify({ w: wallet, exp: now + ttlMs })));
  return `${payload}.${b64url(hmac(sha256, utf8.encode(secret), utf8.encode(payload)))}`;
}

export function verifyToken(secret: string, token: string, now: number): string | null {
  const dot = token.indexOf(".");
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = fromB64url(token.slice(dot + 1));
  if (!sig) return null;
  if (!timingSafeEqual(sig, hmac(sha256, utf8.encode(secret), utf8.encode(payload)))) return null;
  try {
    const raw = fromB64url(payload);
    const body = JSON.parse(new TextDecoder().decode(raw!));
    if (typeof body.w !== "string" || typeof body.exp !== "number" || body.exp < now) return null;
    return body.w;
  } catch {
    return null;
  }
}

export function bearer(request: Request): string | null {
  const h = request.headers.get("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** A short HMAC-derived secret for the Telegram webhook header, so the bot token itself never goes into a URL. */
export function webhookSecret(botToken: string): string {
  return hex(hmac(sha256, utf8.encode(botToken), utf8.encode("sealguard-webhook")).slice(0, 16));
}
