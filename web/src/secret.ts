// Catches a secret pasted where a wallet address goes (a seed phrase or a private key), in the browser, before
// anything is sent. People who look for a tool like this are the ones phishing sites ask for their seed phrase.
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

const SEED_LENGTHS = new Set([12, 15, 18, 21, 24]);
const WORD = /^[a-zA-Z]{3,8}$/; // BIP39 words are 3–8 letters

/**
 * A real Solana secret key is 64 bytes whose second half is the public key of the first half. Checking that
 * (Keypair.fromSecretKey throws otherwise) keeps a 64-byte transaction signature from being mistaken for one.
 */
function isSecretKey(bytes: Uint8Array | null): boolean {
  if (!bytes || bytes.length !== 64) return false;
  try { Keypair.fromSecretKey(bytes); return true; } catch { return false; }
}

function decode(s: string): Uint8Array | null {
  try {
    if (/^\[\s*\d{1,3}(\s*,\s*\d{1,3}){63}\s*\]$/.test(s)) return Uint8Array.from(JSON.parse(s) as number[]); // keypair file
    if (/^(0x)?[0-9a-fA-F]{128}$/.test(s)) return Uint8Array.from(s.replace(/^0x/, "").match(/../g)!, (h) => parseInt(h, 16));
    if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) return bs58.decode(s);
  } catch { /* not that format */ }
  return null;
}

/** True when the text looks like a seed phrase or a private key rather than a public address. */
export function looksSecret(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  const words = s.split(/\s+/);
  if (SEED_LENGTHS.has(words.length) && words.every((w) => WORD.test(w))) return true;
  // A phrase with a word missing or extra is still a phrase.
  if (words.length >= 11 && words.length <= 25 && words.filter((w) => WORD.test(w)).length >= 11) return true;
  return isSecretKey(decode(s));
}
