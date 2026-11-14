import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {SqliteD1,importTs} from './helpers/runtime.mjs';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'mizan-hardening-'));
const db=new SqliteD1(path.join(tmp,'app.sqlite'));
const secret='local-test-session-secret-at-least-32-characters';
const encKey=Buffer.alloc(32,17).toString('base64');
const access=await importTs('src/lib/voice-access.ts');
const secure=await importTs('src/lib/secure-crm.ts');
const background=await importTs('src/lib/background.ts');
const privacy=await importTs('src/lib/crypto.ts');
const auth=await importTs('src/lib/auth.ts');
const {default:worker,MizanVoiceAgent}=await importTs('src/index.ts');
try {
  for(const file of ['schema.sql','migration-001.sql','migration-002.sql','migration-003.sql','migration-004.sql','migration-005.sql','migration-006.sql','migration-007.sql']) db.apply(file);
  db.apply('migration-004.sql'); // new migration is safely repeatable
  await db.prepare(`INSERT INTO tenants(id,slug,name,industry,max_concurrent_sessions) VALUES ('a','tenant-a','Business A','general',3),('b','tenant-b','Business B','general',1)`).run();
  await db.prepare(`INSERT INTO tenant_voice_config(tenant_slug,system_prompt) VALUES ('tenant-a','legacy')`).run();
  const now=Math.floor(Date.now()/1000),sessionId=crypto.randomUUID();
  const ticket={slug:'tenant-a',sessionId,origin:'https://example.test',exp:now+60};
  const token=await access.signCallTicket(ticket,secret);
  assert.equal(await access.verifyCallTicket(token,secret,ticket.slug,sessionId,ticket.origin),true);
  for(const [tok,slug,id,origin] of [[token+'x',ticket.slug,sessionId,ticket.origin],[token,'tenant-b',sessionId,ticket.origin],[token,ticket.slug,crypto.randomUUID(),ticket.origin],[token,ticket.slug,sessionId,'https://evil.test']]) assert.equal(await access.verifyCallTicket(tok,secret,slug,id,origin),false);
  assert.equal(await access.verifyCallTicket(await access.signCallTicket({...ticket,exp:now-1},secret),secret,ticket.slug,sessionId,ticket.origin),false);
  const reservation=await access.reserveVoiceCall(db,'tenant-a','ip-a',3,ticket.origin,secret);
  assert.ok(reservation);
  assert.equal(await access.claimVoiceCall(db,'tenant-a',reservation.sessionId),true);
  assert.equal(await access.claimVoiceCall(db,'tenant-a',reservation.sessionId),false);
  assert.equal(await access.claimVoiceCall(db,'tenant-b',reservation.sessionId),false);
  await access.releaseVoiceCall(db,'tenant-a',reservation.sessionId);
  // Race the exact production INSERT across independent SQLite connections.
  const admissionSql=db.history.find(sql=>sql.startsWith('INSERT INTO voice_admissions'));
  const race=`import sqlite3,json,sys,concurrent.futures,uuid,time
p=json.load(sys.stdin);now=int(time.time())
def reserve(i):
 c=sqlite3.connect(p['file'],timeout=30)
 try:
  cur=c.execute(p['sql'],(str(uuid.uuid4()),'tenant-a','race-'+str(i),now,now+60,'tenant-a',now,3,'tenant-a',now-3600,'race-'+str(i),now-3600,'tenant-a','tenant-a',now,'tenant-a',time.strftime('%Y-%m',time.gmtime(now)),'tenant-a'));c.commit();return cur.rowcount
 finally:c.close()
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: print(sum(ex.map(reserve,range(20))))`;
  assert.equal(Number(execFileSync('python3',['-c',race],{encoding:'utf8',input:JSON.stringify({file:db.file,sql:admissionSql})})),3);
  await db.prepare(`UPDATE voice_admissions SET state='closed',expires_at=0`).run();
  for(let i=0;i<10;i++) {
    const r=await access.reserveVoiceCall(db,'tenant-a','limited-ip',3,ticket.origin,secret);assert.ok(r);
    await access.releaseVoiceCall(db,'tenant-a',r.sessionId);
  }
  assert.equal(await access.reserveVoiceCall(db,'tenant-a','limited-ip',3,ticket.origin,secret),null);
  // Race the exact two-statement admission transaction against a monthly budget.
  await db.prepare(`INSERT INTO tenant_billing(tenant_slug,monthly_seconds,max_call_seconds) VALUES ('tenant-b',900,300)`).run();
  const usageSql=db.history.find(sql=>sql.startsWith('INSERT INTO usage_reservations'));
  const quotaRace=`import sqlite3,json,sys,concurrent.futures,uuid,time
p=json.load(sys.stdin);now=int(time.time());period=time.strftime('%Y-%m',time.gmtime(now))
def reserve(i):
 c=sqlite3.connect(p['file'],timeout=30);sid=str(uuid.uuid4());slug='tenant-b'
 try:
  c.execute('BEGIN IMMEDIATE')
  cur=c.execute(p['admission'],(sid,slug,'quota-'+str(i),now,now+60,slug,now,20,slug,now-3600,'quota-'+str(i),now-3600,slug,slug,now,slug,period,slug));admitted=cur.rowcount
  c.execute(p['usage'],(period,slug,slug,sid,slug));c.commit();return admitted
 finally:c.close()
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex: print(sum(ex.map(reserve,range(20))))`;
  assert.equal(Number(execFileSync('python3',['-c',quotaRace],{encoding:'utf8',input:JSON.stringify({file:db.file,admission:admissionSql,usage:usageSql})})),3);
  assert.equal((await db.prepare(`SELECT SUM(reserved_seconds) n FROM usage_reservations WHERE tenant_slug='tenant-b'`).first()).n,900);
  await db.prepare(`DELETE FROM usage_reservations WHERE tenant_slug='tenant-b'`).run();
  await db.prepare(`DELETE FROM voice_admissions WHERE tenant_slug='tenant-b'`).run();
  await db.prepare(`DELETE FROM tenant_billing WHERE tenant_slug='tenant-b'`).run();
  console.log('PASS ticket signature/expiry/scope/replay, concurrent capacity and IP budgets');

  await secure.writeSecureContact(db,'tenant-a','01012345678',{name:'Private Name',email:'private@example.com',lastSummary:'Private summary'},encKey);
  const stored=await db.prepare(`SELECT * FROM crm_contacts_secure`).first();
  for(const value of ['01012345678','Private Name','private@example.com','Private summary']) assert.ok(!JSON.stringify(stored).includes(value));
  assert.equal((await secure.readSecureContact(db,'tenant-a','01012345678',encKey)).name,'Private Name');
  assert.equal(await secure.readSecureContact(db,'tenant-b','01012345678',encKey),null);
  assert.notEqual(await secure.contactLookupKey(encKey,'tenant-a','01012345678'),await secure.contactLookupKey(encKey,'tenant-b','01012345678'));
  await assert.rejects(()=>secure.readSecureContact(db,'tenant-a','01012345678',''));
  await db.prepare(`INSERT INTO crm_contacts(phone,tenant_id,name,total_calls,updated_at) VALUES ('01112345678','tenant-a','Legacy Contact',4,?)`).bind(now).run();
  assert.deepEqual(await secure.migrateLegacyCrmContacts(db,encKey),{migrated:1,remaining:0});
  assert.equal((await secure.readSecureContact(db,'tenant-a','01112345678',encKey)).name,'Legacy Contact');
  assert.deepEqual(await secure.migrateLegacyCrmContacts(db,encKey),{migrated:0,remaining:0});
  for(const sample of ['٠١٠ ١٢٣٤ ٥٦٧٨','+20 (010) 1234-5678','private@example.com','۲۹۸۰۱۰۱۱۲۳۴۵۶۷']) {
    assert.match(privacy.redactPII(sample),/\[/);assert.ok(!privacy.redactPII(sample).includes('private@example.com'));
  }
  console.log('PASS encrypted CRM roundtrip, tenant separation, legacy migration and formatted PII redaction');

  const sid=crypto.randomUUID();
  await db.prepare(`INSERT INTO call_sessions(id,tenant_slug,call_status,started_at) VALUES (?,'tenant-a','active',?)`).bind(sid,now-30).run();
  const turn={type:'record_turn',sessionId:sid,tenantSlug:'tenant-a',speaker:'caller',turnIndex:1,transcript:'email private@example.com',occurredAt:now-10};
  const end={type:'end_session',sessionId:sid,tenantSlug:'tenant-a',occurredAt:now-5};
  const usage={type:'record_usage',sessionId:sid,tenantSlug:'tenant-a'};
  for(const msg of [turn,turn,end,{...end,occurredAt:now},usage,usage]) await background.processBackgroundMessage(msg,{DB:db});
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM call_turns WHERE session_id=?`).bind(sid).first()).n,1);
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM tenant_usage`).first()).n,1);
  assert.equal((await db.prepare(`SELECT ended_at FROM call_sessions WHERE id=?`).bind(sid).first()).ended_at,now-5);
  assert.ok(!(await db.prepare(`SELECT transcript_redacted FROM call_turns`).first()).transcript_redacted.includes('private@example.com'));
  await db.prepare(`CREATE TRIGGER reject_test_event BEFORE INSERT ON background_events WHEN NEW.event_id = 'rollback-event' BEGIN SELECT RAISE(ABORT,'test ledger failure'); END`).run();
  await assert.rejects(()=>background.processBackgroundMessage({...turn,eventId:'rollback-event',turnIndex:2},{DB:db}));
  assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM call_turns WHERE id='rollback-event'`).first()).n,0);
  await db.prepare(`DROP TRIGGER reject_test_event`).run();
  console.log('PASS duplicate deliveries, stable end timestamps and atomic rollback on dedupe-ledger failure');

  const env={DB:db,SESSION_SECRET:secret,CONTACT_ENC_KEY:encKey,TENANT_CONFIG:{get:async()=>null,put:async()=>{},delete:async()=>{}},VOICE_WS_BASE:'wss://example.test'};
  const ctx={waitUntil:()=>{}};
  const cookie=(await auth.createSessionResponse({id:'admin',email:'admin@example.test',role:'super_admin',tenantSlug:'tenant-a'},env)).split(';')[0];
  const request=(url,method='GET',body,extra={})=>new Request('https://example.test'+url,{method,headers:{Origin:'https://example.test',Cookie:cookie,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let response=await worker.fetch(request('/api/voice/token','POST',{slug:'tenant-b'}),env,ctx);assert.equal(response.status,200);
  const t=await response.json();
  const wsUrl='/agents/mizan-voice-agent/tenant-b?session_id='+t.sessionId+'&call_token='+t.token;
  response=await worker.fetch(request(wsUrl,'GET',undefined,{Upgrade:'websocket',Origin:''}),env,ctx);assert.equal(response.status,403);
  globalThis.__routeVoice=async(req)=>{assert.ok(!req.url.includes('call_token'));return {status:101};};
  assert.equal((await worker.fetch(request(wsUrl,'GET',undefined,{Upgrade:'websocket'}),env,ctx)).status,101);
  assert.equal((await worker.fetch(request(wsUrl,'GET',undefined,{Upgrade:'websocket'}),env,ctx)).status,409);
  assert.equal((await worker.fetch(request('/api/admin/tenants/tenant-a','PUT',{max_concurrent_sessions:0}),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/admin/tenants/missing','PUT',{name:'Missing'}),env,ctx)).status,404);
  assert.equal((await worker.fetch(request('/api/client/voice-config','PUT',{voice_id:'SavedVoice12345'}),env,ctx)).status,200);
  assert.equal((await worker.fetch(request('/api/client/voice-config','PUT',{allow_medical_advice:1}),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/admin/global-voice-config','PUT',{system_prompt:'Change persona'}),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/client/customization','PUT',{tenant_customization:'Open Sunday'}),env,ctx)).status,200);
  assert.equal((await worker.fetch(request('/api/client/customization','PUT',{unknown:true}),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/client/customization','PUT',{tenant_customization:'x'.repeat(66000)}),env,ctx)).status,413);
  const malformed=new Request('https://example.test/api/client/customization',{method:'PUT',headers:{Origin:'https://example.test','Content-Type':'application/json'},body:'null'});
  assert.equal((await worker.fetch(malformed,env,ctx)).status,400);
  // Failed upgrades return reserved capacity rather than blocking later calls.
  await access.releaseVoiceCall(db,'tenant-b',t.sessionId);
  const failedTicket=await (await worker.fetch(request('/api/voice/token','POST',{slug:'tenant-b'}),env,ctx)).json();
  globalThis.__routeVoice=async()=>new Response('Synthetic upgrade failure',{status:503});
  const failedUrl='/agents/mizan-voice-agent/tenant-b?session_id='+failedTicket.sessionId+'&call_token='+failedTicket.token;
  assert.equal((await worker.fetch(request(failedUrl,'GET',undefined,{Upgrade:'websocket'}),env,ctx)).status,503);
  assert.equal((await db.prepare(`SELECT state FROM voice_admissions WHERE session_id=?`).bind(failedTicket.sessionId).first()).state,'closed');
  console.log('PASS real Worker HTTP routes: admission, Origin, replay, failed-upgrade release, body bounds, validation and 404s');

  const live=await access.reserveVoiceCall(db,'tenant-a','lifecycle-ip',3,ticket.origin,secret);
  assert.ok(live);await access.claimVoiceCall(db,'tenant-a',live.sessionId);
  const queued=[];
  const agentEnv={...env,DEEPGRAM_API_KEY:'synthetic-stt-key',BACKGROUND_QUEUE:{send:async message=>queued.push(message)}};
  const agent=new MizanVoiceAgent({name:'tenant-a:'+live.sessionId},agentEnv);
  await agent.onStart();
  let closed=false;
  const connection={send:()=>{},close:()=>{closed=true;}};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>{
    assert.match(String(url),/^https:\/\/api\.deepgram\.com\//);
    return {status:101,webSocket:{readyState:1,accept(){},addEventListener(){},send(){},close(){}}};
  };
  try {
    await agent.onConnect(connection);
    assert.ok(agent.callDeadline>Date.now());
    const lease=await db.prepare(`SELECT expires_at FROM voice_admissions WHERE session_id=?`).bind(live.sessionId).first();
    assert.equal(agent.callDeadline,lease.expires_at*1000);
    agent.callDeadline=Date.now()-1;
    await agent.onMessage(connection,new ArrayBuffer(2));
    assert.equal(closed,true);assert.equal(agent.sessionClosed,true);assert.equal(agent.callTimer,null);
    assert.equal((await db.prepare(`SELECT state FROM voice_admissions WHERE session_id=?`).bind(live.sessionId).first()).state,'closed');
    assert.deepEqual(queued.map(m=>m.type),['end_session','record_usage']);
    assert.ok(Number.isInteger(queued[0].occurredAt));
    await agent.onClose(connection,1000,'duplicate close',true);
    assert.equal(queued.length,2);
  } finally {
    globalThis.fetch=originalFetch;
    await agent.onClose(connection,1000,'test cleanup',true);
  }
  // Cleanup may abandon old disconnected sessions, but cannot end a live lease.
  const oldLive=crypto.randomUUID(),oldStale=crypto.randomUUID();
  for(const id of [oldLive,oldStale]) await db.prepare(`INSERT INTO call_sessions(id,tenant_slug,call_status,started_at) VALUES (?,'tenant-a','active',?)`).bind(id,now-4000).run();
  await db.prepare(`INSERT INTO voice_admissions VALUES (?,'tenant-a','test-ip',?,?, 'connected')`).bind(oldLive,now-4000,now+300).run();
  let scheduled;
  await worker.scheduled({},env,{waitUntil:promise=>{scheduled=promise;}});await scheduled;
  assert.equal((await db.prepare(`SELECT call_status FROM call_sessions WHERE id=?`).bind(oldLive).first()).call_status,'active');
  assert.equal((await db.prepare(`SELECT call_status FROM call_sessions WHERE id=?`).bind(oldStale).first()).call_status,'abandoned');
  console.log('PASS agent deadline disconnect, capacity release, idempotent close and live-lease-safe cleanup');
} finally {fs.rmSync(tmp,{recursive:true,force:true});delete globalThis.__routeVoice;}
