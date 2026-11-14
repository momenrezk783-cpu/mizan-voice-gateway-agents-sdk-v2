import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {chromium,expect} from '@playwright/test';
import {SqliteD1,importTs} from './helpers/runtime.mjs';
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mizan-browser-'));
const db=new SqliteD1(path.join(temporary,'app.sqlite'));
const {default:worker}=await importTs('src/index.ts');
const auth=await importTs('src/lib/auth.ts');
for(const file of ['schema.sql','migration-001.sql','migration-002.sql','migration-003.sql','migration-004.sql','migration-005.sql','migration-006.sql','migration-007.sql'])db.apply(file);
await db.prepare(`INSERT INTO tenants(id,slug,name,industry,max_concurrent_sessions) VALUES ('hq','mizan-hq','Mizan Consult','general',3)`).run();
await db.prepare(`INSERT INTO tenant_voice_config(tenant_slug,system_prompt) VALUES ('mizan-hq','legacy')`).run();
const env={DB:db,SESSION_SECRET:'browser-test-session-secret-with-more-than-32-characters',CONTACT_ENC_KEY:Buffer.alloc(32,23).toString('base64'),TENANT_CONFIG:{get:async()=>null,put:async()=>{},delete:async()=>{}},VOICE_WS_BASE:''};
const adminCookie=await auth.createSessionResponse({id:'admin',email:'admin@example.test',role:'super_admin',tenantSlug:'mizan-hq'},env);
const server=http.createServer(async(req,res)=>{
  try {
    const base='http://127.0.0.1:'+server.address().port;
    if(req.url==='/host'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="ar"><body><h1>موقع المنشأة التجريبي</h1><script src="/embed/mizan-hq.js"></script></body></html>');return;}
    if(req.url==='/fixture-admin'){res.setHeader('Set-Cookie',adminCookie);res.writeHead(302,{Location:'/dashboard'});res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const input=new Request(base+req.url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Buffer.concat(chunks)})});
    const response=await worker.fetch(input,env,{waitUntil(){}});
    res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
  }catch{res.writeHead(500);res.end('Local fixture failed');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base='http://127.0.0.1:'+server.address().port;env.VOICE_WS_BASE=base.replace('http','ws');
let browser;
try {
  browser=await chromium.launch({headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['microphone']});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);await expect(page.getByRole('heading',{name:/يتحوّل إلى عمل/})).toBeVisible();
  for(const label of ['Mizan Voice بداية','Mizan Voice نمو','Mizan Voice Private','Mizan Coding & AI Engineering'])await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible();
  const publicText=await page.locator('main').innerText();assert.ok(!/4,500|4500|12,500|12500|امتثال كامل/.test(publicText));
  await expect(page.getByRole('heading',{name:'خلّينا نفهم احتياجاتك'})).toBeVisible();
  await page.getByLabel('اسم التواصل',{exact:true}).fill('Browser Example');
  await page.getByLabel('البريد الإلكتروني',{exact:true}).fill('browser-example@example.test');
  await page.getByLabel('الخدمة المطلوبة').selectOption('voice-start');
  await page.getByLabel('وصف مختصر للاحتياج').fill('A synthetic browser test inquiry for an appointment assistant.');
  await page.getByRole('checkbox').check();
  await page.route('**/api/public/quote-requests',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Synthetic failure"}'}));
  await page.getByRole('button',{name:'أرسل طلب عرض السعر المجاني'}).click();
  await expect(page.locator('#quote-status')).toContainText('تعذر حفظ الطلب');
  await expect(page.getByLabel('اسم التواصل',{exact:true})).toHaveValue('Browser Example');
  await page.unroute('**/api/public/quote-requests');
  await page.getByRole('button',{name:'أرسل طلب عرض السعر المجاني'}).click();
  await expect(page.locator('#quote-status')).toContainText('وصل طلب عرض السعر المجاني');
  await expect(page.getByLabel('اسم التواصل',{exact:true})).toHaveValue('');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM quote_requests`).first()).n,1);
  fs.mkdirSync('artifacts',{recursive:true});await page.screenshot({path:'artifacts/mizan-home-desktop.png',fullPage:true});
  for(const route of ['/about','/privacy','/terms']){await page.goto(base+route);await expect(page.locator('h1')).toBeVisible();await page.reload();await expect(page.locator('h1')).toBeVisible();}
  await page.setViewportSize({width:390,height:844});await page.goto(base);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:'artifacts/mizan-home-mobile.png',fullPage:true});
  await page.goto(base+'/fixture-admin');
  // First-visit onboarding opens asynchronously; dismiss it through its UI.
  await page.locator('#mz-tour-close-btn').click();
  await page.getByText('طلبات عروض الأسعار',{exact:true}).click();
  await expect(page.locator('#quote-requests-body')).toContainText('Browser Example');
  await page.locator('#quote-requests-body select').first().selectOption('contacting');
  await expect(page.locator('#quotes-status')).toContainText('تم تحديث الحالة');
  console.log('PASS desktop/mobile identity, navigation, quote failure/retry/success and authorized admin review');

  // Synthetic browser socket: no microphone data or contacts are sent to real providers.
  await context.addInitScript(()=>{
    window.__voiceSockets=[];window.__micCalls=0;
    const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia=options=>{window.__micCalls++;return getMedia(options)};
    class FakeSocket {
      static CONNECTING=0;static OPEN=1;static CLOSED=3;
      readyState=0;sent=[];frames=0;requestId='browser-contact-request';
      constructor(url){this.url=url;window.__voiceSockets.push(this);setTimeout(()=>{this.readyState=1;this.onopen?.({});},0);}
      emit(value){this.onmessage?.({data:JSON.stringify(value)});}
      send(value){if(typeof value!=='string'){this.frames++;return;}const msg=JSON.parse(value);this.sent.push(msg);
        if(msg.type==='contact_request')this.emit({type:'contact_required',requestId:this.requestId,fields:['name','phone','email']});
        if(msg.type==='contact_submit'||msg.type==='contact_cancel')this.emit({type:'contact_result',requestId:msg.requestId,ok:true});
        if(msg.type==='contact_resume')setTimeout(()=>this.emit({type:'contact_resumed',requestId:msg.requestId}),30);
      }
      close(){this.readyState=3;this.onclose?.({});}
    }
    window.WebSocket=FakeSocket;
  });
  await page.goto(base+'/c/mizan-hq');
  await page.getByRole('button',{name:'ابدأ المكالمة',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.__micCalls),0);
  await expect(page.locator('#status')).toContainText('اقرأ تنبيه الخصوصية');
  await page.locator('#voice-privacy-ack').check();await page.locator('#callBtn').click();
  await expect(page.locator('#callBtn')).toHaveClass(/active/);
  await page.waitForTimeout(500);
  const initialFrames=await page.evaluate(()=>window.__voiceSockets[0].frames);
  assert.ok(initialFrames>0,'real AudioWorklet must be producing PCM frames before the form');
  // Decode and play a real one-second WAV; raw VAD must not cut the reply.
  async function emitAudio(){await page.evaluate(()=>{
    const n=16000,buffer=new ArrayBuffer(44+n*2),v=new DataView(buffer);
    function str(offset,text){for(let i=0;i<text.length;i++)v.setUint8(offset+i,text.charCodeAt(i));}
    str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);
    for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/16000)*2000,true);
    window.__voiceSockets[0].onmessage({data:buffer});
  });}
  await emitAudio();await expect.poll(()=>page.evaluate(()=>playbackSources.size)).toBe(1);
  const duringPlayback=await page.evaluate(()=>window.__voiceSockets[0].frames);
  await page.evaluate(()=>window.__voiceSockets[0].emit({type:'control',command:'barge_in'}));
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>playbackSources.size),1,'echo VAD cannot stop active audio');
  assert.equal(await page.evaluate(()=>window.__voiceSockets[0].frames),duringPlayback,'speaker echo must not enter STT');
  await expect.poll(()=>page.evaluate(()=>playbackBusy)).toBe(false);
  await expect.poll(()=>page.evaluate(count=>window.__voiceSockets[0].frames>count,duringPlayback)).toBe(true);
  await emitAudio();await expect.poll(()=>page.evaluate(()=>playbackSources.size)).toBe(1);
  await page.locator('#interruptBtn').click();assert.equal(await page.evaluate(()=>playbackSources.size),0);
  await page.evaluate(()=>window.__voiceSockets[0].emit({type:'handoff',status:'human_required'}));
  assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),false);
  await page.evaluate(()=>window.__voiceSockets[0].emit({type:'handoff',status:'resumed'}));
  assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),true);
  console.log('PASS real WAV full playback despite echo VAD, microphone echo gating, natural completion and explicit interruption');
  await page.locator('#open-contact').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),false);
  assert.equal(await page.evaluate(()=>audioNode),null);
  await expect(page.getByRole('dialog')).toContainText('ميزان مش هيسمعك');
  const pausedCount=await page.evaluate(()=>window.__voiceSockets[0].frames);await page.waitForTimeout(350);
  assert.equal(await page.evaluate(()=>window.__voiceSockets[0].frames),pausedCount);
  await page.screenshot({path:'artifacts/mizan-private-contact.png',fullPage:true});
  await page.getByRole('dialog').getByLabel('الاسم',{exact:true}).fill('Browser Caller');
  await page.getByRole('dialog').getByLabel('رقم الموبايل المصري').fill('01098765432');
  await page.getByRole('dialog').getByRole('checkbox').check();
  await page.getByRole('button',{name:'حفظ واستكمال المكالمة'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#privacy-call-status')).toContainText('عاد');
  assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),true);
  await page.waitForTimeout(250);assert.ok(await page.evaluate(count=>window.__voiceSockets[0].frames>count,pausedCount));
  assert.equal(await page.evaluate(()=>document.querySelector('#private-contact-form [name=name]').value),'');
  await page.locator('#muteBtn').click();
  await page.locator('#open-contact').click();await page.getByRole('button',{name:'إلغاء واستكمال الاستفسارات'}).click();
  await expect(page.locator('#privacy-call-status')).toContainText('عاد');assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),false,'manual mute must survive form cancel');
  await page.locator('#open-contact').click();
  await page.evaluate(()=>window.__voiceSockets[0].emit({type:'status',status:'stt_unavailable'}));
  await expect(page.locator('#privacy-call-status')).toContainText('تعذر استئناف الصوت');
  assert.equal(await page.evaluate(()=>stream.getAudioTracks()[0].enabled),false);
  await page.getByRole('button',{name:'إلغاء واستكمال الاستفسارات'}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.locator('#callBtn').click();
  await page.goto(base+'/host');await page.getByRole('button',{name:'فتح نافذة المكالمة'}).click();
  await expect(page.locator('iframe')).toBeVisible();const frame=page.frameLocator('iframe');
  await expect(frame.locator('#voice-privacy-ack')).toBeVisible();
  await frame.locator('#voice-privacy-ack').check();await frame.locator('#callBtn').click();await expect(frame.locator('#callBtn')).toHaveClass(/active/);
  await frame.locator('#open-contact').click();await expect(frame.getByRole('dialog')).toBeVisible();
  await page.getByRole('button',{name:'إغلاق المكالمة'}).click();await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button',{name:'فتح نافذة المكالمة'}).click();await expect(page.frameLocator('iframe').locator('#private-contact')).not.toBeVisible();
  assert.deepEqual(errors,[]);
  console.log('PASS real microphone/worklet production, warning, pause/no-frame leakage, clean resume, cancel/mute preservation and embedded-call lifecycle');
} finally {
  if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});
}
