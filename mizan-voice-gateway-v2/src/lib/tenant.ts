// ============================================================================
// Mizan Voice Gateway — Tenant + Global Config Resolution
// ============================================================================
// Three layers of configuration:
//   1. Global Voice Config  — Mizan's Egyptian identity (super_admin only, LOCKED)
//   2. Industry Guards      — Safety rules per industry (super_admin only, LOCKED)
//   3. Tenant Customization — Per-tenant ADDITIVE context (tenant can edit)
//   4. Tenant Knowledge     — FAQ/schedules/prices (tenant can edit)
// ============================================================================

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
  industry: string;
}

export interface GlobalVoiceConfig {
  system_prompt: string;
  voice_id: string;
}

export interface TenantVoiceConfig {
  tenant_slug: string;
  tenant_customization: string;  // ADDITIVE — tenant can edit this
  escalation_phone: string | null;
  ttl_seconds: number;
}

const KV_TTL = 60; // seconds — Cloudflare KV minimum expirationTtl is 60s
const DEFAULT_INDUSTRY = "healthcare"; // Fail-safe default; matches migration-001 for existing tenants

// ---------------------------------------------------------------------------
// 1. Global Voice Config (Mizan Identity — LOCKED, super_admin only)
// ---------------------------------------------------------------------------

export async function getGlobalVoiceConfig(
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<GlobalVoiceConfig> {
  const cacheKey = "global:voice_config";
  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) return cached as GlobalVoiceConfig;

  const row = await env.DB.prepare(
    `SELECT system_prompt, voice_id FROM global_voice_config WHERE id = 1`
  ).first<GlobalVoiceConfig>();

  if (!row) {
    return {
      system_prompt: "أنت ميزان، المساعد الصوتي المصري العام.",
      voice_id: "6CdZI3ijDBOuX5Giq3NQ",
    };
  }

  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(row), { expirationTtl: 300 });
  return row;
}

// ---------------------------------------------------------------------------
// 2. Industry Guard (Safety rule — LOCKED, super_admin only)
// ---------------------------------------------------------------------------

export interface HQElevenLabsConfig {
  voice_id: string;
  model_id: string;
  stability: number;
  similarity_boost: number;
  speed: number;
}

/**
 * Reads the voice selected in the central HQ admin console.
 * Deliberately does not read the public-page localStorage voice or tenant defaults.
 */
export async function getHQElevenLabsConfig(
  env: { DB: D1Database }
): Promise<HQElevenLabsConfig | null> {
  try {
    const row = await env.DB.prepare(
      "SELECT html FROM _portal_assets WHERE key = 'elevenlabs_config' LIMIT 1"
    ).first<{ html: string }>();
    if (!row?.html) return null;

    const saved = JSON.parse(row.html) as Record<string, unknown>;
    const voiceId = typeof saved.voice_id === "string" ? saved.voice_id.trim() : "";
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(voiceId)) return null;

    const numeric = (value: unknown, fallback: number, min: number, max: number) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
    };

    return {
      voice_id: voiceId,
      model_id: "eleven_v4_turbo",
      stability: numeric(saved.stability, 0.4, 0, 1),
      similarity_boost: numeric(saved.similarity_boost, 0.9, 0, 1),
      speed: numeric(saved.speed, 0.9, 0.7, 1.2)
    };
  } catch (error) {
    console.error("HQ ElevenLabs configuration could not be loaded:", error);
    return null;
  }
}

