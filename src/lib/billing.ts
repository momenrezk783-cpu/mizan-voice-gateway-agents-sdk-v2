/** Read-only monthly consumption snapshot. NOT an invoice or payment integration. */
export function getUtcMonthBounds(input: string): { start: number; end: number; month: string } | null {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(input)) return null;
  const [year, month] = input.split('-').map(Number);
  const start = Date.UTC(year, month - 1, 1) / 1000;
  const end = Date.UTC(year, month, 1) / 1000;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  return {start,end,month:input};
}

export async function getTenantMonthlyUsage(db: D1Database, tenantSlug: string, month: string) {
  const bounds = getUtcMonthBounds(month);
  if (!bounds) throw new Error('Invalid calendar month');
  const row = await db.prepare(
    `SELECT COUNT(*) AS call_count,
            COALESCE(SUM(CASE WHEN ended_at IS NOT NULL AND ended_at >= started_at
             THEN ended_at - started_at ELSE 0 END), 0) AS completed_duration_seconds
     FROM call_sessions
     WHERE tenant_slug = ? AND started_at >= ? AND started_at < ?`
  ).bind(tenantSlug,bounds.start,bounds.end).first<{call_count:number;completed_duration_seconds:number}>();
  return {
    month:bounds.month,
    callCount: Math.max(0, Number(row?.call_count ?? 0)),
    recordedDurationSeconds: Math.max(0, Number(row?.completed_duration_seconds ?? 0)),
    meteringBasis:'session timestamps; incomplete calls contribute zero until ended',
    invoiceStatus:'not_enabled' as const,
    amountDue:null,
    // Not billable minutes: no price or rounding policy has been approved.
  };
}
