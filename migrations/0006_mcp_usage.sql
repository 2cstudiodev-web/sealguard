-- MCP tool calls per connection and hour (ip is a salted hash, never the address), for the rate limit.
CREATE TABLE IF NOT EXISTS mcp_usage (
  hour INTEGER NOT NULL,   -- unix time / 3600
  ip TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour, ip)
);
