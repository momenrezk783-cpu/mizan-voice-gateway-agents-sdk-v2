// ============================================================================
// Mizan Voice Gateway — Worker Entry Point (Agents SDK v2)
// ============================================================================
// Single unified worker handling:
//   - Voice agent WebSocket routing (via routeAgentRequest)
//   - Public patient voice page (/c/:slug)
//   - Clinic portal API (/api/client/*)
//   - Admin dashboard API (/api/admin/*)
//   - Background queue consumer (D1 recording, session finalization)
//   - Scheduled tasks (pilot expiry, stale session cleanup)
//   - Static assets (SPA fallback)
// ============================================================================

import { MizanVoiceAgent, routeAgentRequest } from "./agent";
import { resolveTenant, resolveTenantByDomain, getTenantKnowledge, invalidateTenantCache, invalidateGlobalCache } from "./lib/tenant";
import { getSessionUser, createSessionResponse, clearSessionCookie, canAccessTenant, hashPassword, verifyPassword } from "./lib/auth";
import { encryptPII, decryptPII, redactPII } from "./lib/crypto";
import { EMBEDDED_UI_ASSETS } from "./lib/ui-assets";

// Re-export the Agent class so Wrangler can find it
export { MizanVoiceAgent };

interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  AUDIO_BUCKET?: R2Bucket;
  AI: Ai;
  VOICE_METRICS: AnalyticsEngineDataset;
  BACKGROUND_QUEUE: Queue<BackgroundMessage>;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  CONTACT_ENC_KEY: string;
  ADMIN_PASSKEY_HASH: string;
  DEEPGRAM_API_KEY?: string;
  ELEVENLABS_TTS_KEY?: string;
  VOICE_WS_BASE: string;
  PRIMARY_LLM: string;
  FALLBACK_LLM: string;
  ENVIRONMENT: string;
}

interface BackgroundMessage {
  type: "record_turn" | "end_session" | "record_usage";
  tenantSlug: string;
  sessionId: string;
  speaker?: string;
  transcript?: string;
  latencyMs?: number;
  turnIndex?: number;
}

const PCM_PROCESSOR_WORKLET_JS = "// PCM Processor — AudioWorkletNode\n// Converts Float32 audio (16,000 Hz mono) to 16-bit signed little-endian PCM (linear16)\n// and batches 2048 samples (4096 bytes / 128ms) per frame to minimize WebSocket event overhead.\n// Loaded via: audioCtx.audioWorklet.addModule('/pcm-processor.js')\n\nconst CHUNK_SAMPLES = 2048;\n\nclass PCMProcessor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this._buffer = new Int16Array(CHUNK_SAMPLES);\n    this._offset = 0;\n    this.port.onmessage = (event) => {\n      if (event.data && event.data.type === 'flush') {\n        this._flushPartial();\n      }\n    };\n  }\n\n  _flushPartial() {\n    if (this._offset > 0) {\n      const slice = this._buffer.slice(0, this._offset);\n      this.port.postMessage(slice.buffer, [slice.buffer]);\n      this._offset = 0;\n    }\n  }\n\n  process(inputs) {\n    const input = inputs[0];\n    if (input && input[0]) {\n      const float32 = input[0];\n      for (let i = 0; i < float32.length; i++) {\n        const raw = float32[i];\n        const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;\n        this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;\n        if (this._offset >= CHUNK_SAMPLES) {\n          const out = this._buffer.slice(0, CHUNK_SAMPLES);\n          this.port.postMessage(out.buffer, [out.buffer]);\n          this._offset = 0;\n        }\n      }\n    }\n    return true;\n  }\n}\n\nregisterProcessor('pcm-processor', PCMProcessor);\n";

const corsHeaders = {
  "Access-Control-Allow-Origin": "https://mizanconsult.com",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Credentials": "true",
};

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // AudioWorklet PCM processor (serves latest linear16 processor directly)
    if (url.pathname === "/pcm-processor.js") {
      return new Response(PCM_PROCESSOR_WORKLET_JS, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": "no-cache"
        }
      });
    }

    // WebSocket upgrade → route to voice Agent via Agents SDK
    if (request.headers.get("Upgrade") === "websocket") {
      return handleVoiceWebSocket(request, env, url);
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, ctx);
    }

    // Embeddable widget script: /embed/:slug.js
    const embedMatch = url.pathname.match(/^\/embed\/([\w-]+)\.js$/);
    if (embedMatch) {
      return handleEmbedWidget(request, env, embedMatch[1]);
    }

    // Public patient voice page: /c/:slug
    const publicMatch = url.pathname.match(/^\/c\/([\w-]+)\/?$/);
    if (publicMatch) {
      return handlePublicVoicePage(request, env, publicMatch[1]);
    }

    // Serve updated Mizan Enterprise AI SaaS UI routes directly with no-cache headers
    const normalizedPath = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    const embeddedAsset = EMBEDDED_UI_ASSETS[normalizedPath];
    if (embeddedAsset && (request.method === "GET" || request.method === "HEAD")) {
      return new Response(request.method === "HEAD" ? null : embeddedAsset.body, {
        status: 200,
        headers: {
          "Content-Type": embeddedAsset.contentType,
          "Cache-Control": "no-cache, must-revalidate"
        }
      });
    }

    // Everything else → static assets (SPA fallback)
    return env.ASSETS.fetch(request);
  },

  // -------------------------------------------------------------------------
  // Queue consumer — background D1 writes (non-blocking for voice turns)
  // -------------------------------------------------------------------------

  async queue(batch: MessageBatch<BackgroundMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        await processBackgroundMessage(message.body, env);
        message.ack();
      } catch (err) {
        console.error("Background task failed:", {
          messageId: message.id,
          error: err instanceof Error ? err.message : String(err),
        });
        message.retry({ delaySeconds: 30 });
      }
    }
  },

  // -------------------------------------------------------------------------
  // Scheduled — every 5 min: expire pilots, clean stale sessions
  // -------------------------------------------------------------------------

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(Promise.all([
      expireStaleSessions(env),
      expirePilots(env),
    ]));
  },
};

