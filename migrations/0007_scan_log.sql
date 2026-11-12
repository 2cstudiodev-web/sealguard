-- A record of each scan (privacy notice, "Scanning", from 2026-11-12): the wallet address, when, how it was scanned
-- (connect | paste | link | mcp), the result in numbers, where the visitor came from and the country Cloudflare
-- reports. No IP address. Rows older than 365 days are deleted by the cron (worker/scanlog.ts).
CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,              -- ms
  address TEXT NOT NULL,
  via TEXT NOT NULL,
  score INTEGER,                    -- 0–100; null for MCP list tools
  critical INTEGER NOT NULL DEFAULT 0,
  high INTEGER NOT NULL DEFAULT 0,
  medium INTEGER NOT NULL DEFAULT 0,
  low INTEGER NOT NULL DEFAULT 0,
  reclaim_accounts INTEGER NOT NULL DEFAULT 0,   -- empty accounts that could be closed
  reclaim_lamports INTEGER NOT NULL DEFAULT 0,   -- rent they hold
  source TEXT,
  country TEXT
);
CREATE INDEX IF NOT EXISTS scan_log_at ON scan_log (at);
CREATE INDEX IF NOT EXISTS scan_log_address ON scan_log (address, at);
