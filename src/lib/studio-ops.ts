// ============================================================================
// Mizan Voice Studio Operations Backend (`/api/ops/*`)
// ============================================================================
// Bundled ONLY by `src/studio-entry.ts` (`wrangler.studio-dev.toml`).
// Never included in the production `src/index.ts` bundle.
// ============================================================================

import { getSessionUser } from "./auth";
import { redactPII } from "./crypto";
import {
  DEFAULT_MIZAN_VOICE_ID,
  getGlobalVoiceConfig,
  getIndustryGuard,
  getTenantKnowledge,
  getTenantVoiceConfig,
  invalidateTenantCache,
  resolveTenant
} from "./tenant";
import {
  detectNonEgyptian,
  extractCallerTitleAndName,
  guardUnconfirmedBookingClaim,
  sanitizeForSpeechWithViolations
} from "./conversation-manager/guard";
import {
  DEFAULT_INTENTS,
  newSession,
  type CallContext,
  type ToolDeps
} from "./conversation-manager/manager";
import { buildClock } from "./conversation-manager/prompt";
import { runTextTurn } from "./turn-engine";
import {
  computeConfigBundleHash,
  resolveSigningKeySecret,
  signReleaseBundle,
  type AgentReleasePayload,
  type KnowledgeEntryInput
} from "./release-bundle";
import type { Env } from "../agent";

export interface StudioEnv extends Env {
  RUNTIME_VERSION?: string;
  STUDIO_API_TOKEN?: string;
  PROMOTION_SIGNING_KEY?: string;
  OPENCODE_HARNESS_URL?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/u;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;
const SIMULATE_LIMIT_PER_MINUTE = 30;

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    }
  });
}

export async function authenticateStudioRequest(
  request: Request,
  env: StudioEnv,
  url: URL
): Promise<{ ok: true; actor: string; mode: "cookie" | "token" } | { ok: false; status: number; error: string }> {
  if (env.ENVIRONMENT === "production") {
    return { ok: false, status: 404, error: "Studio operations are disabled on the production gateway" };
  }

  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Bearer ")) {
    const provided = authHeader.slice("Bearer ".length).trim();
    const expected = (env.STUDIO_API_TOKEN || "").trim();
    if (!expected || expected.length < 16) {
      return { ok: false, status: 403, error: "STUDIO_API_TOKEN is not configured on this Worker" };
    }
    if (!constantTimeEqual(provided, expected)) {
      return { ok: false, status: 401, error: "Invalid Studio Bearer token" };
    }
    return { ok: true, actor: "opencode_harness", mode: "token" };
  }

  const user = await getSessionUser(request, env);
  if (!user) {
    return { ok: false, status: 401, error: "Authentication required (super_admin session or Bearer STUDIO_API_TOKEN)" };
  }
  if (user.role !== "super_admin") {
    return { ok: false, status: 403, error: "Forbidden: super_admin role required" };
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("Origin");
    if (origin !== url.origin) {
      return { ok: false, status: 403, error: "Invalid request origin (CSRF protection)" };
    }
  }

  return { ok: true, actor: user.email || user.id, mode: "cookie" };
}

