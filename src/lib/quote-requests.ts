import {encryptPII,decryptPII} from './crypto';
import {InputError} from './request-validation';
import {privateVoiceKey,UUID} from './voice-access';
export const QUOTE_STATUSES=['new','contacting','closed'] as const;
export const QUOTE_SERVICES=['voice-start','voice-growth','voice-private','engineering','automation','legaltech','cloud','general'];
interface QuoteDetails {name:string;email:string;phone:string;organization:string;service:string;description:string}
function details(body:Record<string,unknown>):QuoteDetails {
  const value=(key:string,max:number,min=0)=>{const v=body[key];if((v===undefined||v==='')&&min===0)return '';if(typeof v!=='string'||v.trim().length<min||v.length>max)throw new InputError('Invalid quote field');return v.trim();};
  const name=value('name',80,2),email=value('email',254,3),phone=value('phone',30),organization=value('organization',120),service=value('service',30,1),description=value('description',2000,10);
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)||!QUOTE_SERVICES.includes(service)||body.consent!==true||phone&&!/^\+?[\d٠-٩۰-۹ ()-]{7,30}$/u.test(phone))throw new InputError('Invalid quote input');
  return {name,email:email.toLowerCase(),phone,organization,service,description};
}
export async function submitQuote(body:Record<string,unknown>,ip:string,env:{DB:D1Database;SESSION_SECRET:string;CONTACT_ENC_KEY:string}) {
  if(body.website)return {accepted:true}; // Honeypot: do not store or echo personal data.
  if(typeof body.requestId!=='string'||!UUID.test(body.requestId))throw new InputError('Invalid request identifier');
  const contact=details(body),now=Math.floor(Date.now()/1000);
  const rateKey=await privateVoiceKey(env.SESSION_SECRET,'quote-rate:'+ip),requestKey=await privateVoiceKey(env.SESSION_SECRET,'quote-request:'+body.requestId);
  const id=crypto.randomUUID();
  const encrypted=await encryptPII(JSON.stringify({id,...contact}),env);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO quote_intake_limits (rate_key,hits,reset_at,last_request)
      SELECT ?,1,?,? WHERE NOT EXISTS (SELECT 1 FROM quote_requests WHERE request_key=?)
      ON CONFLICT(rate_key) DO UPDATE SET hits=CASE WHEN reset_at<=? THEN 1 ELSE hits+1 END,
      reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END,last_request=excluded.last_request
      WHERE (reset_at<=? OR hits<5) AND NOT EXISTS (SELECT 1 FROM quote_requests WHERE request_key=?)`)
      .bind(rateKey,now+900,requestKey,requestKey,now,now,now,requestKey),
    env.DB.prepare(`INSERT OR IGNORE INTO quote_requests (id,request_key,details_enc)
      SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM quote_intake_limits WHERE rate_key=? AND last_request=?)`)
      .bind(id,requestKey,encrypted,rateKey,requestKey)
  ]);
  const found=await env.DB.prepare(`SELECT id FROM quote_requests WHERE request_key=?`).bind(requestKey).first();
  if(!found)throw new InputError('Too many requests',429);
  return {accepted:true};
}
export async function listQuotes(env:{DB:D1Database;CONTACT_ENC_KEY:string},status?:string){
  if(status&&!QUOTE_STATUSES.includes(status as typeof QUOTE_STATUSES[number]))throw new InputError('Invalid quote status');
  const sql=`SELECT id,details_enc,status,created_at,updated_at FROM quote_requests${status?' WHERE status=?':''} ORDER BY created_at DESC LIMIT 100`;
  const stmt=env.DB.prepare(sql);
  const rows=await (status?stmt.bind(status):stmt).all<{id:string;details_enc:string;status:string;created_at:number;updated_at:number}>();
  return Promise.all(rows.results.map(async row=>{const contact=JSON.parse(await decryptPII(row.details_enc,env));if(contact.id!==row.id)throw new Error('Quote scope mismatch');return {id:row.id,status:row.status,created_at:row.created_at,updated_at:row.updated_at,...details({...contact,consent:true})};}));
}
export async function updateQuote(db:D1Database,id:string,status:unknown){
  if(typeof status!=='string'||!QUOTE_STATUSES.includes(status as typeof QUOTE_STATUSES[number]))throw new InputError('Invalid quote status');
  const result=await db.prepare(`UPDATE quote_requests SET status=?,updated_at=unixepoch() WHERE id=?`).bind(status,id).run();
  return result.meta.changes===1;
}
