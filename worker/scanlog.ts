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

/**
 * 2C Studio's own use is not counted: a browser that has opened 2C Control carries the cookie `2c_own=1` (set for
 * all of 2cstudio.app), and the owner's and test wallets are listed in the table own_wallets.
 */
export function ownDevice(request: Request): boolean {
  return /(?:^|;\s*)2c_own=1(?:;|$)/.test(request.headers.get("cookie") ?? "");
}

export async function ownWallet(db: D1Database, address: string | null | undefined): Promise<boolean> {
  if (!address) return false;
  try { return Boolean(await db.prepare("SELECT 1 FROM own_wallets WHERE address = ?").bind(address).first()); } catch { return false; }
}

/** Best effort: a failed write never breaks a scan. Scans of 2C Studio's own wallets are not logged. */
export async function logScan(db: D1Database, r: ScanRow): Promise<void> {
  try {
    if (await ownWallet(db, r.address)) return;
    await db.prepare(
      "INSERT INTO scan_log (at, address, via, score, critical, high, medium, low, reclaim_accounts, reclaim_lamports, source, country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(r.at, r.address, r.via, r.score, r.critical, r.high, r.medium, r.low, r.reclaimAccounts, r.reclaimLamports, r.source, r.country).run();
  } catch (e) {
    console.error("scan log", e);
  }
}
