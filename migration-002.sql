-- ============================================================================
-- Mizan Voice Gateway — Migration 002: Conversation Manager & Learnings/CRM
-- ============================================================================
-- Additive, non-destructive D1 migration reconciling the Conversation Manager
-- with Mizan Voice Gateway v2 (`mizan-db`).
--
-- Run with:
--   npx wrangler d1 execute mizan-db --file=./migration-002.sql
-- ============================================================================

-- 1. Conversation Learnings Table (matches deployed D1 schema)
CREATE TABLE IF NOT EXISTS learnings (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    source_call_id TEXT,
    text TEXT NOT NULL,
    source TEXT NOT NULL,                         -- 'dialect' | 'flow' | 'objection' | 'domain_faq' | 'phrasing' | 'ordering' | 'pacing' | 'recovery' | 'confirmation' | 'intent_detection'
    confidence REAL NOT NULL,
    active INTEGER DEFAULT 1,
    applied_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_learnings_tenant_active
    ON learnings(tenant_id, active, confidence DESC, created_at DESC);

-- 2. Tenant-Scoped CRM Contacts Table (matches deployed D1 schema)
CREATE TABLE IF NOT EXISTS crm_contacts (
    phone TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    title TEXT,
    name TEXT,
    gender TEXT DEFAULT 'unknown',
    total_calls INTEGER DEFAULT 0,
    last_call_at INTEGER,
    last_call_summary TEXT,
    preferences_json TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (phone, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_contacts_tenant_phone
    ON crm_contacts(tenant_id, phone);

-- 3. Portal Client Queries / Callbacks / Tickets Table (matches deployed D1 schema)
CREATE TABLE IF NOT EXISTS client_queries (
    id TEXT PRIMARY KEY,
    client_name TEXT NOT NULL,
    client_email TEXT,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    tenant_id TEXT NOT NULL DEFAULT 'demo-clinic',
    client_phone TEXT
);
CREATE INDEX IF NOT EXISTS idx_client_queries_tenant
    ON client_queries(tenant_id, created_at DESC);

-- 4. Additive Conversation Manager Outcome & Metrics Columns on call_sessions
ALTER TABLE call_sessions ADD COLUMN intent_id TEXT;
ALTER TABLE call_sessions ADD COLUMN intent_resolved INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN handed_off INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN end_reason TEXT;
ALTER TABLE call_sessions ADD COLUMN total_turns INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN honorific_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN msa_hits INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN llm_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE call_sessions ADD COLUMN evaluation_score INTEGER;
ALTER TABLE call_sessions ADD COLUMN summary_ar TEXT;

-- 5. Update Global & Tenant Default ElevenLabs Voice ID
UPDATE global_voice_config SET voice_id = '2DkHmQavK9V2UzTYrMYT' WHERE id = 1;
UPDATE tenant_voice_config SET voice_id = '2DkHmQavK9V2UzTYrMYT';
