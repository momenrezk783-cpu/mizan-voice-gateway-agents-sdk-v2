/** Public voice admission: signed single-use tickets plus atomic D1 capacity/budgets. */
import {settleCallUsage} from './billing';
export const MAX_CALL_SECONDS = 25 * 60;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const enc = new TextEncoder();
const b64 = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (data: string) => Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
async function key(secret: string) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must contain at least 32 characters');
  return crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign','verify']);
}
export async function privateVoiceKey(secret: string, value: string): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`voice-ip:v1:${value}`))));
}
export interface CallTicket { slug: string; sessionId: string; origin: string; exp: number }
export async function signCallTicket(ticket: CallTicket, secret: string): Promise<string> {
  const payload = b64(enc.encode(JSON.stringify(ticket)));
  const signature = await crypto.subtle.sign('HMAC', await key(secret), enc.encode(`voice-call:v1:${payload}`));
  return `${payload}.${b64(new Uint8Array(signature))}`;
}
export async function verifyCallTicket(token: string, secret: string, slug: string, sessionId: string, origin: string): Promise<boolean> {
  try {
    if (token.length > 2048) return false;
    const parts = token.split('.');
    if (parts.length !== 2) return false;
    if (!await crypto.subtle.verify('HMAC', await key(secret), unb64(parts[1]), enc.encode(`voice-call:v1:${parts[0]}`))) return false;
    const t: CallTicket = JSON.parse(new TextDecoder().decode(unb64(parts[0])));
    const now = Math.floor(Date.now()/1000);
    return t.slug === slug && t.sessionId === sessionId && t.origin === origin && t.exp > now && t.exp <= now + 60;
  } catch { return false; }
}
export async function reserveVoiceCall(db: D1Database, slug: string, ipKey: string, max: number, origin: string, secret: string) {
  const now = Math.floor(Date.now()/1000), sessionId = crypto.randomUUID();
  // One SQLite statement serializes concurrent requests. Reservations count before DO creation.
  const period=new Date(now*1000).toISOString().slice(0,7);
  const results = await db.batch([db.prepare(`INSERT INTO voice_admissions
    (session_id, tenant_slug, ip_key, created_at, expires_at, state)
    SELECT ?, ?, ?, ?, ?, 'reserved'
    WHERE (SELECT COUNT(*) FROM voice_admissions WHERE tenant_slug = ? AND expires_at > ? AND state IN ('reserved','connected')) < ?
      AND (SELECT COUNT(*) FROM voice_admissions WHERE tenant_slug = ? AND created_at > ?) < 60
      AND (SELECT COUNT(*) FROM voice_admissions WHERE ip_key = ? AND created_at > ?) < 10
      AND ((SELECT monthly_seconds FROM tenant_billing WHERE tenant_slug=?) IS NULL OR
        COALESCE((SELECT max_call_seconds FROM tenant_billing WHERE tenant_slug=?),1500) +
        COALESCE((SELECT SUM(CASE WHEN started_at IS NULL AND expires_at<=? THEN 0 ELSE COALESCE(used_seconds,reserved_seconds) END)
          FROM usage_reservations WHERE tenant_slug=? AND period=?),0)
        <= (SELECT monthly_seconds FROM tenant_billing WHERE tenant_slug=?))`)
    .bind(sessionId,slug,ipKey,now,now+60,slug,now,max,slug,now-3600,ipKey,now-3600,slug,slug,now,slug,period,slug),
    db.prepare(`INSERT INTO usage_reservations(session_id,tenant_slug,period,reserved_seconds,rate_piasters,started_at,admitted_at,expires_at)
      SELECT session_id,tenant_slug,?,COALESCE((SELECT max_call_seconds FROM tenant_billing WHERE tenant_slug=?),1500),
      COALESCE((SELECT rate_piasters_per_minute FROM tenant_billing WHERE tenant_slug=?),0),NULL,created_at,expires_at
      FROM voice_admissions WHERE session_id=? AND tenant_slug=? AND state='reserved'`)
      .bind(period,slug,slug,sessionId,slug)]);
  if (results[0].meta.changes !== 1) return null;
  return { sessionId, token: await signCallTicket({slug,sessionId,origin,exp:now+60},secret), expiresIn:60 };
}
export async function claimVoiceCall(db: D1Database, slug: string, sessionId: string): Promise<boolean> {
  const now = Math.floor(Date.now()/1000);
  const results = await db.batch([db.prepare(`UPDATE voice_admissions SET state = 'connected', expires_at = ? +
    COALESCE((SELECT reserved_seconds FROM usage_reservations WHERE session_id=? AND tenant_slug=?),1500)
    WHERE session_id = ? AND tenant_slug = ? AND state = 'reserved' AND expires_at > ?`)
    .bind(now,sessionId,slug,sessionId,slug,now),
    db.prepare(`UPDATE usage_reservations SET started_at=?,expires_at=(SELECT expires_at FROM voice_admissions WHERE session_id=? AND tenant_slug=?)
      WHERE session_id=? AND tenant_slug=? AND started_at IS NULL AND settled_at IS NULL
      AND EXISTS(SELECT 1 FROM voice_admissions WHERE session_id=? AND tenant_slug=? AND state='connected')`)
      .bind(now,sessionId,slug,sessionId,slug,sessionId,slug)]);
  return results[0].meta.changes === 1;
}
export async function releaseVoiceCall(db: D1Database, slug: string, sessionId: string) {
  await db.prepare(`UPDATE voice_admissions SET state = 'closed', expires_at = MIN(expires_at, unixepoch())
    WHERE session_id = ? AND tenant_slug = ?`).bind(sessionId,slug).run();
  await settleCallUsage(db,slug,sessionId);
}
