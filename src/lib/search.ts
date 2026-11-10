// Small, tenant-scoped textual search. This deliberately does not claim semantic or document indexing.
export interface SearchHit {
  id: string;
  kind: "knowledge" | "call" | "tenant";
  title: string;
  detail: string;
  timestamp: number | null;
}

export function parseSearchInput(url: URL, scopes: readonly string[]) {
  const q = (url.searchParams.get("q") || "").trim().replace(/\s+/gu, " ");
  const scope = url.searchParams.get("scope") || "all";
  if (q.length < 2 || q.length > 120) return { error: "Search requires 2–120 characters", status: 400 } as const;
  if (!scopes.includes(scope)) return { error: "Unsupported search scope", status: 422 } as const;
  return { q, scope } as const;
}

export async function searchClientData(db: D1Database, slug: string, q: string, scope: string): Promise<SearchHit[]> {
  const hits: SearchHit[] = [];
  if (scope === "all" || scope === "knowledge") {
    const rows = await db.prepare(`SELECT id, category, faq_text, updated_at FROM tenant_knowledge
      WHERE tenant_slug = ? AND (instr(lower(category), lower(?)) > 0 OR instr(lower(faq_text), lower(?)) > 0)
      ORDER BY updated_at DESC LIMIT 20`).bind(slug, q, q).all<{ id: string; category: string; faq_text: string; updated_at: number }>();
    for (const r of rows.results) hits.push({ id: r.id, kind: "knowledge", title: r.category, detail: r.faq_text.slice(0, 320), timestamp: r.updated_at });
  }
  if (scope === "all" || scope === "calls") {
    const rows = await db.prepare(`SELECT id, selected_doctor, selected_slot, started_at FROM call_sessions cs
      WHERE tenant_slug = ? AND (
        instr(lower(id), lower(?)) > 0 OR
        instr(lower(coalesce(selected_doctor, '')), lower(?)) > 0 OR
        instr(lower(coalesce(selected_slot, '')), lower(?)) > 0 OR
        EXISTS (SELECT 1 FROM call_turns ct WHERE ct.session_id = cs.id AND ct.tenant_slug = cs.tenant_slug
          AND instr(lower(coalesce(ct.transcript_redacted, '')), lower(?)) > 0)
      ) ORDER BY started_at DESC LIMIT 20`).bind(slug, q, q, q, q).all<{
        id: string; selected_doctor: string | null; selected_slot: string | null; started_at: number;
      }>();
    for (const r of rows.results) hits.push({ id: r.id, kind: "call", title: r.selected_doctor || "مكالمة مسجلة", detail: r.selected_slot || "عرض تفاصيل المكالمة من سجل المكالمات", timestamp: r.started_at });
  }
  return hits.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}

export async function searchAdminData(db: D1Database, q: string): Promise<SearchHit[]> {
  const tenants = await db.prepare(`SELECT slug, name, industry, created_at FROM tenants
    WHERE instr(lower(name), lower(?)) > 0 OR instr(lower(slug), lower(?)) > 0
    OR instr(lower(coalesce(industry, '')), lower(?)) > 0 ORDER BY created_at DESC LIMIT 20`)
    .bind(q, q, q).all<{ slug: string; name: string; industry: string; created_at: number }>();
  const calls = await db.prepare(`SELECT cs.id, cs.selected_doctor, cs.started_at, t.name AS tenant_name
    FROM call_sessions cs JOIN tenants t ON t.slug = cs.tenant_slug WHERE
      instr(lower(coalesce(cs.selected_doctor, '')), lower(?)) > 0 OR instr(lower(cs.id), lower(?)) > 0
      OR instr(lower(t.name), lower(?)) > 0 ORDER BY cs.started_at DESC LIMIT 20`)
    .bind(q, q, q).all<{ id: string; selected_doctor: string | null; started_at: number; tenant_name: string }>();
  const hits: SearchHit[] = [
    ...tenants.results.map(r => ({ id: r.slug, kind: "tenant" as const, title: r.name, detail: r.industry, timestamp: r.created_at })),
    ...calls.results.map(r => ({ id: r.id, kind: "call" as const, title: r.tenant_name, detail: r.selected_doctor || "مكالمة مسجلة", timestamp: r.started_at }))
  ];
  return hits.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
}
