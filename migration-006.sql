-- Repeatable identity and voice configuration update. Preserves custom tenant voices.
-- Run after migrations 001–005. Existing tables are not rebuilt or dropped.
CREATE TABLE IF NOT EXISTS _portal_assets (key TEXT PRIMARY KEY, html TEXT NOT NULL);

INSERT INTO _portal_assets (key,html)
VALUES ('elevenlabs_config','{"voice_id":"2DkHmQavK9V2UzTYrMYT","model_id":"eleven_v4_turbo","stability":0.5,"similarity_boost":0.75,"speed":1.0}')
ON CONFLICT(key) DO UPDATE SET html=json_set(
  CASE WHEN json_valid(html) THEN html ELSE '{}' END,
  '$.voice_id','2DkHmQavK9V2UzTYrMYT','$.stability',0.5,'$.similarity_boost',0.75,'$.speed',1.0
);

UPDATE global_voice_config SET voice_id='2DkHmQavK9V2UzTYrMYT',
  system_prompt='أنت ميزان، المساعد الصوتي المصري لمؤسسة ميزان (تحت التأسيس). لا تفترض اسم المتصل ولا تذكر أسماء أشخاص باعتبارهم هوية المؤسسة.',
  updated_at=unixepoch() WHERE id=1;
UPDATE tenants SET name='مؤسسة ميزان (تحت التأسيس)' WHERE slug='mizan-hq';
UPDATE tenant_voice_config SET voice_id='2DkHmQavK9V2UzTYrMYT',updated_at=unixepoch()
WHERE tenant_slug='mizan-hq' OR voice_id IN ('MX8opBj7bbi4G2cE9j2w','SAz9YHcvj6GT2YYXdXww','P2DK6Lg0vxyKGYj3QOik','JBFqnCBsd6RMkjVDRZzb','onwK4e9ZLuTAKqWW03F9');

-- Remove the superseded personal identity from HQ business text only.
UPDATE tenant_voice_config SET
  system_prompt=replace(replace(system_prompt,'مؤمن رزق','مؤسسة ميزان (تحت التأسيس)'),'مؤمن','مؤسسة ميزان (تحت التأسيس)'),
  tenant_customization=replace(replace(tenant_customization,'مؤمن رزق','مؤسسة ميزان (تحت التأسيس)'),'مؤمن','مؤسسة ميزان (تحت التأسيس)')
WHERE tenant_slug='mizan-hq';
UPDATE tenant_knowledge SET
  faq_text=replace(replace(faq_text,'مؤمن رزق','مؤسسة ميزان (تحت التأسيس)'),'مؤمن','مؤسسة ميزان (تحت التأسيس)')
WHERE tenant_slug='mizan-hq';

-- SQLite cannot ALTER a column DEFAULT in place. These triggers safely normalize
-- the old defaults on existing installations, without rebuilding populated tables.
CREATE TRIGGER IF NOT EXISTS mizan_tenant_voice_default_006
AFTER INSERT ON tenant_voice_config
WHEN NEW.voice_id IN ('MX8opBj7bbi4G2cE9j2w','SAz9YHcvj6GT2YYXdXww','P2DK6Lg0vxyKGYj3QOik','JBFqnCBsd6RMkjVDRZzb','onwK4e9ZLuTAKqWW03F9')
BEGIN
  UPDATE tenant_voice_config SET voice_id='2DkHmQavK9V2UzTYrMYT' WHERE tenant_slug=NEW.tenant_slug;
END;
CREATE TRIGGER IF NOT EXISTS mizan_global_voice_default_006
AFTER INSERT ON global_voice_config
WHEN NEW.voice_id IN ('MX8opBj7bbi4G2cE9j2w','SAz9YHcvj6GT2YYXdXww','P2DK6Lg0vxyKGYj3QOik','JBFqnCBsd6RMkjVDRZzb','onwK4e9ZLuTAKqWW03F9')
BEGIN
  UPDATE global_voice_config SET voice_id='2DkHmQavK9V2UzTYrMYT' WHERE id=NEW.id;
END;
