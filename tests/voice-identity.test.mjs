import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SqliteD1,importTs} from './helpers/runtime.mjs';
const guard=await importTs('src/lib/conversation-manager/guard.ts');
const tenant=await importTs('src/lib/tenant.ts');
const {MIZAN_PROFILE}=await importTs('src/lib/mizan-profile.ts');
const {renderPublicPage}=await importTs('src/lib/public-pages.ts');
const prompt=await importTs('src/lib/conversation-manager/prompt.ts');

for(const phrase of ['أنا معاك','معاك','اسمي معاك','أنا تمام','تمام','صباح الخير','معاكم ميزان']){
  assert.equal(guard.extractCallerTitleAndName(phrase).name,null,phrase);
}
assert.equal(guard.extractCallerTitleAndName('اسمي أحمد علي').name,'أحمد');
assert.equal(guard.extractCallerTitleAndName('اسمي صباح').name,'صباح','an explicit real name must remain valid');
for(const text of ['صباح الخير يا معاك','أهلا يا أحمد، أقدر أساعدك إزاي؟','مساء الخير يا دكتور أحمد','صباح الخير أحمد']){
  const safe=guard.sanitizeForSpeechWithViolations(text,{});
  assert.doesNotMatch(safe.text,/يا معاك|يا أحمد|دكتور أحمد|الخير أحمد/);
  assert.ok(safe.violations.length>0,text);
}
assert.equal(guard.sanitizeForSpeech('يا ريت توضح الطلب',{}),'يا ريت توضح الطلب');
assert.equal(guard.sanitizeForSpeech('Hello John, how can I help?',{}),'Hello, how can I help?');
assert.equal(guard.sanitizeForSpeech('Hi there',{}),'Hi there');
assert.equal(guard.sanitizeForSpeech('Hello John',{callerName:'John'}),'Hello John');
assert.match(guard.sanitizeForSpeech('أهلا يا أحمد',{callerName:'أحمد'}),/يا أحمد/);
assert.doesNotMatch(guard.resolvePersonAddressPolicy({callerName:'معاك'}).preferredAddress,/يا معاك/);
assert.equal(guard.resolvePersonAddressPolicy({role:'manager'}).firstName,null);
assert.deepEqual(tenant.DEFAULT_MIZAN_VOICE_SETTINGS,{stability:0.5,similarity_boost:0.75,speed:1});
const env={DB:{prepare:()=>({first:async()=>null})}};
assert.deepEqual(await tenant.getHQElevenLabsConfig(env),{voice_id:'2DkHmQavK9V2UzTYrMYT',model_id:'eleven_v4_turbo',stability:0.5,similarity_boost:0.75,speed:1});
const staleCache={TENANT_CONFIG:{get:async()=>({slug:'mizan-hq',name:'Superseded identity',status:'active'})}};
assert.equal((await tenant.resolveTenant('mizan-hq',staleCache)).name,MIZAN_PROFILE.status);
assert.equal((await tenant.resolveTenantByDomain('mizanconsult.com',staleCache)).name,MIZAN_PROFILE.status);
for(const route of ['/','/about','/privacy','/terms']){
  const html=renderPublicPage(route);
  assert.ok(html.includes('مؤسسة ميزان (تحت التأسيس)'));
  assert.doesNotMatch(html,/مؤمن|رزق/);
}
assert.doesNotMatch(JSON.stringify(MIZAN_PROFILE)+prompt.STATIC_MASTER_RULES,/مؤمن|رزق/);
assert.match(prompt.STATIC_MASTER_RULES,/Never invent or guess a caller name/);
console.log('PASS neutral identity, exact voice defaults and unknown-caller speech guards');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mizan-identity-'));
const db=new SqliteD1(path.join(tmp,'db.sqlite'));
try {
  // Emulate the old SQLite DEFAULT clauses on an already deployed database.
  for(const file of ['schema.sql','migration-001.sql','migration-002.sql','migration-003.sql','migration-004.sql','migration-005.sql']){
    const legacy=path.join(tmp,path.basename(file));
    fs.writeFileSync(legacy,fs.readFileSync(file,'utf8').replaceAll('2DkHmQavK9V2UzTYrMYT','SAz9YHcvj6GT2YYXdXww'));
    db.apply(legacy);
  }
  await db.prepare(`INSERT INTO tenants(id,slug,name) VALUES ('hq','mizan-hq','مؤمن رزق'),('c','custom','Custom business'),('n','new','New business')`).run();
  await db.prepare(`INSERT INTO tenant_voice_config(tenant_slug,system_prompt,tenant_customization,voice_id) VALUES ('mizan-hq','مؤمن رزق','مؤمن','OldVoice123'),('custom','Custom prompt','Custom facts','CustomVoice123')`).run();
  await db.prepare(`INSERT INTO tenant_knowledge(id,tenant_slug,category,faq_text) VALUES ('hq','mizan-hq','about','مؤمن رزق'),('c','custom','about','Custom facts')`).run();
  await db.prepare(`CREATE TABLE _portal_assets(key TEXT PRIMARY KEY,html TEXT NOT NULL)`).run();
  await db.prepare(`INSERT INTO _portal_assets VALUES ('elevenlabs_config',?)`).bind(JSON.stringify({voice_id:'OldVoice123',stability:.9,similarity_boost:.9,speed:.8,otherSetting:'keep'})).run();
  db.apply('migration-006.sql');db.apply('migration-006.sql');
  const saved=JSON.parse((await db.prepare(`SELECT html FROM _portal_assets WHERE key='elevenlabs_config'`).first()).html);
  assert.equal(saved.voice_id,'2DkHmQavK9V2UzTYrMYT');assert.equal(saved.stability,.5);assert.equal(saved.similarity_boost,.75);assert.equal(saved.speed,1);assert.equal(saved.otherSetting,'keep');
  const hq=await db.prepare(`SELECT * FROM tenant_voice_config WHERE tenant_slug='mizan-hq'`).first();
  assert.equal(hq.voice_id,saved.voice_id);assert.doesNotMatch(hq.system_prompt+hq.tenant_customization,/مؤمن|رزق/);
  assert.equal((await db.prepare(`SELECT voice_id FROM tenant_voice_config WHERE tenant_slug='custom'`).first()).voice_id,'CustomVoice123');
  await db.prepare(`INSERT INTO tenant_voice_config(tenant_slug,system_prompt) VALUES ('new','Default voice test')`).run();
  assert.equal((await db.prepare(`SELECT voice_id FROM tenant_voice_config WHERE tenant_slug='new'`).first()).voice_id,saved.voice_id);
  await db.prepare(`DELETE FROM global_voice_config WHERE id=1`).run();
  await db.prepare(`INSERT INTO global_voice_config(system_prompt) VALUES ('Fresh default fixture')`).run();
  assert.equal((await db.prepare(`SELECT voice_id FROM global_voice_config WHERE id=1`).first()).voice_id,saved.voice_id);
  assert.equal((await db.prepare(`SELECT name FROM tenants WHERE slug='mizan-hq'`).first()).name,MIZAN_PROFILE.status);
  assert.doesNotMatch((await db.prepare(`SELECT faq_text FROM tenant_knowledge WHERE tenant_slug='mizan-hq'`).first()).faq_text,/مؤمن|رزق/);
  console.log('PASS repeatable database upgrade, stored HQ settings, legacy SQL defaults and custom tenant preservation');
} finally {fs.rmSync(tmp,{recursive:true,force:true});}