async function ensureBaselineVersions(env: StudioEnv): Promise<void> {
  const tenants = await env.DB.prepare(
    "SELECT slug, industry FROM tenants ORDER BY created_at ASC"
  ).all<{ slug: string; industry: string }>();

  for (const t of tenants.results ?? []) {
    const active = await env.DB.prepare(
      "SELECT version_number FROM agent_active_version WHERE tenant_slug = ?"
    )
      .bind(t.slug)
      .first<{ version_number: number }>();
    if (active) continue;

    const voice = await env.DB.prepare(
      "SELECT voice_id, tenant_customization FROM tenant_voice_config WHERE tenant_slug = ?"
    )
      .bind(t.slug)
      .first<{ voice_id: string; tenant_customization: string | null }>();
    const kRows = await env.DB.prepare(
      "SELECT category, faq_text FROM tenant_knowledge WHERE tenant_slug = ? ORDER BY category ASC"
    )
      .bind(t.slug)
      .all<{ category: string; faq_text: string }>();

    const voiceId = voice?.voice_id || DEFAULT_MIZAN_VOICE_ID;
    const customization = voice?.tenant_customization || "";
    const knowledge: KnowledgeEntryInput[] = (kRows.results ?? []).map((r) => ({
      category: r.category,
      faq_text: r.faq_text
    }));
    const hash = await computeConfigBundleHash({
      tenantSlug: t.slug,
      industry: t.industry || "general",
      voiceId,
      tenantCustomization: customization,
      knowledge
    });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_config_versions
         (tenant_slug, version_number, industry, voice_id, tenant_customization, knowledge_json, source, bundle_hash, created_by)
         VALUES (?, 1, ?, ?, ?, ?, 'baseline', ?, 'system')`
      ).bind(t.slug, t.industry || "general", voiceId, customization, JSON.stringify(knowledge), hash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO agent_active_version (tenant_slug, version_number, activated_by)
         VALUES (?, 1, 'system')`
      ).bind(t.slug)
    ]);
  }
}

async function checkStudioRateLimit(db: D1Database, actor: string, nowSec = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const key = `sim:${actor}`;
  const windowReset = nowSec + 60;
  const current = await db
    .prepare("SELECT hits, reset_at FROM studio_rate_limits WHERE rate_key = ?")
    .bind(key)
    .first<{ hits: number; reset_at: number }>();

  if (!current || current.reset_at <= nowSec) {
    await db
      .prepare(
        `INSERT INTO studio_rate_limits (rate_key, hits, reset_at) VALUES (?, 1, ?)
         ON CONFLICT(rate_key) DO UPDATE SET hits = 1, reset_at = excluded.reset_at`
      )
      .bind(key, windowReset)
      .run();
    return true;
  }

  if (current.hits >= SIMULATE_LIMIT_PER_MINUTE) {
    return false;
  }

  await db
    .prepare("UPDATE studio_rate_limits SET hits = hits + 1 WHERE rate_key = ?")
    .bind(key)
    .run();
  return true;
}

