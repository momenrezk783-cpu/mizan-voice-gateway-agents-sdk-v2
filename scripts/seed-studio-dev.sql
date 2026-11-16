-- ============================================================================
-- Seed Data for Isolated `mizan-voice-studio-dev` D1 Database ONLY
-- ============================================================================
-- Seeds non-PII demo tenants (`alex-pilot-01`, `real-estate-cairo`, `legal-intake`)
-- and baseline version 1 snapshots so the Studio works out of the box.
-- NEVER run against production (`mizan-portal-db`).
-- ============================================================================

INSERT OR IGNORE INTO tenants (id, slug, name, industry, status, plan_tier, max_concurrent_sessions, theme_color)
VALUES
  ('c_alex-pilot-01',     'alex-pilot-01',     'عيادة الإسكندرية التجريبية', 'healthcare',  'active', 'pilot_14d', 3, '#10b981'),
  ('c_real-estate-cairo', 'real-estate-cairo', 'دار القاهرة العقارية',       'real_estate', 'active', 'pilot_14d', 3, '#6366f1'),
  ('c_legal-intake',      'legal-intake',      'مكتب ميزان للاستشارات',       'legal',       'active', 'pilot_14d', 3, '#f59e0b');

INSERT OR IGNORE INTO tenant_voice_config (tenant_slug, system_prompt, voice_id, allow_medical_advice, escalation_phone, ttl_seconds, tenant_customization)
VALUES
  ('alex-pilot-01',     'أنت ميزان، المساعد الصوتي المصري العام.', '2DkHmQavK9V2UzTYrMYT', 0, '+201000000001', 30, 'العيادة في سموحة بالإسكندرية. نرحب بحجز الكشوفات والاستفسار عن المواعيد فقط.'),
  ('real-estate-cairo', 'أنت ميزان، المساعد الصوتي المصري العام.', '2DkHmQavK9V2UzTYrMYT', 0, '+201000000002', 30, 'نساعد العملاء في حجز معاينات الوحدات السكنية والإدارية في القاهرة الجديدة والشيخ زايد.'),
  ('legal-intake',      'أنت ميزان، المساعد الصوتي المصري العام.', '2DkHmQavK9V2UzTYrMYT', 0, '+201000000003', 30, 'نستقبل طلبات تحديد مواعيد الاستشارات القانونية مع المحامين المختصين دون تقديم فتوى قانونية عبر الهاتف.');

INSERT OR IGNORE INTO tenant_knowledge (id, tenant_slug, category, faq_text)
VALUES
  ('k_alex_pilot_01_sched', 'alex-pilot-01',     'schedules', 'مواعيد العمل يومياً من 10 صباحاً حتى 10 مساءً ما عدا الجمعة. متاح حجز المواعيد والرد على كافة الاستفسارات.'),
  ('k_re_cairo_sched',      'real-estate-cairo', 'schedules', 'مواعيد المعاينات يومياً من 11 صباحاً حتى 7 مساءً بالتنسيق المسبق.'),
  ('k_legal_intake_sched',  'legal-intake',      'schedules', 'مواعيد استقبال الموكلين من السبت للخميس من 12 ظهراً حتى 8 مساءً.');

INSERT OR IGNORE INTO agent_config_versions (tenant_slug, version_number, industry, voice_id, tenant_customization, knowledge_json, source, bundle_hash, created_by)
VALUES
  ('alex-pilot-01',     1, 'healthcare',  '2DkHmQavK9V2UzTYrMYT', 'العيادة في سموحة بالإسكندرية. نرحب بحجز الكشوفات والاستفسار عن المواعيد فقط.', '[{"category":"schedules","faq_text":"مواعيد العمل يومياً من 10 صباحاً حتى 10 مساءً ما عدا الجمعة. متاح حجز المواعيد والرد على كافة الاستفسارات."}]', 'baseline', 'seed-v1-alex-pilot-01',     'system'),
  ('real-estate-cairo', 1, 'real_estate', '2DkHmQavK9V2UzTYrMYT', 'نساعد العملاء في حجز معاينات الوحدات السكنية والإدارية في القاهرة الجديدة والشيخ زايد.', '[{"category":"schedules","faq_text":"مواعيد المعاينات يومياً من 11 صباحاً حتى 7 مساءً بالتنسيق المسبق."}]', 'baseline', 'seed-v1-real-estate-cairo', 'system'),
  ('legal-intake',      1, 'legal',       '2DkHmQavK9V2UzTYrMYT', 'نستقبل طلبات تحديد مواعيد الاستشارات القانونية مع المحامين المختصين دون تقديم فتوى قانونية عبر الهاتف.', '[{"category":"schedules","faq_text":"مواعيد استقبال الموكلين من السبت للخميس من 12 ظهراً حتى 8 مساءً."}]', 'baseline', 'seed-v1-legal-intake',      'system');

INSERT OR IGNORE INTO agent_active_version (tenant_slug, version_number, activated_by)
VALUES
  ('alex-pilot-01',     1, 'system'),
  ('real-estate-cairo', 1, 'system'),
  ('legal-intake',      1, 'system');
