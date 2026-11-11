-- Member extras: when the current paid period started, the weekly all-clear and the monthly rent reminder.
ALTER TABLE guards ADD COLUMN activated_at INTEGER;
ALTER TABLE guards ADD COLUMN last_weekly_at INTEGER;
ALTER TABLE guards ADD COLUMN weekly_checks_base INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guards ADD COLUMN weekly_alerts_base INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guards ADD COLUMN last_claim_notice_at INTEGER;
