-- Operations additions, AFTER 001–006. Additive and repeatable; no existing table rebuild.
-- Null monthly budget preserves existing service until an administrator sets a limit.
CREATE TABLE IF NOT EXISTS tenant_billing (
 tenant_slug TEXT PRIMARY KEY REFERENCES tenants(slug),
 monthly_seconds INTEGER DEFAULT NULL CHECK(monthly_seconds IS NULL OR monthly_seconds >= 0),
 max_call_seconds INTEGER NOT NULL DEFAULT 1500 CHECK(max_call_seconds BETWEEN 30 AND 1500),
 rate_piasters_per_minute INTEGER NOT NULL DEFAULT 0 CHECK(rate_piasters_per_minute BETWEEN 0 AND 1000000),
 currency TEXT NOT NULL DEFAULT 'EGP'
);
CREATE TABLE IF NOT EXISTS usage_reservations (
 session_id TEXT PRIMARY KEY, tenant_slug TEXT NOT NULL, period TEXT NOT NULL,
 reserved_seconds INTEGER NOT NULL, used_seconds INTEGER,
 rate_piasters INTEGER NOT NULL, started_at INTEGER, admitted_at INTEGER NOT NULL DEFAULT(unixepoch()),
 expires_at INTEGER NOT NULL, settled_at INTEGER
);
CREATE INDEX IF NOT EXISTS usage_period ON usage_reservations(tenant_slug,period);
CREATE TABLE IF NOT EXISTS weekly_reports (
 tenant_slug TEXT NOT NULL, week_start INTEGER NOT NULL, week_end INTEGER NOT NULL,
 stats_json TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(tenant_slug,week_start)
);
CREATE TABLE IF NOT EXISTS calendar_integrations (
 tenant_slug TEXT PRIMARY KEY REFERENCES tenants(slug), provider TEXT NOT NULL CHECK(provider IN ('calcom','zoho','webhook')),
 config_json TEXT NOT NULL, secret_enc TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE IF NOT EXISTS booking_operations (
 tenant_slug TEXT NOT NULL, idempotency_key TEXT NOT NULL, session_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','confirmed')), external_id TEXT,
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), PRIMARY KEY(tenant_slug,idempotency_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_pending_booking_per_session
 ON booking_operations(tenant_slug,session_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS knowledge_versions (
 version_id INTEGER PRIMARY KEY AUTOINCREMENT, knowledge_id TEXT NOT NULL,
 tenant_slug TEXT NOT NULL, category TEXT NOT NULL, faq_text TEXT NOT NULL,
 operation TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
INSERT INTO knowledge_versions(knowledge_id,tenant_slug,category,faq_text,operation)
 SELECT k.id,k.tenant_slug,k.category,k.faq_text,'baseline' FROM tenant_knowledge k
 WHERE NOT EXISTS(SELECT 1 FROM knowledge_versions v WHERE v.knowledge_id=k.id AND v.tenant_slug=k.tenant_slug);
CREATE TRIGGER IF NOT EXISTS knowledge_insert_007 AFTER INSERT ON tenant_knowledge BEGIN
 INSERT INTO knowledge_versions(knowledge_id,tenant_slug,category,faq_text,operation)
 VALUES(NEW.id,NEW.tenant_slug,NEW.category,NEW.faq_text,'create'); END;
CREATE TRIGGER IF NOT EXISTS knowledge_update_007 AFTER UPDATE OF faq_text,category ON tenant_knowledge
 WHEN OLD.faq_text != NEW.faq_text OR OLD.category != NEW.category BEGIN
 INSERT INTO knowledge_versions(knowledge_id,tenant_slug,category,faq_text,operation)
 VALUES(NEW.id,NEW.tenant_slug,NEW.category,NEW.faq_text,'update'); END;
CREATE TABLE IF NOT EXISTS knowledge_gaps (
 id TEXT PRIMARY KEY, tenant_slug TEXT NOT NULL, session_id TEXT NOT NULL,
 turn_index INTEGER NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','reviewed','resolved','dismissed')),
 recommendation TEXT NOT NULL DEFAULT 'Review this question and add an approved FAQ answer.',
 created_at INTEGER NOT NULL DEFAULT(unixepoch()), UNIQUE(tenant_slug,session_id,turn_index)
);
-- Separate scoped state avoids ALTERs and duplicate copies of whole-call QA in every turn.
CREATE TABLE IF NOT EXISTS call_operations (
 session_id TEXT NOT NULL, tenant_slug TEXT NOT NULL, ai_paused INTEGER NOT NULL DEFAULT 0,
 escalation_target TEXT, evaluation_json TEXT, revision INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,tenant_slug)
);
