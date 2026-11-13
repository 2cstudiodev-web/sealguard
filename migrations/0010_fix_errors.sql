-- Why fixes fail: the error text a fix ran into (wallet refusal, network error), with wallet addresses removed.
-- No wallet address, no IP. The newest 500 are kept. Steps of the fix flow are counted in daily_stats as "step:<name>".
CREATE TABLE IF NOT EXISTS fix_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  app INTEGER NOT NULL DEFAULT 0,
  place TEXT NOT NULL,
  message TEXT NOT NULL
);
