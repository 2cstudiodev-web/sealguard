-- SealGuard guard: one row per watched wallet, the quotes it was offered, the payments it made.
CREATE TABLE IF NOT EXISTS guards (
  wallet TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  paid_until INTEGER,                 -- ms; null or past = not active
  telegram_chat_id TEXT,              -- set once the user opened the bot with their link code
  link_code TEXT,                     -- one-time code for /start <code>
  link_code_expires INTEGER,
  baseline TEXT,                      -- WatchState JSON from the last check (or from activation)
  last_check_at INTEGER,
  last_alert_at INTEGER,
  checks INTEGER NOT NULL DEFAULT 0,
  alerts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS guards_active ON guards (paid_until, last_check_at);
CREATE INDEX IF NOT EXISTS guards_link ON guards (link_code);

CREATE TABLE IF NOT EXISTS quotes (
  id TEXT NOT NULL,
  token TEXT NOT NULL,
  wallet TEXT NOT NULL,
  base_units TEXT NOT NULL,
  display TEXT NOT NULL,
  usd TEXT NOT NULL,
  memo TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, token)
);

CREATE TABLE IF NOT EXISTS payments (
  signature TEXT PRIMARY KEY,
  wallet TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  token TEXT NOT NULL,
  base_units TEXT NOT NULL,
  usd TEXT NOT NULL,
  paid_at INTEGER NOT NULL,
  paid_until INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
