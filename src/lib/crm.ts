/** Tenant-scoped follow-up workflow for call-created client_queries (no new raw PII). */
export const REQUEST_STATUSES = ['open', 'in_progress', 'closed', 'cancelled'] as const;
export type RequestStatus = typeof REQUEST_STATUSES[number];

export function isRequestStatus(value: unknown): value is RequestStatus {
  return typeof value === 'string' && REQUEST_STATUSES.some(status => status === value);
}

export async function listTenantRequests(db: D1Database, tenantSlug: string, status?: RequestStatus) {
  if (status) {
    const rows = await db.prepare(
      `SELECT id, subject, message, status, created_at, updated_at
       FROM client_queries WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 100`
    ).bind(tenantSlug,status).all();
    return rows.results;
  }
  const rows = await db.prepare(
    `SELECT id, subject, message, status, created_at, updated_at
     FROM client_queries WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 100`
  ).bind(tenantSlug).all();
  return rows.results;
}

export async function updateTenantRequestStatus(db: D1Database, tenantSlug: string, id: string, status: RequestStatus): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(id) || !isRequestStatus(status)) return false;
  const result = await db.prepare(
    `UPDATE client_queries SET status = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`
  ).bind(status, new Date().toISOString(), id, tenantSlug).run();
  return (result.meta?.changes ?? 0) > 0;
}
