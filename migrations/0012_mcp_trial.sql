-- A wallet's first API key comes with free checks, once (worker/mcpkeys.ts TRIAL_CHECKS).
ALTER TABLE mcp_credits ADD COLUMN trial_given INTEGER NOT NULL DEFAULT 0;
