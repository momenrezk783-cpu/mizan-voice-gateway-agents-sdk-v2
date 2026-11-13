import type { BackgroundMessage } from '../agent';
import { redactPII } from './crypto';
import {settleCallUsage} from './billing';

export async function processBackgroundMessage(msg: BackgroundMessage, env: {DB:D1Database}): Promise<void> {
  const eventId = msg.eventId ?? `${msg.type}:${msg.tenantSlug}:${msg.sessionId}:${msg.type === 'record_turn' ? `${msg.turnIndex ?? 0}:${msg.speaker ?? 'caller'}` : ''}`;
  const now = Math.floor(Date.now()/1000);
  const occurredAt = Number.isSafeInteger(msg.occurredAt) && msg.occurredAt! > 0 ? Math.min(now,msg.occurredAt!) : now;
  let mutation: D1PreparedStatement;
  switch (msg.type) {
    case 'record_turn':
      mutation = env.DB.prepare(`INSERT INTO call_turns
        (id,session_id,tenant_slug,turn_index,speaker,transcript_redacted,latency_ms,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM background_events WHERE event_id = ?)`)
        .bind(eventId,msg.sessionId,msg.tenantSlug,msg.turnIndex ?? 0,msg.speaker ?? 'caller',redactPII(msg.transcript ?? ''),msg.latencyMs ?? null,occurredAt,eventId);
      break;
    case 'record_usage':
      mutation = env.DB.prepare(`INSERT INTO tenant_usage (tenant_slug,metric,value,recorded_at)
        SELECT ?, 'call_count', 1, ? WHERE NOT EXISTS (SELECT 1 FROM background_events WHERE event_id = ?)`)
        .bind(msg.tenantSlug,occurredAt,eventId);
      break;
    case 'end_session':
      mutation = env.DB.prepare(`UPDATE call_sessions SET call_status = 'completed', ended_at = ?
        WHERE id = ? AND tenant_slug = ? AND ended_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM background_events WHERE event_id = ?)`)
        .bind(occurredAt,msg.sessionId,msg.tenantSlug,eventId);
      break;
    default: throw new Error('Unknown background event');
  }
  // D1 batch is transactional. A crash cannot leave the write without its dedupe marker.
  await env.DB.batch([mutation,env.DB.prepare(`INSERT OR IGNORE INTO background_events (event_id) VALUES (?)`).bind(eventId)]);
  if(msg.type==='end_session')await settleCallUsage(env.DB,msg.tenantSlug,msg.sessionId,occurredAt);
}
