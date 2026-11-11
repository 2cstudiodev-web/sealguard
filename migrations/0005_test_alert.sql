-- When the member last asked for a test alert from the page (rate limit: one a minute).
ALTER TABLE guards ADD COLUMN last_test_at INTEGER;
