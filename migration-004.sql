-- Apply schema.sql and migrations 001-003 first. Additive; safe to re-run.
CREATE TABLE IF NOT EXISTS voice_admissions (
  session_id TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('reserved','connected','closed'))
);
CREATE INDEX IF NOT EXISTS idx_admission_capacity ON voice_admissions(tenant_slug, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_admission_tenant_budget ON voice_admissions(tenant_slug, created_at);
CREATE INDEX IF NOT EXISTS idx_admission_ip_budget ON voice_admissions(ip_key, created_at);
CREATE TABLE IF NOT EXISTS background_events (
  event_id TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- Retain background_events for at least the queue's retention/replay horizon.
CREATE TABLE IF NOT EXISTS crm_contacts_secure (
  phone_key TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  contact_enc TEXT NOT NULL,
  total_calls INTEGER NOT NULL DEFAULT 0,
  last_call_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(phone_key, tenant_id)
);
