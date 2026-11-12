import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SqliteD1,importTs} from './helpers/runtime.mjs';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mizan-profile-'));
const db=new SqliteD1(path.join(temp,'db.sqlite'));
const {default:worker,MizanVoiceAgent}=await importTs('src/index.ts');
const auth=await importTs('src/lib/auth.ts');
const contacts=await importTs('src/lib/private-contact.ts');
const access=await importTs('src/lib/voice-access.ts');
const env={DB:db,SESSION_SECRET:'local-test-secret-at-least-thirty-two-characters',CONTACT_ENC_KEY:Buffer.alloc(32,21).toString('base64'),TENANT_CONFIG:{get:async()=>null,put:async()=>{},delete:async()=>{}},VOICE_WS_BASE:'wss://example.test',DEEPGRAM_API_KEY:'synthetic-only',ELEVENLABS_TTS_KEY:'synthetic-only',PRIMARY_LLM:'test-primary',FALLBACK_LLM:'test-fallback'};
const ctx={waitUntil:()=>{}};
const origin='https://example.test';
const request=(url,method='GET',body,extra={})=>new Request(origin+url,{method,headers:{Origin:origin,'Content-Type':'application/json',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
const body=(overrides={})=>({requestId:crypto.randomUUID(),name:'Quote Sentinel',email:'quotesentinel@example.test',phone:'+201012345678',organization:'Example business',service:'voice-start',description:'A synthetic request with no real customer data.',consent:true,...overrides});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const originalFetch=globalThis.fetch,agents=[];
try {
  for(const file of ['schema.sql','migration-001.sql','migration-002.sql','migration-003.sql','migration-004.sql','migration-005.sql'])db.apply(file);
  db.apply('migration-005.sql');
  await db.prepare(`INSERT INTO tenants(id,slug,name,industry,domain,max_concurrent_sessions) VALUES ('a','tenant-a','Example A','general','customer.example',3),('b','tenant-b','Example B','general',NULL,1),('hq','mizan-hq','Mizan Consult','general',NULL,3)`).run();
  await db.prepare(`INSERT INTO tenant_voice_config(tenant_slug,system_prompt) VALUES ('tenant-a','legacy'),('mizan-hq','legacy')`).run();
  const payload=body();
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',payload),env,ctx)).status,202);
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',payload),env,ctx)).status,202);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM quote_requests`).first()).n,1,'retry must not create another request');
  const raw=JSON.stringify(await db.prepare(`SELECT * FROM quote_requests`).all());
  for(const value of [payload.name,payload.email,payload.phone,payload.description])assert.ok(!raw.includes(value));
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',body({consent:false})),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',body({email:'invalid'})),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',body({description:'x'.repeat(2100)})),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/public/quote-requests','POST',body({website:'bot.example'})),env,ctx)).status,202);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM quote_requests`).first()).n,1);
  const burst=await Promise.all(Array.from({length:10},()=>worker.fetch(request('/api/public/quote-requests','POST',body(),{'CF-Connecting-IP':'192.0.2.100'}),env,ctx)));
  assert.equal(burst.filter(r=>r.status===202).length,5);assert.equal(burst.filter(r=>r.status===429).length,5);
  assert.ok(burst.find(r=>r.status===429).headers.get('Retry-After'));
  assert.ok(!JSON.stringify(await db.prepare(`SELECT * FROM quote_intake_limits`).all()).includes('192.0.2.100'));
  const adminCookie=(await auth.createSessionResponse({id:'admin',email:'admin@example.test',role:'super_admin',tenantSlug:'tenant-a'},env)).split(';')[0];
  const clientCookie=(await auth.createSessionResponse({id:'client',email:'client@example.test',role:'clinic_admin',tenantSlug:'tenant-a'},env)).split(';')[0];
  assert.equal((await worker.fetch(request('/api/admin/quote-requests'),env,ctx)).status,401);
  assert.equal((await worker.fetch(request('/api/admin/quote-requests','GET',undefined,{Cookie:clientCookie}),env,ctx)).status,403);
  const listed=await worker.fetch(request('/api/admin/quote-requests','GET',undefined,{Cookie:adminCookie}),env,ctx);
  assert.equal(listed.status,200);assert.equal(listed.headers.get('Cache-Control'),'no-store');
  const quotes=(await listed.json()).requests;const quote=quotes.find(r=>r.name===payload.name);assert.ok(quote);
  assert.equal((await worker.fetch(request('/api/admin/quote-requests/'+quote.id,'PATCH',{status:'contacting'},{Cookie:adminCookie}),env,ctx)).status,200);
  assert.equal((await worker.fetch(request('/api/admin/quote-requests/'+quote.id,'PATCH',{status:'paid'},{Cookie:adminCookie}),env,ctx)).status,400);
  assert.equal((await worker.fetch(request('/api/admin/quote-requests/'+crypto.randomUUID(),'PATCH',{status:'closed'},{Cookie:adminCookie}),env,ctx)).status,404);
  console.log('PASS encrypted quote intake, retries, consent, validation, atomic rate limits and super-admin-only review');

  for(const route of ['/','/about','/privacy','/terms']){const page=await worker.fetch(request(route),env,ctx);assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('Mizan Consult'));assert.ok(html.includes('نشاط مستقل'));assert.ok(!html.includes('امتثال كامل'));}
  const embedded=await worker.fetch(request('/c/tenant-a/embed'),env,ctx);
  assert.equal(embedded.status,200);assert.equal(embedded.headers.get('X-Frame-Options'),null);
  assert.match(embedded.headers.get('Content-Security-Policy'),/frame-ancestors https:\/\/example.test https:\/\/customer.example/);
  const normal=await worker.fetch(request('/c/tenant-a'),env,ctx);assert.equal(normal.headers.get('X-Frame-Options'),'DENY');
  assert.match(await normal.text(),/voice-privacy-ack/);
  const widget=await worker.fetch(request('/embed/tenant-a.js'),env,ctx);assert.match(await widget.text(),/createElement\('iframe'\)/);
  console.log('PASS public identity/policy routes and narrowly scoped iframe embedding');

  const modelRequests=[],ttsRequests=[],evaluationRequests=[],queued=[],sockets=[],sent=[];
  env.BACKGROUND_QUEUE={send:async m=>queued.push(m)};env.VOICE_METRICS={writeDataPoint(){}};
  env.AI={run:async (model,input)=>{evaluationRequests.push(JSON.stringify(input));return {response:JSON.stringify({score_overall:90,call_summary_ar:'A synthetic call summary.',candidate_learnings:[]})};}};
  globalThis.__mizanGenerate=async options=>{modelRequests.push(structuredClone(options));return {text:'استلمت طلبك، ونقدر نكمل التفاصيل.',finishReason:'stop'};};
  globalThis.fetch=async (url,options)=>{
    if(String(url).startsWith('https://api.deepgram.com/')){
      const socket={readyState:1,binary:[],controls:[],accept(){},addEventListener(){},send(data){if(typeof data==='string')this.controls.push(data);else this.binary.push(data);},close(){this.readyState=3;}};sockets.push(socket);return {status:101,webSocket:socket};
    }
    assert.ok(String(url).startsWith('https://api.elevenlabs.io/'));ttsRequests.push(JSON.parse(options.body));return new Response(new Uint8Array(160),{headers:{'Content-Type':'audio/mpeg'}});
  };
  const ticket=await access.reserveVoiceCall(db,'tenant-a','privacy-ip',3,origin,env.SESSION_SECRET);assert.ok(ticket);await access.claimVoiceCall(db,'tenant-a',ticket.sessionId);
  const agent=new MizanVoiceAgent({name:'tenant-a:'+ticket.sessionId},env);agents.push(agent);
  const connection={send:message=>sent.push(message),close(){}};
  await agent.onStart();await agent.onConnect(connection);await tick();await tick();
  const pcm=new Int16Array(2048).fill(10000).buffer;
  await agent.onMessage(connection,pcm);assert.ok(sockets[0].binary.length>0);
  await agent.handleFinalTranscript(connection,'عايز حد من الفريق يتصل بيا بخصوص الخدمات','ar');
  const contactRequired=sent.filter(m=>typeof m==='string').map(m=>JSON.parse(m)).find(m=>m.type==='contact_required');assert.ok(contactRequired);assert.equal(agent.contactPaused,true);
  const before=sockets.reduce((n,s)=>n+s.binary.length,0);
  await agent.onMessage(connection,pcm);await agent.handleFinalTranscript(connection,'هذه عينة يجب تجاهلها أثناء النموذج','ar');
  assert.equal(sockets.reduce((n,s)=>n+s.binary.length,0),before);assert.equal(modelRequests.length,0);
  const privateData={name:'كريم سليم',phone:'٠١٠ ٩٨٧٦ ٥٤٣٢',email:'private-sentinel@example.test'};
  await agent.onMessage({send(){},close(){}},JSON.stringify({type:'contact_submit',requestId:contactRequired.requestId,confirmed:true,contact:privateData}));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM call_contact_details`).first()).n,0);
  await agent.onMessage(connection,JSON.stringify({type:'contact_submit',requestId:crypto.randomUUID(),confirmed:true,contact:privateData}));
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM call_contact_details`).first()).n,0);
  await agent.onMessage(connection,JSON.stringify({type:'contact_submit',requestId:contactRequired.requestId,confirmed:true,contact:{...privateData,phone:'123'}}));assert.equal(agent.contactPaused,true);
  await agent.onMessage(connection,JSON.stringify({type:'contact_submit',requestId:contactRequired.requestId,confirmed:true,contact:privateData}));
  assert.equal(agent.contactPaused,true,'must stay paused until explicit resume handshake');
  const normalized=contacts.validatePrivateContact(privateData);
  assert.deepEqual(await contacts.readCallContact(db,'tenant-a',ticket.sessionId,env.CONTACT_ENC_KEY),normalized);
  assert.equal(await contacts.readCallContact(db,'tenant-b',ticket.sessionId,env.CONTACT_ENC_KEY),null);
  const stored=JSON.stringify(await db.prepare(`SELECT * FROM call_contact_details`).all());
  for(const secret of [normalized.name,normalized.phone,normalized.email])assert.ok(!stored.includes(secret));
  await agent.onMessage(connection,pcm);assert.equal(sockets.reduce((n,s)=>n+s.binary.length,0),before);
  await agent.onMessage(connection,JSON.stringify({type:'contact_resume',requestId:contactRequired.requestId}));await tick();await tick();
  assert.equal(agent.contactPaused,false);assert.equal(sockets.length,2);
  await agent.onMessage(connection,pcm);assert.ok(sockets[1].binary.length>0);assert.equal(sockets[0].binary.length,before);
  await agent.handleFinalTranscript(connection,'تمام نكمل الطلب','ar');
  assert.ok(modelRequests.length>0);
  for(const message of sent.filter(m=>typeof m==='string'&&m.includes('conversation_state'))){
    for(const value of [normalized.name,normalized.phone,normalized.email])assert.ok(!message.includes(value),'contact echoed in browser state');
  }
  const slotOutcome=await (await importTs('src/lib/conversation-manager/manager.ts')).executeTool(agent.createToolDeps(),agent.cmSession,'update_slots',{slots:{phone:'01111111111',name:'Injected Name'},confirmed_slots:['phone']});
  assert.ok(slotOutcome.rejected>=2);assert.equal(agent.cmSession.slots.phone.value,normalized.phone);
  // Open a new uncompleted request to cover cancel/expiry without accidentally executing it.
  agent.cmSession.actionResult=null;agent.cmSession.intent='book_appointment';agent.cmSession.state='DATA_COLLECTION';
  await agent.onMessage(connection,JSON.stringify({type:'contact_request'}));const pending=agent.contactPending;assert.ok(pending);
  pending.expires=Date.now()-1;
  await agent.onMessage(connection,JSON.stringify({type:'contact_submit',requestId:pending.id,confirmed:true,contact:privateData}));assert.equal(pending.phase,'editing');assert.equal(agent.contactPaused,true);
  await agent.onMessage(connection,JSON.stringify({type:'contact_cancel',requestId:pending.id}));assert.equal(agent.contactPaused,true);
  await agent.onMessage(connection,JSON.stringify({type:'contact_resume',requestId:pending.id}));await tick();await tick();assert.equal(agent.contactPaused,false);
  await agent.onClose(connection,1000,'test end',true);
  const external=JSON.stringify({modelRequests,ttsRequests,evaluationRequests,queued});
  for(const value of [normalized.name,'كريم','سليم',normalized.phone,normalized.email])assert.ok(!external.includes(value),'private value escaped into a provider or audit payload: '+value);
  assert.ok(evaluationRequests.length>0);
  assert.ok(ttsRequests.every(r=>r.language_code==='ar'));
  assert.equal(agent.cmSession.actionResult,null);
  console.log('PASS secure form ownership, consent, validation, encryption, audio gating, fresh STT resume, expiry/cancel and personal-data exclusion from LLM/TTS/evaluation/audit');

  const hq=new MizanVoiceAgent({name:'mizan-hq:'+crypto.randomUUID()},env);
  agents.push(hq);
  Object.assign(hq,{tenantSlug:'mizan-hq',sessionId:crypto.randomUUID(),initialized:true,elevenLabsConfig:{voice_id:'SavedVoice12345',model_id:'eleven_v4_turbo',stability:.4,similarity_boost:.9,speed:.9}});
  const count=modelRequests.length;
  await hq.respondToTranscript(connection,'بكام الاشتراك والسعر؟');assert.equal(modelRequests.length,count);
  assert.match(ttsRequests.at(-1).text,/عرض السعر مجاني/);assert.match(ttsRequests.at(-1).text,/info@mizanconsult.com/);
  console.log('PASS HQ free quotation response has no invented pricing and preserves approved public contact information');
} finally {
  for(const agent of agents){try{await agent.onClose(agent.activeConnection,1000,'cleanup',true);}catch{}}
  globalThis.fetch=originalFetch;delete globalThis.__mizanGenerate;fs.rmSync(temp,{recursive:true,force:true});
}
