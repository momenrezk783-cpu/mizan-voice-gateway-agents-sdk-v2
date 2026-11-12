import {encryptPII,decryptPII,redactPII} from './crypto';
import {InputError} from './request-validation';
export interface PrivateContact {name:string;phone:string;email?:string}
export const PERSONAL_FIELDS = new Set(['name','phone','email']);
const digits=(s:string)=>s.replace(/[٠-٩۰-۹]/gu,c=>String(c.charCodeAt(0)-(c<='٩'?0x660:0x6f0)));
export function validatePrivateContact(body:unknown):PrivateContact {
  if(!body||typeof body!=='object'||Array.isArray(body))throw new InputError('Invalid contact form');
  const value=body as Record<string,unknown>;
  if(typeof value.name!=='string'||!/^\p{L}[\p{L}\p{M} .'-]{1,79}$/u.test(value.name.trim()))throw new InputError('Invalid contact name');
  if(typeof value.phone!=='string'||value.phone.length>30)throw new InputError('Invalid contact phone');
  let phone=digits(value.phone).replace(/[\s()+.-]/g,'');
  if(phone.startsWith('0020'))phone=phone.slice(4);else if(phone.startsWith('20'))phone=phone.slice(2);
  if(/^1[0125]\d{8}$/u.test(phone))phone='0'+phone;
  if(!/^01[0125]\d{8}$/u.test(phone))throw new InputError('Invalid Egyptian mobile number');
  if(value.email!==undefined&&value.email!==''&&(typeof value.email!=='string'||value.email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.email)))throw new InputError('Invalid contact email');
  return {name:value.name.trim(),phone,...(value.email?{email:String(value.email).trim().toLowerCase()}: {})};
}
export async function saveCallContact(db:D1Database,tenantSlug:string,sessionId:string,contact:PrivateContact,key:string){
  const encrypted=await encryptPII(JSON.stringify({...contact,tenantSlug,sessionId}),{CONTACT_ENC_KEY:key});
  const result=await db.prepare(`INSERT INTO call_contact_details (tenant_slug,session_id,details_enc,updated_at)
    SELECT ?,?,?,unixepoch() WHERE EXISTS (SELECT 1 FROM call_sessions WHERE id=? AND tenant_slug=? AND call_status='active')
    ON CONFLICT(tenant_slug,session_id) DO UPDATE SET details_enc=excluded.details_enc,updated_at=excluded.updated_at`)
    .bind(tenantSlug,sessionId,encrypted,sessionId,tenantSlug).run();
  if(result.meta.changes!==1)throw new InputError('Call is no longer active',409);
}
export async function readCallContact(db:D1Database,tenantSlug:string,sessionId:string,key:string):Promise<PrivateContact|null>{
  const row=await db.prepare(`SELECT details_enc FROM call_contact_details WHERE tenant_slug=? AND session_id=?`).bind(tenantSlug,sessionId).first<{details_enc:string}>();
  if(!row)return null;
  const value=JSON.parse(await decryptPII(row.details_enc,{CONTACT_ENC_KEY:key}));
  if(value.tenantSlug!==tenantSlug||value.sessionId!==sessionId)throw new Error('Contact scope mismatch');
  return validatePrivateContact(value);
}
const escapeRx=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
/** Applies to known form fields and incidental recognized names; never a complete PII detector. */
export function maskContactText(text:string,contact:Partial<PrivateContact>={},extraNames:string[]=[]):string {
  let value=redactPII(text);
  const names=[contact.name??'',...extraNames].flatMap(n=>[n,...n.split(/\s+/u)]).filter(n=>n.length>=2).sort((a,b)=>b.length-a.length);
  for(const name of new Set(names))value=value.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRx(name)}(?![\\p{L}\\p{N}])`,'giu'),'[بيانات محمية]');
  if(contact.email)value=value.replace(new RegExp(escapeRx(contact.email),'giu'),'[بريد إلكتروني]');
  if(contact.phone)value=value.replace(new RegExp(escapeRx(contact.phone),'g'),'[رقم موبايل]');
  return value;
}
