-- Security review, 12 Nov 2026.
-- A signed sign-in can be used once: its nonce is recorded until it would expire anyway (pruned by the cron).
CREATE TABLE IF NOT EXISTS used_nonces (
  nonce TEXT PRIMARY KEY,
  exp INTEGER NOT NULL
);
-- One payment per price quote, whatever signature string the client sends.
CREATE UNIQUE INDEX IF NOT EXISTS payments_quote ON payments (quote_id);
