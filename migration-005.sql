-- Additive, repeatable. Apply after 001-004 and before deploying the matching Worker.
CREATE TABLE IF NOT EXISTS call_contact_details (
  tenant_slug TEXT NOT NULL,
  session_id TEXT NOT NULL,
  details_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (tenant_slug, session_id)
);
CREATE TABLE IF NOT EXISTS quote_requests (
  id TEXT PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  details_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacting','closed')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_quote_status_time ON quote_requests(status,created_at DESC);
CREATE TABLE IF NOT EXISTS quote_intake_limits (
  rate_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL,
  reset_at INTEGER NOT NULL,
  last_request TEXT NOT NULL
);
