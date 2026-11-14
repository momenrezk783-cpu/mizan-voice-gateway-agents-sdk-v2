/** Public voice admission: signed single-use tickets plus atomic D1 capacity/budgets. */
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
  const result = await db.prepare(`INSERT INTO voice_admissions
    (session_id, tenant_slug, ip_key, created_at, expires_at, state)
    SELECT ?, ?, ?, ?, ?, 'reserved'
    WHERE (SELECT COUNT(*) FROM voice_admissions WHERE tenant_slug = ? AND expires_at > ? AND state IN ('reserved','connected')) < ?
      AND (SELECT COUNT(*) FROM voice_admissions WHERE tenant_slug = ? AND created_at > ?) < 60
      AND (SELECT COUNT(*) FROM voice_admissions WHERE ip_key = ? AND created_at > ?) < 10`)
    .bind(sessionId,slug,ipKey,now,now+60,slug,now,max,slug,now-3600,ipKey,now-3600).run();
  if (result.meta.changes !== 1) return null;
  return { sessionId, token: await signCallTicket({slug,sessionId,origin,exp:now+60},secret), expiresIn:60 };
}
export async function claimVoiceCall(db: D1Database, slug: string, sessionId: string): Promise<boolean> {
  const now = Math.floor(Date.now()/1000);
  const result = await db.prepare(`UPDATE voice_admissions SET state = 'connected', expires_at = ?
    WHERE session_id = ? AND tenant_slug = ? AND state = 'reserved' AND expires_at > ?`)
    .bind(now+MAX_CALL_SECONDS,sessionId,slug,now).run();
  return result.meta.changes === 1;
}
export async function releaseVoiceCall(db: D1Database, slug: string, sessionId: string) {
  await db.prepare(`UPDATE voice_admissions SET state = 'closed', expires_at = MIN(expires_at, unixepoch())
    WHERE session_id = ? AND tenant_slug = ?`).bind(sessionId,slug).run();
}
