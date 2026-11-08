// ============================================================================
// Mizan Voice Gateway — Tenant Resolution (KV cache + D1 fallback)
// ============================================================================
// Resolves tenant by slug (path) or hostname (custom domain).
// KV is the hot cache (30s TTL); D1 is the source of truth.
// On cache miss, reads D1 and backfills KV.

export interface TenantConfig {
  id: string;
  slug: string;
  name: string;
  domain: string | null;
  status: "active" | "suspended" | "trial";
  plan_tier: string;
  max_concurrent_sessions: number;
  theme_color: string;
  logo_url: string | null;
}

export interface TenantVoiceConfig {
  tenant_slug: string;
  system_prompt: string;
  voice_id: string;
  allow_medical_advice: number; // 0 or 1
  escalation_phone: string | null;
  ttl_seconds: number;
}

const KV_TTL = 30; // seconds — matches prompt cache TTL

/**
 * Resolve a tenant by slug. Checks KV first, falls back to D1.
 * Returns null if tenant doesn't exist or is suspended.
 */
export async function resolveTenant(
  slug: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantConfig | null> {
  const cacheKey = `tenant:${slug}`;

  // 1. Try KV cache
  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) {
    const tenant = cached as TenantConfig;
    if (tenant.status === "suspended") return null;
    return tenant;
  }

  // 2. Fallback to D1
  const row = await env.DB.prepare(
    `SELECT id, slug, name, domain, status, plan_tier, max_concurrent_sessions, theme_color, logo_url
     FROM tenants WHERE slug = ? AND status != 'suspended'`
  )
    .bind(slug)
    .first<TenantConfig>();

  if (!row) return null;

  // 3. Backfill KV cache
  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(row), {
    expirationTtl: KV_TTL,
  });

  return row;
}

/**
 * Resolve a tenant by custom domain hostname.
 */
export async function resolveTenantByDomain(
  hostname: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantConfig | null> {
  const cacheKey = `domain:${hostname}`;

  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) return cached as TenantConfig;

  const row = await env.DB.prepare(
    `SELECT id, slug, name, domain, status, plan_tier, max_concurrent_sessions, theme_color, logo_url
     FROM tenants WHERE domain = ? AND status != 'suspended'`
  )
    .bind(hostname)
    .first<TenantConfig>();

  if (!row) return null;

  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(row), {
    expirationTtl: KV_TTL,
  });

  return row;
}

/**
 * Get the full voice config for a tenant (prompt, voice ID, policy).
 * Cached in KV under a separate key.
 */
export async function getTenantVoiceConfig(
  slug: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantVoiceConfig | null> {
  const cacheKey = `voice_config:${slug}`;

  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) return cached as TenantVoiceConfig;

  const row = await env.DB.prepare(
    `SELECT tenant_slug, system_prompt, voice_id, allow_medical_advice,
            escalation_phone, ttl_seconds
     FROM tenant_voice_config WHERE tenant_slug = ?`
  )
    .bind(slug)
    .first<TenantVoiceConfig>();

  if (!row) return null;

  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(row), {
    expirationTtl: KV_TTL,
  });

  return row;
}

/**
 * Get all FAQ/knowledge entries for a tenant, grouped by category.
 * Injected into the LLM system prompt as live context.
 */
export async function getTenantKnowledge(
  slug: string,
  env: { DB: D1Database }
): Promise<Record<string, string>> {
  const rows = await env.DB.prepare(
    `SELECT category, faq_text FROM tenant_knowledge WHERE tenant_slug = ?`
  )
    .bind(slug)
    .all<{ category: string; faq_text: string }>();

  const knowledge: Record<string, string> = {};
  for (const row of rows.results) {
    knowledge[row.category] = row.faq_text;
  }
  return knowledge;
}

/**
 * Invalidate KV cache for a tenant (call after admin updates config).
 */
export async function invalidateTenantCache(
  slug: string,
  domain: string | null,
  env: { TENANT_CONFIG: KVNamespace }
): Promise<void> {
  await Promise.all([
    env.TENANT_CONFIG.delete(`tenant:${slug}`),
    env.TENANT_CONFIG.delete(`voice_config:${slug}`),
    domain ? env.TENANT_CONFIG.delete(`domain:${domain}`) : Promise.resolve(),
  ]);
}
