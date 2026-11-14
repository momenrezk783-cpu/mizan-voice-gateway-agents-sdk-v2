import {settleCallUsage} from "./billing";
import {validatePrivateContact} from "./private-contact";
import { calendarConfig, calendarRequest, confirmedBookingId } from "./calendar-providers";
import { encryptPII, decryptPII, redactPII } from './crypto';
import { newSession, ingestCallerUtterance, snapshotSession, DEFAULT_INTENTS } from './conversation-manager/manager';
import { buildClock } from './conversation-manager/prompt';

export interface OperationsEnv {
 DB: D1Database; CONTACT_ENC_KEY: string;
 INTEGRATION_ALLOWED_HOSTS?: string;
}
const json = (value: unknown, status = 200) => Response.json(value, { status });
export function redactOps(text: string): string {
 return redactPII(text).replace(/\b\d{14}\b/g,'[ID]').replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[email]');
}
export function billingPeriod(now = new Date()): string { return now.toISOString().slice(0,7); }
export function previousWeek(now = Date.now()): [number,number] {
 const d = new Date(now); d.setUTCHours(0,0,0,0);
 d.setUTCDate(d.getUTCDate() - ((d.getUTCDay()+6)%7));
 const end = Math.floor(d.getTime()/1000); return [end-604800,end];
}
export function usageCharge(seconds: number, rate: number): number { return Math.ceil(seconds*rate/60); }
export async function settleUsage(env: OperationsEnv,slug:string,id:string,endedAt=Math.floor(Date.now()/1000)) {
 return settleCallUsage(env.DB,slug,id,endedAt);
}
export async function aggregateStats(env: OperationsEnv, slug: string, start: number, end: number) {
 return env.DB.prepare(`SELECT COUNT(*) AS total_calls,
 COALESCE(SUM(CASE WHEN (caller_phone_enc IS NOT NULL OR EXISTS(SELECT 1 FROM call_contact_details c WHERE c.session_id=call_sessions.id AND c.tenant_slug=call_sessions.tenant_slug)) AND intent_id IN ('book_appointment','callback_request') THEN 1 ELSE 0 END),0) AS qualified_leads,
 COALESCE(SUM(booking_confirmed),0) AS confirmed_bookings,
 COALESCE(SUM(handed_off),0) AS handoffs,
 COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END),0) AS ended_calls,
 COALESCE(SUM(CASE WHEN ended_at IS NOT NULL AND intent_resolved=1 AND handed_off=0 THEN 1 ELSE 0 END),0) AS resolved_without_handoff,
 ROUND(100.0*SUM(CASE WHEN ended_at IS NOT NULL AND intent_resolved=1 AND handed_off=0 THEN 1 ELSE 0 END)/NULLIF(SUM(CASE WHEN ended_at IS NOT NULL THEN 1 ELSE 0 END),0),2) AS resolution_rate_percent
 FROM call_sessions WHERE tenant_slug=? AND started_at>=? AND started_at<?`).bind(slug,start,end).first();
}
export async function runOperationsCron(env: OperationsEnv, reports=true) {
 await env.DB.prepare(`UPDATE usage_reservations SET used_seconds=CASE WHEN started_at IS NULL THEN 0 ELSE reserved_seconds END,settled_at=expires_at WHERE settled_at IS NULL AND expires_at<=unixepoch()`).run();
 if(!reports)return;
 // Paginated so report generation does not depend on D1's default row limit.
 const [start,end] = previousWeek(); let cursor='';
 while (true) {
  const tenants = await env.DB.prepare('SELECT slug FROM tenants WHERE slug>? ORDER BY slug LIMIT 50').bind(cursor).all<{slug:string}>();
  for (const t of tenants.results) {
   // Refresh the previous week to incorporate delayed post-call evaluation.
   const stats=await aggregateStats(env,t.slug,start,end);
   await env.DB.prepare(`INSERT INTO weekly_reports(tenant_slug,week_start,week_end,stats_json) VALUES(?,?,?,?)
    ON CONFLICT(tenant_slug,week_start) DO UPDATE SET stats_json=excluded.stats_json`)
    .bind(t.slug,start,end,JSON.stringify(stats)).run(); cursor=t.slug;
  }
  if(tenants.results.length<50) break;
 }
}
export async function captureKnowledgeGap(env: OperationsEnv, slug: string, session: string, turn: number, question: string, reply: string) {
 if (!/مش (?:عارف|متأكد|متوفر)|معنديش|ماعنديش|لا (?:أعرف|تتوفر)|don.t know|not (?:sure|available)|cannot answer/i.test(reply)) return;
 await env.DB.prepare(`INSERT OR IGNORE INTO knowledge_gaps(id,tenant_slug,session_id,turn_index,question) VALUES(?,?,?,?,?)`)
 .bind(crypto.randomUUID(),slug,session,turn,redactOps(question).slice(0,800)).run();
}
export function validateWebhook(url: string, allowed: string) {
 const u=new URL(url); const hosts=allowed.split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
 if(!u.hostname.includes('.') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(u.hostname) || u.hostname.includes(':') || /(?:^|\.)(?:localhost|local|internal)$/.test(u.hostname) || u.protocol!=='https:' || u.username || u.password || u.port && u.port!=='443' || !hosts.includes(u.hostname.toLowerCase())) throw new Error('Webhook host must be explicitly allowlisted');
 return u.toString();
}
export async function operationsApi(request: Request, env: OperationsEnv, slug: string, role: string): Promise<Response|null> {
 const url=new URL(request.url), p=url.pathname.replace('/api/client/','');
 const known=/^(usage|billing|reports\/weekly|metrics|integrations\/calendar|knowledge-gaps(?:\/[\w-]+)?|knowledge\/[\w-]+\/versions|sessions\/[\w-]+\/(?:handoff|resume)|qa\/simulate)$/;
 if(!known.test(p)) return null;
 if(request.method!=='GET' && request.headers.get('Origin')!==url.origin) return json({error:'Same-origin request required'},403);
 try {
 if(p==='usage' && request.method==='GET') {
  const period=url.searchParams.get('period')||billingPeriod(); if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return json({error:'Invalid month'},400);
  const usage=await env.DB.prepare(`SELECT COUNT(*) AS reservation_count,COALESCE(SUM(CASE WHEN started_at IS NOT NULL THEN 1 ELSE 0 END),0) AS calls,COALESCE(SUM(used_seconds),0) AS settled_seconds,
   COALESCE(SUM(CASE WHEN settled_at IS NULL THEN reserved_seconds ELSE 0 END),0) AS reserved_seconds,
   COALESCE(SUM(CASE WHEN used_seconds IS NOT NULL THEN CAST((used_seconds*rate_piasters+59)/60 AS INTEGER) ELSE 0 END),0) AS amount_piasters
   FROM usage_reservations WHERE tenant_slug=? AND period=?`).bind(slug,period).first();
  const plan=await env.DB.prepare('SELECT * FROM tenant_billing WHERE tenant_slug=?').bind(slug).first();
  return json({period,currency:'EGP',usage,plan,collection:'metering_only_no_payment_charge'});
 }
 if(p==='billing' && request.method==='PUT') {
  if(role!=='super_admin') return json({error:'Super admin required'},403);
  const b=await request.json<any>();
  if(![b.max_call_seconds,b.rate_piasters_per_minute].every(Number.isSafeInteger) || b.monthly_seconds!==null && (!Number.isSafeInteger(b.monthly_seconds)||b.monthly_seconds<0) || b.max_call_seconds<30 || b.max_call_seconds>1500 || b.rate_piasters_per_minute<0 || b.rate_piasters_per_minute>1000000) return json({error:'Invalid billing limits'},400);
  await env.DB.prepare(`INSERT INTO tenant_billing(tenant_slug,monthly_seconds,max_call_seconds,rate_piasters_per_minute) VALUES(?,?,?,?) ON CONFLICT(tenant_slug) DO UPDATE SET monthly_seconds=excluded.monthly_seconds,max_call_seconds=excluded.max_call_seconds,rate_piasters_per_minute=excluded.rate_piasters_per_minute`).bind(slug,b.monthly_seconds,b.max_call_seconds,b.rate_piasters_per_minute).run(); return json({ok:true});
 }
 if(p==='metrics' && request.method==='GET') {
  const end=Number(url.searchParams.get('end')||Math.floor(Date.now()/1000)); const start=Number(url.searchParams.get('start')||end-2592000);
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start) return json({error:'Invalid time range'},400);
  return json({start,end,stats:await aggregateStats(env,slug,start,end)});
 }
 if(p==='reports/weekly' && request.method==='GET') return json(await env.DB.prepare('SELECT * FROM weekly_reports WHERE tenant_slug=? ORDER BY week_start DESC LIMIT 52').bind(slug).all());
 if(p==='integrations/calendar') {
  if(request.method==='GET') return json({integration:await env.DB.prepare('SELECT provider,config_json,enabled,updated_at FROM calendar_integrations WHERE tenant_slug=?').bind(slug).first()});
  if(request.method==='DELETE') {await env.DB.prepare('DELETE FROM calendar_integrations WHERE tenant_slug=?').bind(slug).run();return json({ok:true});}
  if(request.method==='PUT') {
   const b=await request.json<any>();
   if(!['webhook','calcom','zoho'].includes(b.provider) || typeof b.api_key!=='string' || b.api_key.length<16 || b.api_key.length>4096) return json({error:'Use a supported provider and a 16–4096 character API key/token'},400);
   const config=calendarConfig(b,u=>validateWebhook(u,env.INTEGRATION_ALLOWED_HOSTS||''));
   const secret=await encryptPII(JSON.stringify({tenant:slug,key:b.api_key}),env);
   await env.DB.prepare(`INSERT INTO calendar_integrations(tenant_slug,provider,config_json,secret_enc) VALUES(?,?,?,?) ON CONFLICT(tenant_slug) DO UPDATE SET provider=excluded.provider,config_json=excluded.config_json,secret_enc=excluded.secret_enc,enabled=1,updated_at=unixepoch()`)
    .bind(slug,b.provider,JSON.stringify(config),secret).run(); return json({ok:true});
  }
 }
 if(p==='knowledge-gaps' && request.method==='GET') return json(await env.DB.prepare('SELECT * FROM knowledge_gaps WHERE tenant_slug=? ORDER BY created_at DESC LIMIT 100').bind(slug).all());
 const gap=p.match(/^knowledge-gaps\/([\w-]+)$/);
 if(gap && request.method==='PUT') {const b=await request.json<any>();if(!['open','reviewed','resolved','dismissed'].includes(b.status))return json({error:'Invalid status'},400);const changed=await env.DB.prepare('UPDATE knowledge_gaps SET status=? WHERE id=? AND tenant_slug=?').bind(b.status,gap[1],slug).run();return json({ok:changed.meta.changes===1},changed.meta.changes?200:404);}
 const versions=p.match(/^knowledge\/([\w-]+)\/versions$/);
 if(versions && request.method==='GET')return json(await env.DB.prepare('SELECT * FROM knowledge_versions WHERE tenant_slug=? AND knowledge_id=? ORDER BY version_id DESC LIMIT 100').bind(slug,versions[1]).all());
 const control=p.match(/^sessions\/([\w-]+)\/(handoff|resume)$/);
 if(control && request.method==='POST') {
  const pause=control[2]==='handoff';
  const results=await env.DB.batch([
   env.DB.prepare(`INSERT INTO call_operations(session_id,tenant_slug,ai_paused,revision)
    SELECT id,tenant_slug,?,1 FROM call_sessions WHERE id=? AND tenant_slug=? AND call_status='active' AND ended_at IS NULL
    ON CONFLICT(session_id,tenant_slug) DO UPDATE SET ai_paused=excluded.ai_paused,escalation_target=NULL,revision=call_operations.revision+1`).bind(pause?1:0,control[1],slug),
   env.DB.prepare(`UPDATE call_sessions SET handed_off=CASE WHEN ?=1 THEN 1 ELSE handed_off END WHERE id=? AND tenant_slug=? AND call_status='active' AND ended_at IS NULL`).bind(pause?1:0,control[1],slug)
  ]);
  return json({ok:results[0].meta.changes===1,mode:pause?'human_requested':'ai_resume_requested'},results[0].meta.changes?200:404);
 }
 if(p==='qa/simulate' && request.method==='POST') {
  const b=await request.json<any>();
  if(!Array.isArray(b.utterances)||b.utterances.length<1||b.utterances.length>20||b.utterances.some((x:any)=>typeof x!=='string'||x.length>1000))return json({error:'Supply 1–20 synthetic utterances, max 1000 characters each'},400);
  const state=newSession();const actions:any[]=[];const frames:any[]=[];
  const ctx:any={callId:'simulation',tenantId:slug,direction:'inbound',callerPhone:null,callerType:'unknown',caller:{firstName:null,title:null,gender:'unknown',lastSummary:null,lastCallAt:null,email:null},business:{name:'Simulation',agentName:'ميزان',agentGender:'male',hours:null,knowledge:null,handoffNumber:null,industry:'healthcare'},clock:buildClock('Africa/Cairo')};
  if(b.contact){const contact=validatePrivateContact(b.contact);for(const [field,value] of Object.entries(contact))state.slots[field]={value,confirmed:true,source:'caller',setAtTurn:0};}
  const deps:any={ctx,secureContact:true,intents:DEFAULT_INTENTS,runAction:async(action:string,slots:any,key:string)=>{actions.push({action,slots: Object.keys(slots),key});return {ok:true,detail:'MOCK_ONLY'};},canTransfer:()=>true};
  for(const text of b.utterances){await ingestCallerUtterance(deps,state,text);const frame=snapshotSession(state,DEFAULT_INTENTS);for(const field of ['name','phone','email'])if(frame.known[field])frame.known[field].value='[private]';frames.push(frame);}
  return json({mode:'deterministic_manager_simulation',external_actions:false,frames,actions});
 }
 return json({error:'Method not allowed'},405);
 } catch { return json({error:'Operation failed; validate input and server configuration'},400); }
}
// Durable idempotency: ambiguous provider errors stay pending for manual reconciliation.
// A calendar adapter MUST implement Idempotency-Key and return a stable booking_id.
export async function calendarBooking(env: OperationsEnv, slug: string, session: string, key: string, slots: Record<string,string>): Promise<{ok:boolean;detail:string;externalId?:string}|null> {
 const cfg=await env.DB.prepare('SELECT * FROM calendar_integrations WHERE tenant_slug=? AND enabled=1').bind(slug).first<any>();
 if(!cfg)return null;
 if(!await env.DB.prepare("SELECT 1 FROM call_sessions WHERE id=? AND tenant_slug=? AND call_status='active' AND ended_at IS NULL").bind(session,slug).first())return {ok:false,detail:'Session is inactive or belongs to another tenant'};
 if(!/^01[0125]\d{8}$/.test(slots.phone||'') || (slots.name||'').trim().length<2 || !slots.date || !slots.time)return {ok:false,detail:'Missing or invalid booking details'};
 const previous=await env.DB.prepare('SELECT status,external_id,session_id FROM booking_operations WHERE tenant_slug=? AND idempotency_key=?').bind(slug,key).first<any>();
 if(previous && previous.session_id!==session)return {ok:false,detail:'Booking key belongs to another session'};
 if(previous?.status==='confirmed')return {ok:true,detail:'Calendar booking confirmed',externalId:previous.external_id};
 if(previous)return {ok:false,detail:'Booking pending reconciliation; do not create another booking'};
 const pending=await env.DB.prepare("SELECT 1 FROM booking_operations WHERE tenant_slug=? AND session_id=? AND status='pending'").bind(slug,session).first();
 if(pending)return {ok:false,detail:'An earlier booking is unresolved; request human reconciliation'};
 const config=JSON.parse(cfg.config_json);
 if(cfg.provider==='webhook')validateWebhook(config.url,env.INTEGRATION_ALLOWED_HOSTS||'');
 const secret=JSON.parse(await decryptPII(cfg.secret_enc,env));if(secret.tenant!==slug)throw new Error('Credential tenant mismatch');
 let providerRequest;
 try { providerRequest=calendarRequest(cfg.provider,config,secret.key,slots,key,slug,session); } catch {return {ok:false,detail:'Calendar requires a valid date/time and attendee email where applicable'};}
 const claim=await env.DB.prepare(`INSERT OR IGNORE INTO booking_operations(tenant_slug,idempotency_key,session_id,status) VALUES(?,?,?,'pending')`).bind(slug,key,session).run();
 if(!claim.meta.changes)return {ok:false,detail:'Booking already in progress or pending reconciliation'};
 try {
  const r=await fetch(providerRequest.url,providerRequest.init);
  if(!r.ok)return {ok:false,detail:'Calendar did not confirm; manual reconciliation required'};
  const result=await r.json<any>();
  const bookingId=confirmedBookingId(cfg.provider,result);
  if(!bookingId)return {ok:false,detail:'Calendar confirmation missing; manual reconciliation required'};
  await env.DB.prepare(`UPDATE booking_operations SET status='confirmed',external_id=? WHERE tenant_slug=? AND idempotency_key=?`).bind(bookingId,slug,key).run();
  return {ok:true,detail:'Calendar booking confirmed',externalId:bookingId};
 }catch{return {ok:false,detail:'Calendar timeout/error; manual reconciliation required'};}
}
