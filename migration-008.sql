-- ============================================================================
-- Migration 008: Immutable Agent Config Versions, Active Version Pointer &
--                Version-Attributed Turn Traces (Studio Dev -> Prod Pipeline)
-- ============================================================================
-- Additive and idempotent. Safe to run after schema.sql + migration-001..007.sql.
-- Does not ALTER or rebuild any existing table.
-- ============================================================================

-- 1. Immutable per-tenant configuration snapshots (additive customization + FAQ knowledge)
CREATE TABLE IF NOT EXISTS agent_config_versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_slug TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number >= 1),
  industry TEXT NOT NULL DEFAULT 'general',
  voice_id TEXT NOT NULL DEFAULT '2DkHmQavK9V2UzTYrMYT',
  tenant_customization TEXT NOT NULL DEFAULT '',
  knowledge_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'studio' CHECK(source IN ('baseline', 'studio', 'promoted_import', 'rollback_snapshot')),
  bundle_hash TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'super_admin',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(tenant_slug, version_number)
);
CREATE INDEX IF NOT EXISTS idx_agent_config_versions_tenant
  ON agent_config_versions(tenant_slug, version_number DESC);

-- 2. Active version pointer per tenant (instant rollback / roll-forward without deleting history)
CREATE TABLE IF NOT EXISTS agent_active_version (
  tenant_slug TEXT PRIMARY KEY REFERENCES tenants(slug) ON DELETE CASCADE,
  version_number INTEGER NOT NULL CHECK(version_number >= 1),
  activated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  activated_by TEXT NOT NULL DEFAULT 'super_admin'
);

-- 3. Version-attributed turn & simulation traces (ALTER-free companion to call_turns)
CREATE TABLE IF NOT EXISTS turn_traces (
  trace_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  tenant_slug TEXT NOT NULL REFERENCES tenants(slug) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL DEFAULT 1,
  environment TEXT NOT NULL DEFAULT 'staging',
  runtime_version TEXT NOT NULL DEFAULT 'v2.2.0',
  config_version INTEGER NOT NULL DEFAULT 1,
  llm_ttft_ms INTEGER NOT NULL DEFAULT 0,
  tts_ttfb_ms INTEGER NOT NULL DEFAULT 0,
  guard_violations_json TEXT NOT NULL DEFAULT '[]',
  barge_ins INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_turn_traces_tenant_created
  ON turn_traces(tenant_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_turn_traces_created
  ON turn_traces(created_at DESC);

-- 4. Studio simulator per-actor rate limit window (prevents unbounded AI cost)
CREATE TABLE IF NOT EXISTS studio_rate_limits (
  rate_key TEXT PRIMARY KEY,
  hits INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
