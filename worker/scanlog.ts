// A record of each scan (privacy notice, "Scanning"): the wallet address, when, how it was scanned, the result in
// numbers, where the visitor came from and the country Cloudflare reports. No IP address. Kept with no set end date.
// Read by 2C Control (monitor.2cstudio.app, behind Cloudflare Access) over a read-only D1 binding.
import bs58 from "bs58";

export type ScanVia = "connect" | "paste" | "link" | "mcp";
export const SCAN_VIA: ScanVia[] = ["connect", "paste", "link", "mcp"];

export type ScanRow = {
  at: number; address: string; via: ScanVia; score: number | null;
  critical: number; high: number; medium: number; low: number;
  reclaimAccounts: number; reclaimLamports: number; source: string | null; country: string | null;
};

/** The address when it is a real 32-byte Solana public key, else null (nothing is logged). */
export function validWallet(s: unknown): string | null {
  if (typeof s !== "string" || s.length < 32 || s.length > 44) return null;
  try { return bs58.decode(s).length === 32 ? s : null; } catch { return null; }
}

/** "google.com", "utm:chatgpt.com", "direct": short, plain characters only. */
export function cleanSource(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim().toLowerCase().replace(/[^a-z0-9.:_\-/]/g, "").slice(0, 80);
  return t || null;
}

/** Best effort: a failed write never breaks a scan. */
export async function logScan(db: D1Database, r: ScanRow): Promise<void> {
  try {
    await db.prepare(
      "INSERT INTO scan_log (at, address, via, score, critical, high, medium, low, reclaim_accounts, reclaim_lamports, source, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(r.at, r.address, r.via, r.score, r.critical, r.high, r.medium, r.low, r.reclaimAccounts, r.reclaimLamports, r.source, r.country).run();
  } catch (e) {
    console.error("scan log", e);
  }
}
