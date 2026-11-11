-- Anonymous daily counters for 2C Studio: scans and fixes, accounts closed, rent returned, fee taken. No addresses.
CREATE TABLE IF NOT EXISTS daily_stats (
  day TEXT NOT NULL,          -- YYYY-MM-DD, UTC
  kind TEXT NOT NULL,         -- scan | fix
  n INTEGER NOT NULL DEFAULT 0,
  closes INTEGER NOT NULL DEFAULT 0,
  lamports INTEGER NOT NULL DEFAULT 0,
  fee INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);
