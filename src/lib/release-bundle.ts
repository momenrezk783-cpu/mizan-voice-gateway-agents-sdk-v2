// ============================================================================
// Signed Agent Release Bundle (Pull-Based Dev -> Production Promotion)
// ============================================================================
// Pure, small module shared between the Studio exporter and the production
// super-admin importer (`POST /api/admin/releases/import`).
// Guarantees:
//   - HMAC-SHA256 signature + SHA-256 content hash verification
//   - Dry-run diff support with zero database writes
//   - Strictly scoped to configuration tables (`tenants.industry`,
//     `tenant_voice_config`, `tenant_knowledge`, `agent_config_versions`,
//     `agent_active_version`). Never touches calls, contacts, or billing.
// ============================================================================

import { DEFAULT_MIZAN_VOICE_ID, invalidateTenantCache } from "./tenant";

export interface KnowledgeEntryInput {
  category: string;
  faq_text: string;
}

export interface AgentReleasePayload {
  schemaVersion: 1;
  tenantSlug: string;
  tenantName: string;
  industry: string;
  voiceId: string;
  tenantCustomization: string;
  knowledge: KnowledgeEntryInput[];
  sourceVersion: number;
  sourceEnvironment: string;
  sourceSha: string;
  bundleHash: string;
  exportedAt: number;
}

export interface SignedAgentReleaseBundle {
  payload: AgentReleasePayload;
  signature: string;
}

export interface ReleaseDiff {
  activeVersionBefore: number | null;
  industryBefore: string;
  industryAfter: string;
  voiceIdBefore: string;
  voiceIdAfter: string;
  customizationBefore: string;
  customizationAfter: string;
  knowledgeCountBefore: number;
  knowledgeCountAfter: number;
  changes: string[];
}

export interface ReleaseImportEnv {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  PROMOTION_SIGNING_KEY?: string;
  SESSION_SECRET: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const ALLOWED_INDUSTRIES = new Set([
  "general",
  "healthcare",
  "real_estate",
  "ecommerce",
  "legal",
  "customer_service",
  "education",
  "automotive",
  "finance",
  "hospitality",
  "retail"
]);

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function computeConfigBundleHash(input: {
  tenantSlug: string;
  industry: string;
  voiceId: string;
  tenantCustomization: string;
  knowledge: KnowledgeEntryInput[];
}): Promise<string> {
  const normalizedKnowledge = input.knowledge.map((k) => ({
    category: String(k.category || "general").trim(),
    faq_text: String(k.faq_text || "").trim()
  }));
  const canonical = JSON.stringify({
    tenantSlug: input.tenantSlug,
    industry: input.industry,
    voiceId: input.voiceId,
    tenantCustomization: input.tenantCustomization,
    knowledge: normalizedKnowledge
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return toHex(digest);
}

export function resolveSigningKeySecret(env: {
  PROMOTION_SIGNING_KEY?: string;
  SESSION_SECRET?: string;
}): string {
  const secret = (env.PROMOTION_SIGNING_KEY || env.SESSION_SECRET || "").trim();
  if (!secret || secret.length < 16) {
    throw new Error("PROMOTION_SIGNING_KEY (or SESSION_SECRET >= 16 chars) is required to sign/verify release bundles");
  }
  return secret;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toHex(sig);
}

export function canonicalizePayload(payload: AgentReleasePayload): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    tenantSlug: payload.tenantSlug,
    tenantName: payload.tenantName,
    industry: payload.industry,
    voiceId: payload.voiceId,
    tenantCustomization: payload.tenantCustomization,
    knowledge: payload.knowledge.map((k) => ({
      category: k.category,
      faq_text: k.faq_text
    })),
    sourceVersion: payload.sourceVersion,
    sourceEnvironment: payload.sourceEnvironment,
    sourceSha: payload.sourceSha,
    bundleHash: payload.bundleHash,
    exportedAt: payload.exportedAt
  });
}

export async function signReleaseBundle(
  payload: AgentReleasePayload,
  secret: string
): Promise<SignedAgentReleaseBundle> {
  const signature = await hmacSha256Hex(secret, canonicalizePayload(payload));
  return { payload, signature };
}

