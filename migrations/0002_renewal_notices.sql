-- Renewal reminders: which paid_until each guard was last reminded about (7 days before) and told had ended,
-- so each message goes out once per paid period.
ALTER TABLE guards ADD COLUMN reminded_until INTEGER;
ALTER TABLE guards ADD COLUMN ended_notice_until INTEGER;