export async function runDeterministicGates(env: StudioEnv): Promise<{
  ok: boolean;
  gates: Array<{ id: string; title: string; status: "PASSED" | "FAILED" | "WARN"; detail: string }>;
}> {
  const gates: Array<{ id: string; title: string; status: "PASSED" | "FAILED" | "WARN"; detail: string }> = [];

  // Gate 1: Egyptian PII Scrubber (Phone, National ID, Email)
  const samplePii = "رقمي 01099887766 والرقم القومي 29901011234567 وإيميلي test@example.com";
  const redacted = redactPII(samplePii)
    .replace(/\b\d{14}\b/gu, "[رقم قومي]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]");
  const piiPassed =
    !redacted.includes("01099887766") &&
    !redacted.includes("29901011234567") &&
    !redacted.includes("test@example.com");
  gates.push({
    id: "pii_scrubber",
    title: "1. Egyptian PII Scrubber (Phone, National ID & Email Redaction)",
    status: piiPassed ? "PASSED" : "FAILED",
    detail: piiPassed ? `Scrubbed -> ${redacted}` : "Failed to redact sample Egyptian PII"
  });

  // Gate 2: Deterministic Arabic Output Guard (Honorifics, MSA & Unconfirmed Booking Claims)
  const honorificCheck = sanitizeForSpeechWithViolations("أهلاً يا فندم، مع حضرتك ميزان.", {
    role: "caller",
    callerGender: "male"
  });
  const msaCheck = detectNonEgyptian("سوف أقوم بمساعدتك، لماذا تتصل الآن؟");
  const bookingCheck = guardUnconfirmedBookingClaim("تم تأكيد حجزك غداً الساعة الخامسة.", false);
  const guardPassed =
    !honorificCheck.text.includes("فندم") &&
    !honorificCheck.text.includes("حضرتك") &&
    honorificCheck.violations.length >= 2 &&
    msaCheck.length >= 2 &&
    !bookingCheck.includes("تم تأكيد حجزك");
  gates.push({
    id: "arabic_output_guard",
    title: "2. Arabic Output Guard (Honorific Strip, MSA Detector & Booking Claim Blocker)",
    status: guardPassed ? "PASSED" : "FAILED",
    detail: guardPassed
      ? `Violations caught: ${honorificCheck.violations.length} honorific, ${msaCheck.length} MSA; unconfirmed booking blocked`
      : "Output guard failed one or more assertions"
  });

  // Gate 3: Tenant-Scoped D1 & Environment Isolation
  let d1Passed = false;
  let d1Detail = "";
  try {
    const countRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM tenants").first<{ cnt: number }>();
    const verRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM agent_config_versions").first<{ cnt: number }>();
    d1Passed = env.ENVIRONMENT !== "production" && typeof countRow?.cnt === "number" && typeof verRow?.cnt === "number";
    d1Detail = `env=${env.ENVIRONMENT}, tenants=${countRow?.cnt ?? 0}, versions=${verRow?.cnt ?? 0}`;
  } catch (err) {
    d1Detail = err instanceof Error ? err.message : "D1 query failed";
  }
  gates.push({
    id: "tenant_d1_isolation",
    title: "3. Tenant-Scoped D1 & Non-Production Isolation",
    status: d1Passed ? "PASSED" : "FAILED",
    detail: d1Detail
  });

  // Gate 4: Runtime Secrets & Voice Pipeline Readiness
  const hasSession = Boolean(env.SESSION_SECRET && env.SESSION_SECRET.length >= 16);
  const hasContactKey = Boolean(env.CONTACT_ENC_KEY);
  const hasDeepgram = Boolean(env.DEEPGRAM_API_KEY);
  const hasElevenLabs = Boolean(env.ELEVENLABS_TTS_KEY || env.ELEVENLABS_API_KEY);
  const hasPromoKey = Boolean(env.PROMOTION_SIGNING_KEY || hasSession);
  const coreReady = hasSession && hasContactKey && hasPromoKey;
  const voiceProvidersReady = hasDeepgram && hasElevenLabs;
  gates.push({
    id: "runtime_readiness",
    title: "4. Voice & Promotion Secret Readiness (Boolean Check Only)",
    status: coreReady ? (voiceProvidersReady ? "PASSED" : "WARN") : "FAILED",
    detail: `session=${hasSession}, contactEnc=${hasContactKey}, promotionSign=${hasPromoKey}, deepgram=${hasDeepgram}, elevenlabs=${hasElevenLabs}`
  });

  return {
    ok: gates.every((g) => g.status !== "FAILED"),
    gates
  };
}