export function validateReleaseBundleShape(
  candidate: unknown
): { ok: true; bundle: SignedAgentReleaseBundle } | { ok: false; error: string } {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, error: "Release bundle must be a JSON object" };
  }
  const obj = candidate as Record<string, unknown>;
  if (typeof obj.signature !== "string" || !/^[a-f0-9]{64}$/iu.test(obj.signature)) {
    return { ok: false, error: "Invalid or missing HMAC-SHA256 bundle signature" };
  }
  const p = obj.payload as Record<string, unknown> | undefined;
  if (!p || typeof p !== "object") {
    return { ok: false, error: "Missing release bundle payload" };
  }
  if (p.schemaVersion !== 1) {
    return { ok: false, error: "Unsupported release bundle schemaVersion" };
  }
  if (typeof p.tenantSlug !== "string" || !SLUG_RE.test(p.tenantSlug)) {
    return { ok: false, error: "Invalid tenantSlug in release bundle" };
  }
  if (typeof p.tenantName !== "string" || p.tenantName.trim().length < 2 || p.tenantName.length > 120) {
    return { ok: false, error: "Invalid tenantName in release bundle" };
  }
  if (typeof p.industry !== "string" || !ALLOWED_INDUSTRIES.has(p.industry)) {
    return { ok: false, error: "Invalid industry in release bundle" };
  }
  if (typeof p.voiceId !== "string" || !VOICE_ID_RE.test(p.voiceId)) {
    return { ok: false, error: "Invalid voiceId in release bundle" };
  }
  if (typeof p.tenantCustomization !== "string" || p.tenantCustomization.length > 8000) {
    return { ok: false, error: "Invalid or oversized tenantCustomization in release bundle" };
  }
  if (!Array.isArray(p.knowledge) || p.knowledge.length > 50) {
    return { ok: false, error: "Invalid knowledge list in release bundle" };
  }
  const knowledge: KnowledgeEntryInput[] = [];
  for (const item of p.knowledge) {
    if (!item || typeof item !== "object") {
      return { ok: false, error: "Malformed knowledge item" };
    }
    const k = item as Record<string, unknown>;
    const category = typeof k.category === "string" ? k.category.trim() : "";
    const faq_text = typeof k.faq_text === "string" ? k.faq_text.trim() : "";
    if (!category || category.length > 64 || !faq_text || faq_text.length > 4000) {
      return { ok: false, error: "Knowledge entry category/faq_text out of bounds" };
    }
    knowledge.push({ category, faq_text });
  }
  if (typeof p.sourceVersion !== "number" || !Number.isInteger(p.sourceVersion) || p.sourceVersion < 1) {
    return { ok: false, error: "Invalid sourceVersion in release bundle" };
  }
  if (typeof p.bundleHash !== "string" || !/^[a-f0-9]{64}$/iu.test(p.bundleHash)) {
    return { ok: false, error: "Invalid bundleHash in release bundle" };
  }
  if (typeof p.exportedAt !== "number" || !Number.isFinite(p.exportedAt)) {
    return { ok: false, error: "Invalid exportedAt timestamp in release bundle" };
  }
  return {
    ok: true,
    bundle: {
      signature: obj.signature.toLowerCase(),
      payload: {
        schemaVersion: 1,
        tenantSlug: p.tenantSlug,
        tenantName: p.tenantName.trim(),
        industry: p.industry,
        voiceId: p.voiceId,
        tenantCustomization: p.tenantCustomization,
        knowledge,
        sourceVersion: p.sourceVersion,
        sourceEnvironment: typeof p.sourceEnvironment === "string" ? p.sourceEnvironment : "staging",
        sourceSha: typeof p.sourceSha === "string" ? p.sourceSha : "unknown",
        bundleHash: p.bundleHash.toLowerCase(),
        exportedAt: p.exportedAt
      }
    }
  };
}

export async function verifyAndImportReleaseBundle(
  env: ReleaseImportEnv,
  rawBundle: unknown,
  options: { dryRun?: boolean; actor?: string } = {}
): Promise<
  | {
      ok: true;
      dryRun: boolean;
      tenantSlug: string;
      activatedVersion: number | null;
      diff: ReleaseDiff;
    }
  | { ok: false; status: number; error: string }