export async function getIndustryGuard(
  industry: string | null | undefined,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<string> {
  // Older cached tenant records may not include industry. Never pass undefined to D1.
  const resolvedIndustry =
    typeof industry === "string" && industry.trim() ? industry.trim() : DEFAULT_INDUSTRY;
  const cacheKey = `industry_guard:${resolvedIndustry}`;
  const cached = await env.TENANT_CONFIG.get(cacheKey);
  if (cached !== null) return cached;

  const row = await env.DB.prepare(
    `SELECT guard_text FROM industry_guards WHERE industry = ? AND enabled = 1`
  )
    .bind(resolvedIndustry)
    .first<{ guard_text: string }>();

  const guardText = row?.guard_text ?? "";
  await env.TENANT_CONFIG.put(cacheKey, guardText, { expirationTtl: 300 });
  return guardText;
}

// ---------------------------------------------------------------------------
// 3. Tenant Resolution (by slug or custom domain)
// ---------------------------------------------------------------------------

export async function resolveTenant(
  slug: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantConfig | null> {
  const cacheKey = `tenant:${slug}`;
  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) {
    const tenant = cached as TenantConfig;
    if (tenant.status === "suspended") return null;
    // Normalize records cached before the industry field was introduced.
    return {
      ...tenant,
      industry:
        typeof tenant.industry === "string" && tenant.industry.trim()
          ? tenant.industry.trim()
          : DEFAULT_INDUSTRY,
    };
  }

  const row = await env.DB.prepare(
    `SELECT id, slug, name, domain, status, plan_tier, max_concurrent_sessions,
            theme_color, logo_url, industry
     FROM tenants WHERE slug = ? AND status != 'suspended'`
  )
    .bind(slug)
    .first<TenantConfig>();

  if (!row) return null;
  const tenant = {
    ...row,
    industry:
      typeof row.industry === "string" && row.industry.trim()
        ? row.industry.trim()
        : DEFAULT_INDUSTRY,
  };
  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(tenant), { expirationTtl: KV_TTL });
  return tenant;
}

export async function resolveTenantByDomain(
  hostname: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantConfig | null> {
  const cacheKey = `domain:${hostname}`;
  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) {
    const tenant = cached as TenantConfig;
    return {
      ...tenant,
      industry:
        typeof tenant.industry === "string" && tenant.industry.trim()
          ? tenant.industry.trim()
          : DEFAULT_INDUSTRY,
    };
  }

  const row = await env.DB.prepare(
    `SELECT id, slug, name, domain, status, plan_tier, max_concurrent_sessions,
            theme_color, logo_url, industry
     FROM tenants WHERE domain = ? AND status != 'suspended'`
  )
    .bind(hostname)
    .first<TenantConfig>();

  if (!row) return null;
  const tenant = {
    ...row,
    industry:
      typeof row.industry === "string" && row.industry.trim()
        ? row.industry.trim()
        : DEFAULT_INDUSTRY,
  };
  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(tenant), { expirationTtl: KV_TTL });
  return tenant;
}

// ---------------------------------------------------------------------------
// 4. Tenant Voice Config (customization + escalation — tenant can edit)
// ---------------------------------------------------------------------------

export async function getTenantVoiceConfig(
  slug: string,
  env: { DB: D1Database; TENANT_CONFIG: KVNamespace }
): Promise<TenantVoiceConfig | null> {
  const cacheKey = `voice_config:${slug}`;
  const cached = await env.TENANT_CONFIG.get(cacheKey, "json");
  if (cached) return cached as TenantVoiceConfig;

  const row = await env.DB.prepare(
    `SELECT tenant_slug, tenant_customization, escalation_phone, ttl_seconds
     FROM tenant_voice_config WHERE tenant_slug = ?`
  )
    .bind(slug)
    .first<TenantVoiceConfig>();

  if (!row) return null;
  await env.TENANT_CONFIG.put(cacheKey, JSON.stringify(row), { expirationTtl: KV_TTL });
  return row;
}

// ---------------------------------------------------------------------------
// 5. Tenant Knowledge (FAQ — tenant can edit)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Cache Invalidation
// ---------------------------------------------------------------------------

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

export async function invalidateGlobalCache(
  env: { TENANT_CONFIG: KVNamespace }
): Promise<void> {
  await env.TENANT_CONFIG.delete("global:voice_config");
}
