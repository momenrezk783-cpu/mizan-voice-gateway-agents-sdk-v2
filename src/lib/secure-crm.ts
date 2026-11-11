import { encryptPII, decryptPII } from './crypto';
export interface CrmContactRecord {
  phone:string; tenant_id:string; title:string|null; name:string|null; gender:CallerGender;
  total_calls:number; last_call_at:number|null; last_call_summary:string|null; preferences_json:string|null;
}
import type { CallerGender } from './conversation-manager/guard';
export async function contactLookupKey(secret: string, tenantId: string, phone: string) {
  if (!secret) throw new Error('CONTACT_ENC_KEY is required');
  const raw = Uint8Array.from(atob(secret),c=>c.charCodeAt(0));
  if (raw.length !== 32) throw new Error('CONTACT_ENC_KEY must be a base64 encoded 32-byte key');
  const key = await crypto.subtle.importKey('raw',raw,{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(JSON.stringify(['crm-phone-v1',tenantId,phone]))));
  return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
}
export async function readSecureContact(db:D1Database,tenantId:string,phone:string,secret:string):Promise<CrmContactRecord|null> {
  const phoneKey = await contactLookupKey(secret,tenantId,phone);
  const row = await db.prepare(`SELECT contact_enc,total_calls,last_call_at FROM crm_contacts_secure WHERE tenant_id = ? AND phone_key = ?`)
    .bind(tenantId,phoneKey).first<{contact_enc:string;total_calls:number;last_call_at:number|null}>();
  if (!row) return null;
  const contact = JSON.parse(await decryptPII(row.contact_enc,{CONTACT_ENC_KEY:secret})) as CrmContactRecord;
  if (contact.tenant_id !== tenantId || contact.phone !== phone) throw new Error('CRM contact scope mismatch');
  return {...contact,total_calls:row.total_calls,last_call_at:row.last_call_at};
}
export interface ContactUpdate {
  title?: string|null; name?: string|null; gender?:CallerGender;
  lastSummary?: string|null; lastCallAt?:number; email?:string|null;
}
export async function writeSecureContact(db:D1Database,tenantId:string,phone:string,update:ContactUpdate,secret:string):Promise<void> {
  if (!tenantId || !/^01[0125]\d{8}$/u.test(phone)) throw new Error('Invalid CRM contact');
  const phoneKey = await contactLookupKey(secret,tenantId,phone);
  const current = await readSecureContact(db,tenantId,phone,secret);
  const bounded = (v:string|null|undefined,max:number,fallback:string|null=null) => v ? v.trim().slice(0,max) : fallback;
  const now = Math.floor(Date.now()/1000);
  const contact:CrmContactRecord = {
    phone,tenant_id:tenantId,
    title:bounded(update.title,30,current?.title),name:bounded(update.name,60,current?.name),
    gender:update.gender && update.gender !== 'unknown' ? update.gender : current?.gender ?? 'unknown',
    total_calls:0,last_call_at:null,
    last_call_summary:bounded(update.lastSummary,300,current?.last_call_summary),
    preferences_json:update.email ? JSON.stringify({email:update.email.trim().toLowerCase().slice(0,120)}) : current?.preferences_json ?? null
  };
  const encrypted = await encryptPII(JSON.stringify(contact),{CONTACT_ENC_KEY:secret});
  await db.prepare(`INSERT INTO crm_contacts_secure (phone_key,tenant_id,contact_enc,total_calls,last_call_at,updated_at)
    VALUES (?,?,?,1,?,?) ON CONFLICT(phone_key,tenant_id) DO UPDATE SET
    contact_enc = excluded.contact_enc, total_calls = crm_contacts_secure.total_calls + 1,
    last_call_at = MAX(COALESCE(crm_contacts_secure.last_call_at,0),excluded.last_call_at), updated_at = excluded.updated_at`)
    .bind(phoneKey,tenantId,encrypted,update.lastCallAt ?? now,now).run();
}
/** Explicit admin operation. Each legacy row moves atomically; new secure data wins on conflict. */
export async function migrateLegacyCrmContacts(db:D1Database,secret:string) {
  const rows = await db.prepare(`SELECT * FROM crm_contacts ORDER BY tenant_id,phone LIMIT 50`).all<CrmContactRecord & {updated_at:number}>();
  for (const row of rows.results) {
    const phoneKey = await contactLookupKey(secret,row.tenant_id,row.phone);
    const encrypted = await encryptPII(JSON.stringify(row),{CONTACT_ENC_KEY:secret});
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO crm_contacts_secure (phone_key,tenant_id,contact_enc,total_calls,last_call_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .bind(phoneKey,row.tenant_id,encrypted,row.total_calls ?? 0,row.last_call_at,row.updated_at),
      db.prepare(`DELETE FROM crm_contacts WHERE tenant_id = ? AND phone = ?`).bind(row.tenant_id,row.phone)
    ]);
  }
  const remaining = await db.prepare(`SELECT COUNT(*) AS count FROM crm_contacts`).first<{count:number}>();
  return {migrated:rows.results.length,remaining:remaining?.count ?? 0};
}