// ---------------------------------------------------------------------------
// Voice WebSocket — route to per-tenant Agent instance
// ---------------------------------------------------------------------------

async function handleVoiceWebSocket(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // Expected: /agents/mizan-voice-agent/:slug?session_id=<uuid>
  // Or: /agents/mizan-voice-agent/:slug (session ID generated by client)
  const match = url.pathname.match(/^\/agents\/mizan-voice-agent\/([\w-]+)\/?$/);
  if (!match) {
    return new Response("Invalid WebSocket path", { status: 400 });
  }

  const slug = match[1];
  const sessionId = url.searchParams.get("session_id") ?? crypto.randomUUID();

  // Validate tenant exists and is active before routing
  const tenant = await resolveTenant(slug, env);
  if (!tenant) {
    return new Response("Tenant not found or suspended", { status: 404 });
  }

  // Enforce per-tenant concurrent session limit
  if (tenant.max_concurrent_sessions > 0) {
    const activeCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM call_sessions
       WHERE tenant_slug = ? AND call_status = 'active'`
    )
      .bind(slug)
      .first<{ count: number }>();

    if ((activeCount?.count ?? 0) >= tenant.max_concurrent_sessions) {
      return new Response("Maximum concurrent sessions reached for this organization", { status: 429 });
    }
  }

  // Rewrite the URL so routeAgentRequest sees the instance name as "slug:sessionId"
  const agentUrl = new URL(request.url);
  agentUrl.pathname = `/agents/mizan-voice-agent/${slug}:${sessionId}`;

  const agentRequest = new Request(agentUrl, {
    method: request.method,
    headers: request.headers,
  });

  // routeAgentRequest handles DO instantiation + WebSocket upgrade
  // It auto-maps the MIZAN_VOICE_AGENT binding to /agents/mizan-voice-agent/{name}
  return routeAgentRequest(agentRequest, env) ?? new Response("Agent not found", { status: 404 });
}

// ---------------------------------------------------------------------------
// API Router
// ---------------------------------------------------------------------------

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
  ctx: ExecutionContext
): Promise<Response> {
  const path = url.pathname;

  try {
    // Portal auth
    if (path === "/api/client/auth/login" && request.method === "POST")
      return await portalLogin(request, env);
    if (path === "/api/client/auth/logout" && request.method === "POST")
      return portalLogout();
    if (path === "/api/client/auth/me" && request.method === "GET")
      return await portalMe(request, env);

    // Portal API (requires session)
    if (path.startsWith("/api/client/"))
      return await portalApi(request, env, url);

    // Admin API (requires super_admin)
    if (path.startsWith("/api/admin/"))
      return await adminApi(request, env, url);

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("API error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Portal Auth
// ---------------------------------------------------------------------------

async function portalLogin(request: Request, env: Env): Promise<Response> {
  const { email, password } = await request.json<{ email: string; password: string }>();

  const user = await env.DB.prepare(
    `SELECT id, tenant_slug, email, password_hash, role FROM portal_users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; tenant_slug: string; email: string; password_hash: string; role: string }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "بيانات الدخول غير صحيحة" }, 401);
  }

  const sessionUser = {
    id: user.id,
    email: user.email,
    role: user.role as "super_admin" | "clinic_admin",
    tenantSlug: user.tenant_slug,
  };

  const setCookie = await createSessionResponse(sessionUser, env);
  return json({ user: sessionUser }, 200, { "Set-Cookie": setCookie });
}

function portalLogout(): Response {
  return json({ ok: true }, 200, { "Set-Cookie": clearSessionCookie() });
}

async function portalMe(request: Request, env: Env): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Not authenticated" }, 401);
  return json({ user });
}

// ---------------------------------------------------------------------------
// Portal API (tenant-scoped — tenant from session cookie, never from client)
// ---------------------------------------------------------------------------

