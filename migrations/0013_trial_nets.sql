-- Red-team review 17 Nov 2026: new wallets cost nothing, so the 20 free check_transaction checks on a wallet's first
-- API key could be farmed with throwaway wallets. The trial is now also limited per network (IPv4 /24 or IPv6 /48,
-- hashed with SESSION_SECRET): one trial per network every 30 days, and at most TRIALS_PER_DAY trials a day overall.
CREATE TABLE IF NOT EXISTS mcp_trial_nets (
  net TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mcp_trial_nets_at ON mcp_trial_nets(at);