> {
  const shape = validateReleaseBundleShape(rawBundle);
  if (!shape.ok) {
    return { ok: false, status: 400, error: shape.error };
  }
  const { bundle } = shape;
  const { payload } = bundle;

  let secret: string;
  try {
    secret = resolveSigningKeySecret(env);
  } catch (err) {
    return { ok: false, status: 500, error: err instanceof Error ? err.message : "Signing key unavailable" };
  }

  const expectedHash = await computeConfigBundleHash({
    tenantSlug: payload.tenantSlug,
    industry: payload.industry,
    voiceId: payload.voiceId,
    tenantCustomization: payload.tenantCustomization,
    knowledge: payload.knowledge
  });
  if (!constantTimeEqual(expectedHash, payload.bundleHash)) {
    return { ok: false, status: 400, error: "Release bundle content hash mismatch (payload tampered)" };
  }

  const expectedSig = await hmacSha256Hex(secret, canonicalizePayload(payload));
  if (!constantTimeEqual(expectedSig, bundle.signature)) {
    return { ok: false, status: 403, error: "Invalid release bundle HMAC signature" };
  }

  const existingTenant = await env.DB.prepare(
    "SELECT slug, name, industry, domain FROM tenants WHERE slug = ?"
  )
    .bind(payload.tenantSlug)
    .first<{ slug: string; name: string; industry: string; domain: string | null }>();

  if (!existingTenant) {
    return {
      ok: false,
      status: 404,
      error: `Tenant '${payload.tenantSlug}' does not exist in this environment. Onboard the tenant first.`
    };
  }

  const [currentVoice, currentKnowledge, activeVerRow] = await Promise.all([
    env.DB.prepare(
      "SELECT voice_id, tenant_customization FROM tenant_voice_config WHERE tenant_slug = ?"
    )
      .bind(payload.tenantSlug)
      .first<{ voice_id: string; tenant_customization: string | null }>(),
    env.DB.prepare(
      "SELECT category, faq_text FROM tenant_knowledge WHERE tenant_slug = ? ORDER BY category ASC"
    )
      .bind(payload.tenantSlug)
      .all<{ category: string; faq_text: string }>(),
    env.DB.prepare(
      "SELECT version_number FROM agent_active_version WHERE tenant_slug = ?"
    )
      .bind(payload.tenantSlug)
      .first<{ version_number: number }>()
  ]);

  const voiceBefore = currentVoice?.voice_id || DEFAULT_MIZAN_VOICE_ID;
  const customizationBefore = currentVoice?.tenant_customization || "";
  const knowledgeBefore = currentKnowledge.results ?? [];

  const changes: string[] = [];
  if (existingTenant.industry !== payload.industry) {
    changes.push(`industry: ${existingTenant.industry} -> ${payload.industry}`);
  }
  if (voiceBefore !== payload.voiceId) {
    changes.push(`voice_id: ${voiceBefore} -> ${payload.voiceId}`);
  }
  if (customizationBefore !== payload.tenantCustomization) {
    changes.push(`tenant_customization: ${customizationBefore.length} chars -> ${payload.tenantCustomization.length} chars`);
  }
  if (JSON.stringify(knowledgeBefore) !== JSON.stringify(payload.knowledge)) {
    changes.push(`knowledge: ${knowledgeBefore.length} entries -> ${payload.knowledge.length} entries`);
  }
  if (changes.length === 0) {
    changes.push("no effective configuration differences");
  }

  const diff: ReleaseDiff = {
    activeVersionBefore: activeVerRow?.version_number ?? null,
    industryBefore: existingTenant.industry,
    industryAfter: payload.industry,
    voiceIdBefore: voiceBefore,
    voiceIdAfter: payload.voiceId,
    customizationBefore,
    customizationAfter: payload.tenantCustomization,
    knowledgeCountBefore: knowledgeBefore.length,
    knowledgeCountAfter: payload.knowledge.length,
    changes
  };

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      tenantSlug: payload.tenantSlug,
      activatedVersion: activeVerRow?.version_number ?? null,
      diff
    };
  }

  const maxRow = await env.DB.prepare(
    "SELECT coalesce(MAX(version_number), 0) AS max_ver FROM agent_config_versions WHERE tenant_slug = ?"
  )
    .bind(payload.tenantSlug)
    .first<{ max_ver: number }>();
  const nextVersion = (maxRow?.max_ver ?? 0) + 1;
  const actor = options.actor || "super_admin";

  const statements: D1PreparedStatement[] = [
    env.DB.prepare("UPDATE tenants SET industry = ?, updated_at = unixepoch() WHERE slug = ?").bind(
      payload.industry,
      payload.tenantSlug
    ),
    env.DB.prepare(
      `INSERT INTO tenant_voice_config (tenant_slug, system_prompt, voice_id, tenant_customization, updated_at)
       VALUES (?, 'أنت ميزان، المساعد الصوتي المصري العام.', ?, ?, unixepoch())
       ON CONFLICT(tenant_slug) DO UPDATE SET
         voice_id = excluded.voice_id,
         tenant_customization = excluded.tenant_customization,
         updated_at = unixepoch()`
    ).bind(payload.tenantSlug, payload.voiceId, payload.tenantCustomization),
    env.DB.prepare("DELETE FROM tenant_knowledge WHERE tenant_slug = ?").bind(payload.tenantSlug),
    ...payload.knowledge.map((k, idx) =>
      env.DB.prepare(
        "INSERT INTO tenant_knowledge (id, tenant_slug, category, faq_text, updated_at) VALUES (?, ?, ?, ?, unixepoch())"
      ).bind(`k_${payload.tenantSlug}_v${nextVersion}_${idx}`, payload.tenantSlug, k.category, k.faq_text)
    ),
    env.DB.prepare(
      `INSERT INTO agent_config_versions (tenant_slug, version_number, industry, voice_id, tenant_customization, knowledge_json, source, bundle_hash, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'promoted_import', ?, ?)`
    ).bind(
      payload.tenantSlug,
      nextVersion,
      payload.industry,
      payload.voiceId,
      payload.tenantCustomization,
      JSON.stringify(payload.knowledge),
      payload.bundleHash,
      actor
    ),
    env.DB.prepare(
      `INSERT INTO agent_active_version (tenant_slug, version_number, activated_at, activated_by)
       VALUES (?, ?, unixepoch(), ?)
       ON CONFLICT(tenant_slug) DO UPDATE SET
         version_number = excluded.version_number,
         activated_at = unixepoch(),
         activated_by = excluded.activated_by`
    ).bind(payload.tenantSlug, nextVersion, actor)
  ];

  await env.DB.batch(statements);
  await invalidateTenantCache(payload.tenantSlug, existingTenant.domain ?? null, env);

  return {
    ok: true,
    dryRun: false,
    tenantSlug: payload.tenantSlug,
    activatedVersion: nextVersion,
    diff
  };
}
