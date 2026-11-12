-- 2C Studio's own wallets (owner and test wallets): their scans, fixes, sign-ins and payments are not counted.
-- Filled by hand (wrangler d1 execute), not here: the repository is public. 2C Control reads it to leave them out.
CREATE TABLE IF NOT EXISTS own_wallets (
  address TEXT PRIMARY KEY,
  note TEXT
);
