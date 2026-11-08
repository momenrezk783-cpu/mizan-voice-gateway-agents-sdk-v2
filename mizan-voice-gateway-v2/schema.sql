-- ============================================================================
-- Mizan Consult — Multi-Tenant D1 Schema
-- Database: mizan-db (04efb171-e903-4f16-b9c2-9ab7a0f7c9a6)
-- Compliance: Egyptian Law No. 151 of 2020 (AES-GCM 256-bit PII encryption)
-- ============================================================================

-- 1. Tenant Registry (Organizations, Companies & Multi-Industry Businesses)
CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,                          -- e.g. 'c_al-nour-clinic'
    slug TEXT NOT NULL UNIQUE,                    -- e.g. 'al-nour', 'demo-video', 'mizan-hq'
    name TEXT NOT NULL,                           -- e.g. 'عيادات النور التخصصية'
    domain TEXT UNIQUE,                           -- Custom domain (e.g. 'al-nour.com')
    status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'suspended' | 'trial'
    plan_tier TEXT NOT NULL DEFAULT 'pilot_14d',  -- 'pilot_14d' | 'production_pbx'
    max_concurrent_sessions INTEGER NOT NULL DEFAULT 1,  -- Per-tenant noisy-neighbor guard
    theme_color TEXT NOT NULL DEFAULT '#0891b2',  -- Per-tenant brand accent color (hex)
    logo_url TEXT,                                -- Optional clinic logo URL
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_tenants_slug ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_domain ON tenants(domain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

-- 2. Tenant Dynamic Knowledge & FAQ
CREATE TABLE IF NOT EXISTS tenant_knowledge (
    id TEXT PRIMARY KEY,
    tenant_slug TEXT NOT NULL,
    category TEXT NOT NULL,                       -- 'pricing', 'schedules', 'doctors', 'insurance'
    faq_text TEXT NOT NULL,                        -- Live FAQ content injected into LLM context
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_tenant ON tenant_knowledge(tenant_slug);
CREATE INDEX IF NOT EXISTS idx_knowledge_tenant_cat ON tenant_knowledge(tenant_slug, category);

-- 3. Tenant Voice & Policy Configuration
CREATE TABLE IF NOT EXISTS tenant_voice_config (
    tenant_slug TEXT PRIMARY KEY,
    system_prompt TEXT NOT NULL,                  -- Personality, tone, Egyptian dialect rules
    voice_id TEXT NOT NULL DEFAULT 'SAz9YHcvj6GT2YYXdXww',  -- ElevenLabs voice ID
    allow_medical_advice INTEGER NOT NULL DEFAULT 0,  -- 0/1 guard against diagnoses
    escalation_phone TEXT,                        -- Emergency transfer number
    ttl_seconds INTEGER NOT NULL DEFAULT 30,     -- Prompt cache TTL
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);

-- 4. Inbound & Outbound Call Sessions (Tenant-Scoped & Encrypted PII)
CREATE TABLE IF NOT EXISTS call_sessions (
    id TEXT PRIMARY KEY,                          -- UUID v4 session ID
    tenant_slug TEXT NOT NULL,                    -- Scoped to clinic
    direction TEXT NOT NULL DEFAULT 'inbound',   -- 'inbound' | 'outbound'
    caller_name_enc TEXT,                         -- AES-GCM 256-bit encrypted patient name
    caller_phone_enc TEXT,                        -- AES-GCM 256-bit encrypted mobile number
    call_status TEXT NOT NULL DEFAULT 'completed', -- 'active' | 'completed' | 'abandoned'
    selected_doctor TEXT,
    selected_slot TEXT,                           -- e.g. 'Tomorrow 11:00 AM'
    booking_confirmed INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT (unixepoch()),
    ended_at INTEGER,
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON call_sessions(tenant_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON call_sessions(tenant_slug, call_status);

-- 5. Individual Dialogue Turns & Audit Trail
CREATE TABLE IF NOT EXISTS call_turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tenant_slug TEXT NOT NULL,
    turn_index INTEGER NOT NULL,
    speaker TEXT NOT NULL,                        -- 'caller' | 'agent'
    transcript_redacted TEXT NOT NULL,            -- PII redacted (numbers masked as [رقم موبايل])
    latency_ms INTEGER,                           -- Turn turnaround latency (target < 390ms)
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (session_id) REFERENCES call_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_turns_session ON call_turns(session_id, turn_index ASC);
CREATE INDEX IF NOT EXISTS idx_turns_tenant ON call_turns(tenant_slug, created_at DESC);

-- 6. Organization & Tenant Portal User Authentication
CREATE TABLE IF NOT EXISTS portal_users (
    id TEXT PRIMARY KEY,
    tenant_slug TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                  -- Web Crypto PBKDF2/Scrypt hash
    role TEXT NOT NULL DEFAULT 'clinic_admin',    -- 'super_admin' | 'clinic_admin'
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_portal_tenant ON portal_users(tenant_slug);
CREATE INDEX IF NOT EXISTS idx_portal_email ON portal_users(email);

-- 7. Per-Tenant Usage Metering (NEW — for pilot billing & noisy-neighbor prevention)
CREATE TABLE IF NOT EXISTS tenant_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_slug TEXT NOT NULL,
    metric TEXT NOT NULL,                         -- 'call_count', 'turn_count', 'minutes_used'
    value INTEGER NOT NULL DEFAULT 0,
    recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_date ON tenant_usage(tenant_slug, metric, recorded_at DESC);

-- 8. Per-Tenant API Keys (NEW — for Stage 2 PBX/SIP integration)
CREATE TABLE IF NOT EXISTS tenant_api_keys (
    id TEXT PRIMARY KEY,
    tenant_slug TEXT NOT NULL,
    key_hash TEXT NOT NULL,                       -- SHA-256 hash of the API key
    label TEXT NOT NULL DEFAULT 'pbx-integration',
    last_used_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    revoked INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_apikeys_tenant ON tenant_api_keys(tenant_slug, revoked);

-- 9. Per-Tenant Rate Limit Counters (NEW — backed by KV in production, D1 for audit)
CREATE TABLE IF NOT EXISTS rate_limit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_slug TEXT NOT NULL,
    endpoint TEXT NOT NULL,                       -- 'voice_ws', 'portal_api', 'public_page'
    blocked INTEGER NOT NULL DEFAULT 0,           -- 1 if rate limit was hit
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    FOREIGN KEY (tenant_slug) REFERENCES tenants(slug) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_ratelimit_tenant ON rate_limit_log(tenant_slug, created_at DESC);

-- ============================================================================
-- MIGRATION NOTES (from current deployment):
-- ============================================================================
-- If your existing D1 already has tables without tenant_slug columns,
-- run these ALTER statements BEFORE deploying the new Worker:
--
-- ALTER TABLE call_sessions ADD COLUMN tenant_slug TEXT;
-- ALTER TABLE call_turns ADD COLUMN tenant_slug TEXT;
-- ALTER TABLE portal_users ADD COLUMN tenant_slug TEXT;
--
-- Then backfill from your existing data and add the indexes above.
-- If starting fresh, just run this entire file via:
--   npx wrangler d1 execute mizan-db --file=./schema.sql
-- ============================================================================