export async function handleStudioOpsApi(
  request: Request,
  env: StudioEnv,
  url: URL
): Promise<Response> {
  const auth = await authenticateStudioRequest(request, env, url);
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, auth.status);
  }

  const path = url.pathname;
  const runtimeVersion = env.RUNTIME_VERSION || "v2.2.0-studio-dev";

  try {
    // GET /api/ops/status
    if (path === "/api/ops/status" && request.method === "GET") {
      await ensureBaselineVersions(env);

      const [globalConfig, guardsRes, tenantsRes, tracesRes, gatesResult] = await Promise.all([
        getGlobalVoiceConfig(env),
        env.DB.prepare("SELECT industry, guard_text FROM industry_guards WHERE enabled = 1").all<{
          industry: string;
          guard_text: string;
        }>(),
        env.DB.prepare(
          `SELECT t.slug AS tenant_id, t.name, t.industry,
                  coalesce(v.voice_id, ?) AS voice_id,
                  coalesce(v.tenant_customization, '') AS tenant_customization,
                  coalesce(av.version_number, 1) AS active_version
           FROM tenants t
           LEFT JOIN tenant_voice_config v ON v.tenant_slug = t.slug
           LEFT JOIN agent_active_version av ON av.tenant_slug = t.slug
           ORDER BY t.created_at DESC`
        )
          .bind(DEFAULT_MIZAN_VOICE_ID)
          .all<{
            tenant_id: string;
            name: string;
            industry: string;
            voice_id: string;
            tenant_customization: string;
            active_version: number;
          }>(),
        env.DB.prepare(
          `SELECT trace_id AS call_id, session_id, tenant_slug AS tenant_id, turn_index,
                  environment, runtime_version, config_version, llm_ttft_ms, tts_ttfb_ms,
                  guard_violations_json, barge_ins, created_at
           FROM turn_traces
           ORDER BY created_at DESC, rowid DESC LIMIT 50`
        ).all(),
        runDeterministicGates(env)
      ]);

      const agents = [];
      for (const a of tenantsRes.results ?? []) {
        const [kRows, verRows] = await Promise.all([
          env.DB.prepare(
            "SELECT category, faq_text FROM tenant_knowledge WHERE tenant_slug = ? ORDER BY category ASC"
          )
            .bind(a.tenant_id)
            .all<{ category: string; faq_text: string }>(),
          env.DB.prepare(
            "SELECT version_number, source, created_at FROM agent_config_versions WHERE tenant_slug = ? ORDER BY version_number DESC"
          )
            .bind(a.tenant_id)
            .all<{ version_number: number; source: string; created_at: number }>()
        ]);
        const knowledgeText = (kRows.results ?? []).map((r) => r.faq_text).join("\n");
        agents.push({
          ...a,
          knowledge_text: knowledgeText,
          versions: (verRows.results ?? []).map((v) => v.version_number)
        });
      }

      const industryGuards: Record<string, string> = {};
      for (const g of guardsRes.results ?? []) {
        industryGuards[g.industry] = g.guard_text;
      }

      return jsonResponse({
        ok: true,
        environment: env.ENVIRONMENT || "staging",
        runtimeVersion,
        harnessUrl: env.OPENCODE_HARNESS_URL || "",
        lockedLayers: {
          globalSystemPrompt: globalConfig.system_prompt,
          defaultVoiceId: globalConfig.voice_id,
          industryGuards
        },
        agents,
        traces: tracesRes.results ?? [],
        gates: gatesResult.gates
      });
    }

    // POST /api/ops/agents/publish
    if (path === "/api/ops/agents/publish" && request.method === "POST") {
      const body = await request.json<{
        tenantId?: unknown;
        name?: unknown;
        industry?: unknown;
        voiceId?: unknown;
        tenantCustomization?: unknown;
        systemPrompt?: unknown;
        knowledgeText?: unknown;
      }>();

      const tenantId = typeof body?.tenantId === "string" ? body.tenantId.trim() : "";
      if (!SLUG_RE.test(tenantId)) {
        return jsonResponse({ ok: false, error: "Invalid tenantId slug (use lowercase letters, numbers, and hyphens)" }, 400);
      }
      const industry = typeof body?.industry === "string" && body.industry.trim() ? body.industry.trim() : "general";
      const rawVoice = typeof body?.voiceId === "string" ? body.voiceId.trim() : DEFAULT_MIZAN_VOICE_ID;
      const voiceId = VOICE_ID_RE.test(rawVoice) ? rawVoice : DEFAULT_MIZAN_VOICE_ID;

      // Respect locked prompt layers: Studio edits additive tenant_customization (accepting systemPrompt field as alias from UI)
      const customizationRaw =
        typeof body?.tenantCustomization === "string"
          ? body.tenantCustomization
          : typeof body?.systemPrompt === "string"
            ? body.systemPrompt
            : "";
      const tenantCustomization = customizationRaw.trim();
      if (tenantCustomization.length > 8000) {
        return jsonResponse({ ok: false, error: "tenantCustomization exceeds 8000 characters" }, 400);
      }

      const knowledgeText = typeof body?.knowledgeText === "string" ? body.knowledgeText.trim() : "";
      if (knowledgeText.length > 4000) {
        return jsonResponse({ ok: false, error: "knowledgeText exceeds 4000 characters" }, 400);
      }

      const tenantName =
        typeof body?.name === "string" && body.name.trim().length >= 2
          ? body.name.trim().slice(0, 120)
          : tenantId;

      await ensureBaselineVersions(env);

      const maxRow = await env.DB.prepare(
        "SELECT coalesce(MAX(version_number), 0) AS max_ver FROM agent_config_versions WHERE tenant_slug = ?"
      )
        .bind(tenantId)
        .first<{ max_ver: number }>();
      const nextVersion = (maxRow?.max_ver ?? 0) + 1;

      const knowledgeEntries: KnowledgeEntryInput[] = knowledgeText
        ? [{ category: "schedules", faq_text: knowledgeText }]
        : [];
      const bundleHash = await computeConfigBundleHash({
        tenantSlug: tenantId,
        industry,
        voiceId,
        tenantCustomization,
        knowledge: knowledgeEntries
      });

      const statements: D1PreparedStatement[] = [
        env.DB.prepare(
          `INSERT INTO tenants (id, slug, name, industry, status, plan_tier, max_concurrent_sessions, theme_color)
           VALUES (?, ?, ?, ?, 'active', 'pilot_14d', 3, '#6366f1')
           ON CONFLICT(slug) DO UPDATE SET
             industry = excluded.industry,
             updated_at = unixepoch()`
        ).bind(`c_${tenantId}`, tenantId, tenantName, industry),
        env.DB.prepare(
          `INSERT INTO tenant_voice_config (tenant_slug, system_prompt, voice_id, tenant_customization, updated_at)
           VALUES (?, 'أنت ميزان، المساعد الصوتي المصري العام.', ?, ?, unixepoch())
           ON CONFLICT(tenant_slug) DO UPDATE SET
             voice_id = excluded.voice_id,
             tenant_customization = excluded.tenant_customization,
             updated_at = unixepoch()`
        ).bind(tenantId, voiceId, tenantCustomization),
        env.DB.prepare("DELETE FROM tenant_knowledge WHERE tenant_slug = ?").bind(tenantId),
        ...knowledgeEntries.map((k, idx) =>
          env.DB.prepare(
            "INSERT INTO tenant_knowledge (id, tenant_slug, category, faq_text, updated_at) VALUES (?, ?, ?, ?, unixepoch())"
          ).bind(`k_${tenantId}_v${nextVersion}_${idx}`, tenantId, k.category, k.faq_text)
        ),
        env.DB.prepare(
          `INSERT INTO agent_config_versions
           (tenant_slug, version_number, industry, voice_id, tenant_customization, knowledge_json, source, bundle_hash, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 'studio', ?, ?)`
        ).bind(
          tenantId,
          nextVersion,
          industry,
          voiceId,
          tenantCustomization,
          JSON.stringify(knowledgeEntries),
          bundleHash,
          auth.actor
        ),
        env.DB.prepare(
          `INSERT INTO agent_active_version (tenant_slug, version_number, activated_at, activated_by)
           VALUES (?, ?, unixepoch(), ?)
           ON CONFLICT(tenant_slug) DO UPDATE SET
             version_number = excluded.version_number,
             activated_at = unixepoch(),
             activated_by = excluded.activated_by`
        ).bind(tenantId, nextVersion, auth.actor)
      ];

      await env.DB.batch(statements);
      await invalidateTenantCache(tenantId, null, env);

      return jsonResponse({
        ok: true,
        tenantId,
        activeVersion: nextVersion,
        bundleHash
      });
    }

    // POST /api/ops/agents/activate or /api/ops/agents/rollback (immutable pointer switch)
    if ((path === "/api/ops/agents/activate" || path === "/api/ops/agents/rollback") && request.method === "POST") {
      const body = await request.json<{ tenantId?: unknown; version?: unknown }>();
      const tenantId = typeof body?.tenantId === "string" ? body.tenantId.trim() : "";
      if (!SLUG_RE.test(tenantId)) {
        return jsonResponse({ ok: false, error: "Invalid tenantId" }, 400);
      }

      await ensureBaselineVersions(env);

      let targetVersion: number;
      if (typeof body?.version === "number" && Number.isInteger(body.version) && body.version >= 1) {
        targetVersion = body.version;
      } else {
        const current = await env.DB.prepare(
          "SELECT version_number FROM agent_active_version WHERE tenant_slug = ?"
        )
          .bind(tenantId)
          .first<{ version_number: number }>();
        if (!current || current.version_number <= 1) {
          return jsonResponse({ ok: false, error: "Already at version 1; no earlier version to roll back to" }, 400);
        }
        targetVersion = current.version_number - 1;
      }

      const snapshot = await env.DB.prepare(
        `SELECT version_number, industry, voice_id, tenant_customization, knowledge_json
         FROM agent_config_versions
         WHERE tenant_slug = ? AND version_number = ?`
      )
        .bind(tenantId, targetVersion)
        .first<{
          version_number: number;
          industry: string;
          voice_id: string;
          tenant_customization: string;
          knowledge_json: string;
        }>();

      if (!snapshot) {
        return jsonResponse({ ok: false, error: `Version v${targetVersion} not found for ${tenantId}` }, 404);
      }

      let knowledgeEntries: KnowledgeEntryInput[] = [];
      try {
        const parsed = JSON.parse(snapshot.knowledge_json);
        if (Array.isArray(parsed)) knowledgeEntries = parsed;
      } catch {
        knowledgeEntries = [];
      }

      await env.DB.batch([
        env.DB.prepare("UPDATE tenants SET industry = ?, updated_at = unixepoch() WHERE slug = ?").bind(
          snapshot.industry,
          tenantId
        ),
        env.DB.prepare(
          `INSERT INTO tenant_voice_config (tenant_slug, system_prompt, voice_id, tenant_customization, updated_at)
           VALUES (?, 'أنت ميزان، المساعد الصوتي المصري العام.', ?, ?, unixepoch())
           ON CONFLICT(tenant_slug) DO UPDATE SET
             voice_id = excluded.voice_id,
             tenant_customization = excluded.tenant_customization,
             updated_at = unixepoch()`
        ).bind(tenantId, snapshot.voice_id, snapshot.tenant_customization),
        env.DB.prepare("DELETE FROM tenant_knowledge WHERE tenant_slug = ?").bind(tenantId),
        ...knowledgeEntries.map((k, idx) =>
          env.DB.prepare(
            "INSERT INTO tenant_knowledge (id, tenant_slug, category, faq_text, updated_at) VALUES (?, ?, ?, ?, unixepoch())"
          ).bind(`k_${tenantId}_v${targetVersion}_${idx}`, tenantId, k.category, k.faq_text)
        ),
        env.DB.prepare(
          `INSERT INTO agent_active_version (tenant_slug, version_number, activated_at, activated_by)
           VALUES (?, ?, unixepoch(), ?)
           ON CONFLICT(tenant_slug) DO UPDATE SET
             version_number = excluded.version_number,
             activated_at = unixepoch(),
             activated_by = excluded.activated_by`
        ).bind(tenantId, targetVersion, auth.actor)
      ]);

      await invalidateTenantCache(tenantId, null, env);

      return jsonResponse({
        ok: true,
        tenantId,
        activeVersion: targetVersion
      });
    }

    // POST /api/ops/agents/simulate-turn
    if (path === "/api/ops/agents/simulate-turn" && request.method === "POST") {
      const allowed = await checkStudioRateLimit(env.DB, auth.actor);
      if (!allowed) {
        return jsonResponse(
          { ok: false, error: "Simulator rate limit exceeded (max 30 turns/minute). Please wait a moment." },
          429
        );
      }

      const body = await request.json<{ tenantId?: unknown; message?: unknown }>();
      const tenantId = typeof body?.tenantId === "string" ? body.tenantId.trim() : "";
      const message = typeof body?.message === "string" ? body.message.trim() : "";
      if (!SLUG_RE.test(tenantId) || !message || message.length > 1000) {
        return jsonResponse({ ok: false, error: "Valid tenantId and message (<= 1000 chars) are required" }, 400);
      }

      await ensureBaselineVersions(env);

      const tenant = await resolveTenant(tenantId, env);
      if (!tenant) {
        return jsonResponse({ ok: false, error: `Tenant '${tenantId}' not found or inactive` }, 404);
      }

      const [voiceConfig, knowledge, industryGuard, activeVerRow] = await Promise.all([
        getTenantVoiceConfig(tenantId, env),
        getTenantKnowledge(tenantId, env),
        getIndustryGuard(tenant.industry || "general", env),
        env.DB.prepare("SELECT version_number FROM agent_active_version WHERE tenant_slug = ?")
          .bind(tenantId)
          .first<{ version_number: number }>()
      ]);

      const configVersion = activeVerRow?.version_number ?? 1;
      const knowledgeContext = Object.entries(knowledge)
        .map(([cat, text]) => `[${cat}]\n${text}`)
        .join("\n\n");

      const sessionId = crypto.randomUUID();
      const cmSession = newSession();
      const extracted = extractCallerTitleAndName(message, { role: "caller" });
      const personTitleContext = {
        role: "caller" as const,
        callerName: extracted.name,
        callerTitle: extracted.title,
        callerGender: extracted.gender
      };

      const callContext: CallContext = {
        callId: sessionId,
        tenantId,
        direction: "inbound",
        callerPhone: null,
        callerType: "unknown",
        caller: {
          firstName: extracted.name,
          title: extracted.title,
          gender: extracted.gender,
          lastSummary: null,
          lastCallAt: null
        },
        business: {
          name: tenant.name,
          agentName: "ميزان",
          agentGender: "male",
          hours: knowledge.schedules || null,
          knowledge: knowledgeContext || null,
          handoffNumber: voiceConfig?.escalation_phone ?? null,
          industry: tenant.industry || "general"
        },
        clock: buildClock("Africa/Cairo")
      };

      const toolDeps: ToolDeps = {
        ctx: callContext,
        intents: DEFAULT_INTENTS,
        canTransfer: () => Boolean(voiceConfig?.escalation_phone),
        runAction: async () => ({
          ok: true,
          detail: "simulated studio action completed"
        })
      };

      const turnResult = await runTextTurn({
        env,
        tenantSlug: tenantId,
        responseLanguage: "ar",
        escalationPhone: voiceConfig?.escalation_phone ?? null,
        industryGuard,
        tenantCustomization: voiceConfig?.tenant_customization ?? "",
        personTitleContext,
        cmSession,
        intents: DEFAULT_INTENTS,
        conversation: [],
        toolDeps,
        transcript: message,
        hasPrivateContact: false,
        contactDeclined: false,
        protect: (t) =>
          redactPII(t)
            .replace(/\b\d{14}\b/gu, "[رقم قومي]")
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]")
      });

      const guardViolations = [...turnResult.honorificViolations, ...turnResult.msaViolations];
      const traceId = crypto.randomUUID();

      await env.DB.prepare(
        `INSERT INTO turn_traces
         (trace_id, session_id, tenant_slug, turn_index, environment, runtime_version, config_version, llm_ttft_ms, tts_ttfb_ms, guard_violations_json, barge_ins)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, 0, ?, 0)`
      )
        .bind(
          traceId,
          sessionId,
          tenantId,
          env.ENVIRONMENT || "staging",
          runtimeVersion,
          configVersion,
          turnResult.llmLatencyMs,
          JSON.stringify(guardViolations)
        )
        .run();

      return jsonResponse({
        ok: true,
        traceId,
        tenantId,
        configVersion,
        runtimeVersion,
        scrubbedInput: turnResult.redactedTranscript,
        reply: turnResult.reply,
        guardViolations,
        latencyMs: turnResult.llmLatencyMs,
        state: cmSession.state,
        intent: cmSession.intent
      });
    }

    // POST /api/ops/gates/run
    if (path === "/api/ops/gates/run" && request.method === "POST") {
      const result = await runDeterministicGates(env);
      return jsonResponse(result);
    }

    // GET /api/ops/agents/export?tenantId=...&version=...
    if (path === "/api/ops/agents/export" && request.method === "GET") {
      const tenantId = (url.searchParams.get("tenantId") || "").trim();
      if (!SLUG_RE.test(tenantId)) {
        return jsonResponse({ ok: false, error: "Valid tenantId query parameter is required" }, 400);
      }

      await ensureBaselineVersions(env);

      const tenant = await env.DB.prepare("SELECT slug, name FROM tenants WHERE slug = ?")
        .bind(tenantId)
        .first<{ slug: string; name: string }>();
      if (!tenant) {
        return jsonResponse({ ok: false, error: `Tenant '${tenantId}' not found` }, 404);
      }

      const requestedVer = Number(url.searchParams.get("version") || 0);
      let versionToExport = requestedVer;
      if (!Number.isInteger(versionToExport) || versionToExport < 1) {
        const active = await env.DB.prepare(
          "SELECT version_number FROM agent_active_version WHERE tenant_slug = ?"
        )
          .bind(tenantId)
          .first<{ version_number: number }>();
        versionToExport = active?.version_number ?? 1;
      }

      const snapshot = await env.DB.prepare(
        `SELECT version_number, industry, voice_id, tenant_customization, knowledge_json, bundle_hash
         FROM agent_config_versions
         WHERE tenant_slug = ? AND version_number = ?`
      )
        .bind(tenantId, versionToExport)
        .first<{
          version_number: number;
          industry: string;
          voice_id: string;
          tenant_customization: string;
          knowledge_json: string;
          bundle_hash: string;
        }>();

      if (!snapshot) {
        return jsonResponse({ ok: false, error: `Version v${versionToExport} not found for ${tenantId}` }, 404);
      }

      let knowledge: KnowledgeEntryInput[] = [];
      try {
        const parsed = JSON.parse(snapshot.knowledge_json);
        if (Array.isArray(parsed)) knowledge = parsed;
      } catch {
        knowledge = [];
      }

      const bundleHash = await computeConfigBundleHash({
        tenantSlug: tenantId,
        industry: snapshot.industry,
        voiceId: snapshot.voice_id,
        tenantCustomization: snapshot.tenant_customization,
        knowledge
      });

      const payload: AgentReleasePayload = {
        schemaVersion: 1,
        tenantSlug: tenantId,
        tenantName: tenant.name,
        industry: snapshot.industry,
        voiceId: snapshot.voice_id,
        tenantCustomization: snapshot.tenant_customization,
        knowledge,
        sourceVersion: snapshot.version_number,
        sourceEnvironment: env.ENVIRONMENT || "staging",
        sourceSha: runtimeVersion,
        bundleHash,
        exportedAt: Math.floor(Date.now() / 1000)
      };

      const secret = resolveSigningKeySecret(env);
      const bundle = await signReleaseBundle(payload, secret);

      return jsonResponse({
        ok: true,
        bundle
      });
    }

    return jsonResponse({ ok: false, error: "Studio endpoint not found" }, 404);
  } catch (err) {
    return jsonResponse(
      { ok: false, error: err instanceof Error ? err.message : "Studio operation failed" },
      500
    );
  }
}
