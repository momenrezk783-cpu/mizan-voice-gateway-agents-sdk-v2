-- ============================================================================
-- Mizan Voice Gateway — Migration: Global Identity + Industry Guards
-- ============================================================================
-- Run AFTER the main schema.sql:
--   npx wrangler d1 execute mizan-db --remote --file=./migration-001.sql
-- ============================================================================

-- 1. Global Mizan Voice Config (super_admin ONLY — tenants cannot edit)
--    This IS the Mizan Egyptian identity. One row, id=1.
CREATE TABLE IF NOT EXISTS global_voice_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    system_prompt TEXT NOT NULL,
    voice_id TEXT NOT NULL DEFAULT 'P2DK6Lg0vxyKGYj3QOik',
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO global_voice_config (id, system_prompt, voice_id)
VALUES (
    1,
    'أنت ميزان، المساعد الصوتي المصري العام. تتحدث باللهجة المصرية بأسلوب ودود ومهني ومحترم. تجيب على أسئلة المتصلين وتساعدهم بحسن نية. أنت لست متخصصاً في مجال معين بل مساعد عام يتكيف مع أي نشاط تجاري أو خدمي. كن موجزاً في إجاباتك وواضحاً. إذا سُئلت عن شيء خارج نطاق معرفتك، اعتذر بأدب وحوّل المتصل للمنشأة المعنية.',
    'P2DK6Lg0vxyKGYj3QOik'
);

-- 2. Industry Guards (super_admin ONLY — tenants cannot disable)
--    Each industry has a safety guard that's ALWAYS active
CREATE TABLE IF NOT EXISTS industry_guards (
    industry TEXT PRIMARY KEY,
    guard_text TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO industry_guards (industry, guard_text) VALUES
    ('healthcare',       'لا تقدم أي تشخيص طبي أو نصائح علاجية أو جرعات دوائية. وجه المتصل لزيارة الطبيب أو الاتصال بالمنشأة.'),
    ('legal',            'لا تقدم استشارة قانونية ملزمة أو رأي قانوني محدد. أحّل المتصل لمحامٍ مختص.'),
    ('real_estate',      'لا تلتزم بأسعار محددة أو مواعيد تسليم. أكد أن الأسعار قابلة للتغيير.'),
    ('customer_service', ''),
    ('education',        'لا تحل الواجبات أو الاختبارات نيابة عن الطالب. وجهه للتعلم والفهم.'),
    ('general',          ''),
    ('automotive',       'لا تقدم نصائح فنية لصيانة المحركات. أحّل المتصل لمركز الصيانة المعتمد.'),
    ('finance',          'لا تقدم نصائح استثمارية أو مالية ملزمة. أحّل المتصل لمستشار مالي.'),
    ('hospitality',      ''),
    ('retail',           '');

-- 3. Add industry column to tenants
ALTER TABLE tenants ADD COLUMN industry TEXT NOT NULL DEFAULT 'healthcare';

-- 4. Add tenant_customization to tenant_voice_config
--    This is the ONLY field tenants can edit (ADDITIVE — they add context, not remove core)
ALTER TABLE tenant_voice_config ADD COLUMN tenant_customization TEXT DEFAULT '';

-- 5. Seed global config into KV cache
-- (This happens automatically on first request — no manual step needed)