async function portalApi(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Not authenticated" }, 401);

  const slug = user.tenantSlug;
  const path = url.pathname;

  // GET /api/client/sessions — list call sessions
  if (path === "/api/client/sessions" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, direction, call_status, selected_doctor, selected_slot,
              booking_confirmed, started_at, ended_at
       FROM call_sessions WHERE tenant_slug = ?
       ORDER BY started_at DESC LIMIT 100`
    ).bind(slug).all();
    return json({ sessions: rows.results });
  }

  // GET /api/client/sessions/:id — session detail with turns
  const sessionMatch = path.match(/^\/api\/client\/sessions\/([\w-]+)$/);
  if (sessionMatch && request.method === "GET") {
    const sessionId = sessionMatch[1];
    const session = await env.DB.prepare(
      `SELECT * FROM call_sessions WHERE id = ? AND tenant_slug = ?`
    ).bind(sessionId, slug).first();

    if (!session) return json({ error: "Session not found" }, 404);

    let callerName = null, callerPhone = null;
    if (session.caller_name_enc) callerName = await decryptPII(session.caller_name_enc as string, env);
    if (session.caller_phone_enc) callerPhone = await decryptPII(session.caller_phone_enc as string, env);

    const turns = await env.DB.prepare(
      `SELECT turn_index, speaker, transcript_redacted, latency_ms, created_at
       FROM call_turns WHERE session_id = ? AND tenant_slug = ? ORDER BY turn_index ASC`
    ).bind(sessionId, slug).all();

    return json({
      session: { ...session, caller_name: callerName, caller_phone: callerPhone },
      turns: turns.results,
    });
  }

  // GET /api/client/knowledge
  if (path === "/api/client/knowledge" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, category, faq_text, updated_at FROM tenant_knowledge WHERE tenant_slug = ?`
    ).bind(slug).all();
    return json({ entries: rows.results });
  }

  // POST /api/client/knowledge
  if (path === "/api/client/knowledge" && request.method === "POST") {
    const { faq_text, category } = await request.json<{ faq_text: string; category: string }>();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO tenant_knowledge (id, tenant_slug, category, faq_text, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())`
    ).bind(id, slug, category || "general", faq_text).run();
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true, id }, 201);
  }

  // PUT /api/client/knowledge/:id
  const knowledgeMatch = path.match(/^\/api\/client\/knowledge\/([\w-]+)$/);
  if (knowledgeMatch && request.method === "PUT") {
    const { faq_text, category } = await request.json<{ faq_text: string; category: string }>();
    await env.DB.prepare(
      `UPDATE tenant_knowledge SET faq_text = ?, category = ?, updated_at = unixepoch()
       WHERE id = ? AND tenant_slug = ?`
    ).bind(faq_text, category, knowledgeMatch[1], slug).run();
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true });
  }

  // GET /api/client/voice-config
  if (path === "/api/client/voice-config" && request.method === "GET") {
    const config = await env.DB.prepare(
      `SELECT system_prompt, voice_id, allow_medical_advice, escalation_phone, ttl_seconds
       FROM tenant_voice_config WHERE tenant_slug = ?`
    ).bind(slug).first();
    return json({ config });
  }

  // PUT /api/client/voice-config
  if (path === "/api/client/voice-config" && request.method === "PUT") {
    const body = await request.json<{
      system_prompt?: string; voice_id?: string; allow_medical_advice?: number;
      escalation_phone?: string; ttl_seconds?: number;
    }>();
    await env.DB.prepare(
      `UPDATE tenant_voice_config
       SET system_prompt = COALESCE(?, system_prompt),
           voice_id = COALESCE(?, voice_id),
           allow_medical_advice = COALESCE(?, allow_medical_advice),
           escalation_phone = COALESCE(?, escalation_phone),
           ttl_seconds = COALESCE(?, ttl_seconds),
           updated_at = unixepoch()
       WHERE tenant_slug = ?`
    ).bind(
      body.system_prompt ?? null, body.voice_id ?? null,
      body.allow_medical_advice ?? null, body.escalation_phone ?? null,
      body.ttl_seconds ?? null, slug
    ).run();
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true });
  }

  // PUT /api/client/customization — tenant can ONLY edit customization + escalation
  if (path === "/api/client/customization" && request.method === "PUT") {
    const body = await request.json<{ tenant_customization?: string; escalation_phone?: string }>();
    await env.DB.prepare(
      `UPDATE tenant_voice_config
       SET tenant_customization = COALESCE(?, tenant_customization),
           escalation_phone = COALESCE(?, escalation_phone),
           updated_at = unixepoch()
       WHERE tenant_slug = ?`
    ).bind(body.tenant_customization ?? null, body.escalation_phone ?? null, slug).run();
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true });
  }

  // GET /api/client/assistant-status
  if (path === "/api/client/assistant-status" && request.method === "GET") {
    const knowledgeCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM tenant_knowledge WHERE tenant_slug = ?`
    ).bind(slug).first<{ count: number }>();
    const avgLatency = await env.DB.prepare(
      `SELECT AVG(latency_ms) as avg FROM call_turns WHERE tenant_slug = ? AND latency_ms IS NOT NULL`
    ).bind(slug).first<{ avg: number | null }>();
    return json({
      status: "نشط ويعمل بشكل طبيعي",
      knowledge_count: knowledgeCount?.count ?? 0,
      avg_latency: avgLatency?.avg ? Math.round(avgLatency.avg) : null,
      uptime: null,
    });
  }

  // GET /api/client/share-links — all share links for this tenant
  if (path === "/api/client/share-links" && request.method === "GET") {
    const tenant = await env.DB.prepare(
      `SELECT slug, name, theme_color, logo_url FROM tenants WHERE slug = ?`
    ).bind(slug).first<{ slug: string; name: string; theme_color: string; logo_url: string | null }>();

    if (!tenant) return json({ error: "Tenant not found" }, 404);

    const callUrl = `https://mizanconsult.com/c/${tenant.slug}`;
    const embedUrl = `https://mizanconsult.com/embed/${tenant.slug}.js`;
    const encodedUrl = encodeURIComponent(callUrl);
    const encodedText = encodeURIComponent(`تحدث مع المساعد الصوتي لـ ${tenant.name}`);

    return json({
      call_url: callUrl,
      embed_code: `<script src="${embedUrl}"></script>`,
      embed_url: embedUrl,
      social: {
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
        whatsapp: `https://wa.me/?text=${encodedText}%20${encodedUrl}`,
        telegram: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}`,
        twitter: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      },
      qr_url: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodedUrl}`,
      tenant_name: tenant.name,
      theme_color: tenant.theme_color || "#1BA6B8",
    });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Admin API (super_admin only — cross-tenant)
// ---------------------------------------------------------------------------

async function adminApi(request: Request, env: Env, url: URL): Promise<Response> {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: "Not authenticated" }, 401);
  if (user.role !== "super_admin") return json({ error: "Forbidden" }, 403);

  const path = url.pathname;

  // GET /api/admin/tenants
  if (path === "/api/admin/tenants" && request.method === "GET") {
    const rows = await env.DB.prepare(
      `SELECT id, slug, name, domain, status, plan_tier, max_concurrent_sessions, theme_color, logo_url, industry, created_at
       FROM tenants ORDER BY created_at DESC`
    ).all();
    return json({ tenants: rows.results });
  }

  // POST /api/admin/tenants — create new tenant (onboarding playbook, all industries)
  if (path === "/api/admin/tenants" && request.method === "POST") {
    const body = await request.json<{
      slug: string; name: string; industry?: string; domain?: string; plan_tier?: string;
      max_concurrent_sessions?: number; theme_color?: string; logo_url?: string;
      system_prompt: string; voice_id?: string;
    }>();

    const tenantId = `c_${body.slug}`;
    await env.DB.prepare(
      `INSERT INTO tenants (id, slug, name, industry, domain, plan_tier, max_concurrent_sessions, theme_color, logo_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      tenantId, body.slug, body.name, body.industry ?? "general", body.domain ?? null,
      body.plan_tier ?? "pilot_14d", body.max_concurrent_sessions ?? 1,
      body.theme_color ?? "#1BA6B8", body.logo_url ?? null
    ).run();

    await env.DB.prepare(
      `INSERT INTO tenant_voice_config (tenant_slug, system_prompt, voice_id)
       VALUES (?, ?, ?)`
    ).bind(body.slug, body.system_prompt, body.voice_id ?? "MX8opBj7bbi4G2cE9j2w").run();

    return json({ ok: true, tenantId }, 201);
  }

  // GET /api/admin/tenants/:slug
  const tenantMatch = path.match(/^\/api\/admin\/tenants\/([\w-]+)$/);
  if (tenantMatch && request.method === "GET") {
    const slug = tenantMatch[1];
    const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE slug = ?`).bind(slug).first();
    if (!tenant) return json({ error: "Tenant not found" }, 404);

    const voiceConfig = await env.DB.prepare(
      `SELECT * FROM tenant_voice_config WHERE tenant_slug = ?`
    ).bind(slug).first();

    const stats = await env.DB.prepare(
      `SELECT COUNT(*) as calls,
              SUM(CASE WHEN booking_confirmed = 1 THEN 1 ELSE 0 END) as bookings,
              AVG(ct.latency_ms) as avg_latency
       FROM call_sessions cs
       LEFT JOIN call_turns ct ON ct.tenant_slug = cs.tenant_slug
       WHERE cs.tenant_slug = ?`
    ).bind(slug).first();

    return json({ tenant, voiceConfig, stats });
  }

  // PUT /api/admin/tenants/:slug
  if (tenantMatch && request.method === "PUT") {
    const slug = tenantMatch![1];
    const body = await request.json<{
      name?: string; domain?: string; status?: string; plan_tier?: string;
      max_concurrent_sessions?: number; theme_color?: string; logo_url?: string;
    }>();
    await env.DB.prepare(
      `UPDATE tenants
       SET name = COALESCE(?, name), domain = COALESCE(?, domain),
           status = COALESCE(?, status), plan_tier = COALESCE(?, plan_tier),
           max_concurrent_sessions = COALESCE(?, max_concurrent_sessions),
           theme_color = COALESCE(?, theme_color), logo_url = COALESCE(?, logo_url),
           updated_at = unixepoch()
       WHERE slug = ?`
    ).bind(
      body.name ?? null, body.domain ?? null, body.status ?? null,
      body.plan_tier ?? null, body.max_concurrent_sessions ?? null,
      body.theme_color ?? null, body.logo_url ?? null, slug
    ).run();

    const tenant = await env.DB.prepare(`SELECT domain FROM tenants WHERE slug = ?`).bind(slug).first<{ domain: string | null }>();
    await invalidateTenantCache(slug, tenant?.domain ?? null, env);
    return json({ ok: true });
  }

  // GET /api/admin/metrics — cross-tenant dashboard
  if (path === "/api/admin/metrics" && request.method === "GET") {
    const metrics = await env.DB.prepare(
      `SELECT t.slug, t.name, t.status, t.plan_tier,
              COUNT(cs.id) as total_calls,
              SUM(CASE WHEN cs.call_status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN cs.booking_confirmed = 1 THEN 1 ELSE 0 END) as bookings,
              AVG(ct.latency_ms) as avg_latency
       FROM tenants t
       LEFT JOIN call_sessions cs ON cs.tenant_slug = t.slug
       LEFT JOIN call_turns ct ON ct.tenant_slug = t.slug
       GROUP BY t.slug ORDER BY total_calls DESC`
    ).all();
    return json({ metrics: metrics.results });
  }

  // GET /api/admin/recent-calls — recent calls across all tenants
  if (path === "/api/admin/recent-calls" && request.method === "GET") {
    const calls = await env.DB.prepare(
      `SELECT cs.id, cs.tenant_slug, t.name as tenant_name,
              cs.call_status, cs.selected_doctor, cs.booking_confirmed,
              cs.started_at, cs.ended_at
       FROM call_sessions cs
       LEFT JOIN tenants t ON t.slug = cs.tenant_slug
       ORDER BY cs.started_at DESC LIMIT 20`
    ).all();
    return json({ calls: calls.results });
  }

  // GET /api/admin/assistant-status — global assistant status
  if (path === "/api/admin/assistant-status" && request.method === "GET") {
    const tenantCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM tenants WHERE status = 'active'`
    ).first<{ count: number }>();
    const knowledgeCount = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM tenant_knowledge`
    ).first<{ count: number }>();
    const avgLatency = await env.DB.prepare(
      `SELECT AVG(latency_ms) as avg FROM call_turns WHERE latency_ms IS NOT NULL`
    ).first<{ avg: number | null }>();
    return json({
      status: "نشط ويعمل بشكل طبيعي",
      active_tenants: tenantCount?.count ?? 0,
      knowledge_count: knowledgeCount?.count ?? 0,
      avg_latency: avgLatency?.avg != null ? Math.round(avgLatency.avg) : null,
      uptime: null,
    });
  }

  // GET /api/admin/global-voice-config — Mizan identity (super_admin only)
  if (path === "/api/admin/global-voice-config" && request.method === "GET") {
    const config = await env.DB.prepare(
      `SELECT system_prompt, voice_id FROM global_voice_config WHERE id = 1`
    ).first();
    return json({ config });
  }

  // PUT /api/admin/global-voice-config — update Mizan identity
  if (path === "/api/admin/global-voice-config" && request.method === "PUT") {
    const body = await request.json<{ system_prompt?: string; voice_id?: string }>();
    await env.DB.prepare(
      `UPDATE global_voice_config
       SET system_prompt = COALESCE(?, system_prompt),
           voice_id = COALESCE(?, voice_id),
           updated_at = unixepoch()
       WHERE id = 1`
    ).bind(body.system_prompt ?? null, body.voice_id ?? null).run();
    await invalidateGlobalCache(env);
    return json({ ok: true });
  }

  // GET /api/admin/industry-guards — list all guards
  if (path === "/api/admin/industry-guards" && request.method === "GET") {
    const guards = await env.DB.prepare(
      `SELECT industry, guard_text, enabled FROM industry_guards ORDER BY industry`
    ).all();
    return json({ guards: guards.results });
  }

  // PUT /api/admin/industry-guards/:industry — update guard
  const guardMatch = path.match(/^\/api\/admin\/industry-guards\/([\w-]+)$/);
  if (guardMatch && request.method === "PUT") {
    const industry = guardMatch[1];
    const body = await request.json<{ guard_text?: string; enabled?: number }>();
    await env.DB.prepare(
      `UPDATE industry_guards
       SET guard_text = COALESCE(?, guard_text),
           enabled = COALESCE(?, enabled)
       WHERE industry = ?`
    ).bind(body.guard_text ?? null, body.enabled ?? null, industry).run();
    await env.TENANT_CONFIG.delete(`industry_guard:${industry}`);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Background Queue Processor
// ---------------------------------------------------------------------------

async function processBackgroundMessage(msg: BackgroundMessage, env: Env): Promise<void> {
  switch (msg.type) {
    case "record_turn": {
      const turnId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO call_turns (id, session_id, tenant_slug, turn_index, speaker, transcript_redacted, latency_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`
      ).bind(
        turnId, msg.sessionId, msg.tenantSlug, msg.turnIndex ?? 0,
        msg.speaker ?? "caller", msg.transcript ?? "", msg.latencyMs ?? null
      ).run();
      break;
    }

    case "end_session": {
      await env.DB.prepare(
        `UPDATE call_sessions SET call_status = 'completed', ended_at = unixepoch()
         WHERE id = ? AND tenant_slug = ?`
      ).bind(msg.sessionId, msg.tenantSlug).run();
      break;
    }

    case "record_usage": {
      await env.DB.prepare(
        `INSERT INTO tenant_usage (tenant_slug, metric, value, recorded_at)
         VALUES (?, 'call_count', 1, unixepoch())`
      ).bind(msg.tenantSlug).run();
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Scheduled Tasks
// ---------------------------------------------------------------------------

async function expireStaleSessions(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE call_sessions
     SET call_status = 'abandoned', ended_at = unixepoch()
     WHERE call_status = 'active' AND started_at < unixepoch() - 1800`
  ).run();
}

async function expirePilots(env: Env): Promise<void> {
  // Suspend tenants whose 14-day pilot has expired
  await env.DB.prepare(
    `UPDATE tenants SET status = 'suspended', updated_at = unixepoch()
     WHERE plan_tier = 'pilot_14d' AND status = 'active'
       AND created_at < unixepoch() - (14 * 24 * 60 * 60)`
  ).run();
}

// ---------------------------------------------------------------------------
// Embeddable Widget: /embed/:slug.js
// ---------------------------------------------------------------------------

async function handleEmbedWidget(request: Request, env: Env, slug: string): Promise<Response> {
  const tenant = await resolveTenant(slug, env);
  if (!tenant) {
    return new Response("// Tenant not found", { status: 404, headers: { "Content-Type": "application/javascript" } });
  }

  const accent = tenant.theme_color || "#1BA6B8";
  const callUrl = `https://mizanconsult.com/c/${slug}`;

  const js = `(function(){var d=document,s=d.createElement('style'),b=d.createElement('a');
s.textContent='.mz-fab{position:fixed;bottom:24px;left:24px;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,${accent},${shadeColor(accent,40)});display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px ${hexToRgba(accent,0.4)};z-index:99999;cursor:pointer;transition:transform .3s ease;text-decoration:none}.mz-fab:hover{transform:scale(1.1)}.mz-fab svg{width:28px;height:28px}.mz-fab::after{content:"";position:absolute;inset:-6px;border-radius:50%;border:2px solid ${accent};animation:mz-pulse 2s ease-out infinite}@keyframes mz-pulse{0%{transform:scale(1);opacity:.6}100%{transform:scale(1.5);opacity:0}}';
d.head.appendChild(s);b.href='${callUrl}';b.target='_blank';b.rel='noopener';b.className='mz-fab';
b.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>';
d.body.appendChild(b);})();`;

  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// Public Voice Page: /c/:slug
// ---------------------------------------------------------------------------

const DEFAULT_THEME = { accent: "#1BA6B8", accent2: "#2BB8C7", glow: "rgba(27, 166, 184, 0.34)" };

async function handlePublicVoicePage(request: Request, env: Env, slug: string): Promise<Response> {
  const tenant = await resolveTenant(slug, env);
  if (!tenant) {
    return new Response("Organization not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const wsBase = env.VOICE_WS_BASE || "wss://voice.mizanconsult.com";
  const sessionId = crypto.randomUUID();
  const accent = tenant.theme_color || DEFAULT_THEME.accent;
  const theme = {
    accent,
    accent2: shadeColor(accent, 40),
    glow: hexToRgba(accent, 0.3),
  };
  const logoUrl = tenant.logo_url ? new URL(tenant.logo_url, request.url).toString() : null;
  const avatarContent = logoUrl
    ? `<img src="${logoUrl}" alt="${tenant.name}">`
    : `<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8"></path></svg>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#0B2D4B">
  <title>${tenant.name} — المساعد الصوتي المباشر</title>
  <meta property="og:title" content="${tenant.name} — مساعد صوتي">
  <meta property="og:description" content="تحدث الآن مع المساعد الصوتي لـ ${tenant.name}. احجز موعدك أو استفسر عن خدماتنا فوراً.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://mizanconsult.com/c/${tenant.slug}">
  <meta property="og:locale" content="ar_EG">
  <meta property="og:site_name" content="Mizan HQ">
  ${logoUrl ? `<meta property="og:image" content="${logoUrl}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${tenant.name} — مساعد صوتي">
  <meta name="twitter:description" content="تحدث الآن مع المساعد الصوتي لـ ${tenant.name}.">
  <link rel="stylesheet" href="/css/voice.css">
  <style>
    :root {
      --mz-accent: ${theme.accent};
      --mz-accent-2: ${theme.accent2};
      --mz-accent-glow: ${theme.glow};
    }
  </style>
</head>
<body data-tour-context="call">
  <div class="vp" id="orbWrapper">
    <div class="top-row">
      <a href="/" class="lg">
        <div class="lm"><img src="/images/mizan-hq-logo.webp" alt="Mizan HQ" style="width:40px;height:40px;object-fit:contain;background:#fff;border-radius:8px"></div>
        ميزان هيد كوارتر
      </a>
      <button type="button" class="mz-tour-trigger-btn" onclick="MizanOnboarding.start('call')">🎯 جولة تعريفية</button>
    </div>
    <div class="av">${avatarContent}</div>
    <h1>${tenant.name}</h1>
    <p class="tag">المساعد جاهز يرد على حضرتك</p>
    <span class="st" id="status">متصل وجاهز</span>
    <div class="wave idle" id="wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
    <button class="mic" id="callBtn" onclick="toggleCall()" aria-label="ابدأ المكالمة">
      <svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3a4 4 0 0 0-4 4v4a4 4 0 0 0 8 0V7a4 4 0 0 0-4-4zM5 11a7 7 0 0 0 14 0M12 18v3"></path>
      </svg>
    </button>
    <p class="tag" id="visualizer">دوس عشان تتكلم مع المساعد</p>
    <div class="call-controls" id="callControls">
      <div class="call-timer" id="timer">00:00</div>
      <button class="mute-button" id="muteBtn" onclick="toggleMute()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/></svg>
        <span id="muteLabel">كتم</span>
      </button>
    </div>
    <div class="card" id="transcriptContainer">
      <div>اسأل عن مواعيد العمل، أو الخدمات المتاحة، أو احجز ميعاد، أو اعرف مكان الفروع.</div>
      <div class="transcript" id="transcript"></div>
    </div>
    <div class="ft">بدعم من <a href="https://mizanconsult.com">ميزان هيد كوارتر</a></div>
  </div>
  <script src="/js/onboarding.js"></script>
  <script>
    const TENANT_SLUG="${tenant.slug}",SESSION_ID="${sessionId}",WS_BASE="${wsBase}";
    let ws=null,audioCtx=null,stream=null,audioSource=null,audioNode=null,calling=false,muted=false,timerInt=null,startT=null,callAttempt=0,playbackTime=0;
    async function toggleCall(){calling?endCall():startCall()}
    async function startCall(){
      const attempt=++callAttempt;
      const b=document.getElementById('callBtn'),ow=document.getElementById('orbWrapper'),s=document.getElementById('status'),c=document.getElementById('callControls'),w=document.getElementById('wave');
      b.classList.add('connecting');ow.classList.add('connecting');s.textContent='يرجى السماح باستخدام الميكروفون...';s.className='st connecting';
      try{
        if(!navigator.mediaDevices?.getUserMedia)throw new Error('المتصفح لا يدعم الوصول إلى الميكروفون أو أن الصفحة ليست عبر HTTPS');
        const acquiredStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,sampleRate:16000,channelCount:1}});
        if(attempt!==callAttempt){acquiredStream.getTracks().forEach(t=>t.stop());return}
        stream=acquiredStream;
        const AudioContextClass=window.AudioContext||window.webkitAudioContext;
        if(!AudioContextClass)throw new Error('المتصفح لا يدعم Web Audio API');
        audioCtx=new AudioContextClass({sampleRate:16000});
        await audioCtx.resume();
        const workletCode="const CHUNK_SAMPLES=2048;class PCMProcessor extends AudioWorkletProcessor{constructor(){super();this._buffer=new Int16Array(CHUNK_SAMPLES);this._offset=0;this.port.onmessage=e=>{if(e.data&&e.data.type===\x27flush\x27&&this._offset>0){const s=this._buffer.slice(0,this._offset);this.port.postMessage(s.buffer,[s.buffer]);this._offset=0}}}process(inputs){const input=inputs[0];if(input&&input[0]){const f=input[0];for(let i=0;i<f.length;i++){const r=f[i],s=Number.isFinite(r)?Math.max(-1,Math.min(1,r)):0;this._buffer[this._offset++]=s<0?s*0x8000:s*0x7FFF;if(this._offset>=CHUNK_SAMPLES){const o=this._buffer.slice(0,CHUNK_SAMPLES);this.port.postMessage(o.buffer,[o.buffer]);this._offset=0}}}return true}}registerProcessor(\x27pcm-processor\x27,PCMProcessor);";const wbUrl=URL.createObjectURL(new Blob([workletCode],{type:'application/javascript'}));try{await audioCtx.audioWorklet.addModule(wbUrl)}catch{await audioCtx.audioWorklet.addModule('/pcm-processor.js')}finally{URL.revokeObjectURL(wbUrl)}
        if(attempt!==callAttempt)return;
        audioSource=audioCtx.createMediaStreamSource(stream);
        audioNode=new AudioWorkletNode(audioCtx,'pcm-processor');
        // Connect mic source ONLY to the worklet node — never to audioCtx.destination (prevents mic-to-speaker feedback)
        audioSource.connect(audioNode);
        audioNode.port.onmessage=e=>{
          if(attempt!==callAttempt||!calling||!ws||ws.readyState!==WebSocket.OPEN||muted)return;
          if(audioCtx&&audioCtx.currentTime<playbackTime+0.25)return;
          ws.send(e.data);
        };
        s.textContent='جاري الاتصال بالمساعد...';
        const socket=new WebSocket(WS_BASE+'/agents/mizan-voice-agent/'+TENANT_SLUG+'?session_id='+SESSION_ID);
        ws=socket;
        socket.binaryType='arraybuffer';
        socket.onopen=()=>{
          if(attempt!==callAttempt){socket.close();return}
          calling=true;b.classList.remove('connecting');b.classList.add('active');ow.classList.remove('connecting');ow.classList.add('active');
          s.textContent='متصل — تحدث الآن';s.className='st';c.classList.add('visible');w.classList.remove('idle');
          startT=Date.now();timerInt=setInterval(()=>{const e=Math.floor((Date.now()-startT)/1000);document.getElementById('timer').textContent=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0')},1000);
        };
        socket.onmessage=e=>{
          if(e.data instanceof ArrayBuffer){play(e.data);return}
          try{
            const m=JSON.parse(e.data);
            if(m.type==='transcript')addTurn(m.speaker,m.text);
            if(m.type==='error'){
              console.error('Voice agent error:',m.message);
              s.textContent=m.message||'حدث خطأ في المساعد الصوتي';
              s.className='st error';
            }
            if(m.type==='status'&&m.status==='listening'){
              s.textContent='متصل — تحدث الآن';
              s.className='st';
            }
            if(m.type==='status'&&m.status==='audio_sent'){
              console.info('Agent audio received:',m.bytes,'bytes');
            }
          }catch(err){console.warn('Unrecognized voice message:',err)}
        };
        socket.onclose=()=>{if(attempt===callAttempt)endCall()};
        socket.onerror=()=>{if(attempt===callAttempt){s.textContent='خطأ في الاتصال';s.className='st error';endCall()}};
      }catch(err){
        console.error('Call initialization failed:',err);
        if(attempt===callAttempt){endCall();s.textContent=err.name==='NotAllowedError'?'لم يتم السماح باستخدام الميكروفون':err.message||'تعذر تهيئة الصوت';s.className='st error'}
      }
    }
    function endCall(){callAttempt++;calling=false;const b=document.getElementById('callBtn'),ow=document.getElementById('orbWrapper'),s=document.getElementById('status'),c=document.getElementById('callControls'),w=document.getElementById('wave');
      b.classList.remove('active','connecting');ow.classList.remove('active','connecting');s.textContent='انتهت المكالمة — جاهز لاتصال جديد';s.className='st';c.classList.remove('visible');w.classList.add('idle');
      if(timerInt){clearInterval(timerInt);timerInt=null}if(ws){const oldWs=ws;ws=null;if(oldWs.readyState===WebSocket.CONNECTING||oldWs.readyState===WebSocket.OPEN)oldWs.close()}if(audioNode){audioNode.disconnect();audioNode=null}if(audioSource){audioSource.disconnect();audioSource=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}if(audioCtx){const oldCtx=audioCtx;audioCtx=null;oldCtx.close().catch(()=>{})}}
    function toggleMute(){muted=!muted;const b=document.getElementById('muteBtn'),l=document.getElementById('muteLabel');muted?(b.classList.add('muted'),l.textContent='مكتوم'):(b.classList.remove('muted'),l.textContent='كتم')}
    function addTurn(sp,txt){const t=document.getElementById('transcript'),d=document.createElement('div');d.className='turn '+sp;
      const l=document.createElement('div');l.className='turn-label';l.textContent=sp==='caller'?'المتصل':'المساعد';
      const c=document.createElement('div');c.textContent=txt;d.appendChild(l);d.appendChild(c);t.appendChild(d);t.scrollTop=t.scrollHeight}
    async function play(blob){
      if(!audioCtx)return;
      try{
        if(audioCtx.state==='suspended')await audioCtx.resume();
        const buf=await audioCtx.decodeAudioData(blob.slice(0));
        const source=audioCtx.createBufferSource();
        source.buffer=buf;
        source.connect(audioCtx.destination);
        const startAt=Math.max(audioCtx.currentTime,playbackTime);
        source.start(startAt);
        playbackTime=startAt+buf.duration;
        const s=document.getElementById('status');
        s.textContent='المساعد بيتكلم...';
        s.className='st';
      }catch(err){
        console.error('Agent audio playback failed:',err);
        const s=document.getElementById('status');
        s.textContent='وصل الرد النصي لكن تعذر تشغيل الصوت. راجع إعدادات الصوت أو أعد المحاولة.';
        s.className='st error';
      }
    }
  </script>
</body></html>`;

  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", ...corsHeaders, ...extra },
  });
}

function shadeColor(hex: string, percent: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  const amt = Math.round(2.55 * percent);
  const r = Math.max(0, Math.min(255, (num >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((num >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (num & 0xff) + amt));
  return "#" + ((r << 16) | (g << 8) | b).toString(16).padStart(6, "0");
}

function hexToRgba(hex: string, alpha: number): string {
  const num = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(num >> 16) & 0xff}, ${(num >> 8) & 0xff}, ${num & 0xff}, ${alpha})`;
}
