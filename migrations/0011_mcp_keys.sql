-- Paid MCP checks (check_transaction): API keys, prepaid checks and guard members' monthly allowance.
-- A key is stored as a salted hash only; the owner sees it once when it's made.
CREATE TABLE IF NOT EXISTS mcp_keys (
  key_hash TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  prefix TEXT NOT NULL,          -- first characters, so the owner can tell which key is active
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS mcp_keys_wallet ON mcp_keys (wallet);

CREATE TABLE IF NOT EXISTS mcp_credits (
  wallet TEXT PRIMARY KEY,
  credits INTEGER NOT NULL DEFAULT 0,   -- prepaid checks left
  member_month TEXT,                    -- "2026-11": the month member_used counts
  member_used INTEGER NOT NULL DEFAULT 0,
  used_total INTEGER NOT NULL DEFAULT 0
);

-- Check packs bought (the guard's yearly payments stay in payments).
CREATE TABLE IF NOT EXISTS mcp_payments (
  signature TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  token TEXT NOT NULL,
  base_units TEXT NOT NULL,
  usd TEXT NOT NULL,
  checks INTEGER NOT NULL,
  paid_at INTEGER NOT NULL
);
