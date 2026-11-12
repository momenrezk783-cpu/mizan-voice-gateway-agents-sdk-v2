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
import { resolveTenant, resolveTenantByDomain, getTenantKnowledge, invalidateTenantCache, invalidateGlobalCache, DEFAULT_MIZAN_VOICE_ID } from "./lib/tenant";
import { getSessionUser, createSessionResponse, clearSessionCookie, canAccessTenant, hashPassword, verifyPassword } from "./lib/auth";
import { encryptPII, decryptPII, redactPII } from "./lib/crypto";
import { EMBEDDED_UI_ASSETS } from "./lib/ui-assets";
import { parseSearchInput, searchClientData, searchAdminData } from "./lib/search";
import { loginRateKey, loginThrottleCheck, recordFailedLogin } from "./lib/login-throttle";
import { summarizeLatency } from "./lib/operational-metrics";
import { isRequestStatus, listTenantRequests, updateTenantRequestStatus } from "./lib/crm";
import {MIZAN_PROFILE} from "./lib/mizan-profile";
import {submitQuote,listQuotes,updateQuote} from "./lib/quote-requests";
import {readCallContact} from "./lib/private-contact";
import { processBackgroundMessage } from "./lib/background";
import { getTenantMonthlyUsage, getUtcMonthBounds } from "./lib/billing";

// Re-export the Agent class so Wrangler can find it
export { MizanVoiceAgent };
import { UUID, privateVoiceKey, reserveVoiceCall, verifyCallTicket, claimVoiceCall, releaseVoiceCall } from "./lib/voice-access";
import { InputError, readJsonBody, validateFields, text, integer, oneOf, domain, logo } from "./lib/request-validation";
import { migrateLegacyCrmContacts } from "./lib/secure-crm";

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
  MIZAN_VOICE_ID?: string;
  VOICE_WS_BASE: string;
  PRIMARY_LLM: string;
  FALLBACK_LLM: string;
  ENVIRONMENT: string;
}

interface BackgroundMessage {
  type: "record_turn" | "end_session" | "record_usage";
  eventId?: string;
  occurredAt?: number;
  tenantSlug: string;
  sessionId: string;
  speaker?: string;
  transcript?: string;
  latencyMs?: number;
  turnIndex?: number;
}

const PCM_PROCESSOR_WORKLET_JS = "// PCM Processor — AudioWorkletNode\n// Converts Float32 audio (16,000 Hz mono) to 16-bit signed little-endian PCM (linear16)\n// and batches 2048 samples (4096 bytes / 128ms) per frame to minimize WebSocket event overhead.\n// Loaded via: audioCtx.audioWorklet.addModule('/pcm-processor.js')\n\nconst CHUNK_SAMPLES = 2048;\n\nclass PCMProcessor extends AudioWorkletProcessor {\n  constructor() {\n    super();\n    this._buffer = new Int16Array(CHUNK_SAMPLES);\n    this._offset = 0;\n    this.port.onmessage = (event) => {\n      if (event.data && event.data.type === 'flush') {\n        this._flushPartial();\n      }\n    };\n  }\n\n  _flushPartial() {\n    if (this._offset > 0) {\n      const slice = this._buffer.slice(0, this._offset);\n      this.port.postMessage(slice.buffer, [slice.buffer]);\n      this._offset = 0;\n    }\n  }\n\n  process(inputs) {\n    const input = inputs[0];\n    if (input && input[0]) {\n      const float32 = input[0];\n      for (let i = 0; i < float32.length; i++) {\n        const raw = float32[i];\n        const s = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;\n        this._buffer[this._offset++] = s < 0 ? s * 0x8000 : s * 0x7FFF;\n        if (this._offset >= CHUNK_SAMPLES) {\n          const out = this._buffer.slice(0, CHUNK_SAMPLES);\n          this.port.postMessage(out.buffer, [out.buffer]);\n          this._offset = 0;\n        }\n      }\n    }\n    return true;\n  }\n}\n\nregisterProcessor('pcm-processor', PCMProcessor);\n";

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), camera=()",
  "Content-Security-Policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
};

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
    const publicMatch = url.pathname.match(/^\/c\/([\w-]+)(\/embed)?\/?$/);
    if (publicMatch) {
      return handlePublicVoicePage(request, env, publicMatch[1], Boolean(publicMatch[2]));
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
          "Cache-Control": ["/client", "/client.html", "/dashboard", "/dashboard.html", "/login", "/login.html", "/search", "/search.html"].includes(normalizedPath) ? "no-store" : "no-cache, must-revalidate",
          ...securityHeaders
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
      env.DB.prepare(`DELETE FROM quote_intake_limits WHERE reset_at < unixepoch() - 86400`).run(),
      env.DB.prepare(`DELETE FROM voice_admissions WHERE created_at < unixepoch() - 86400`).run(),
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
  const requestedSessionId = url.searchParams.get("session_id");
  if (requestedSessionId && !UUID.test(requestedSessionId)) {
    return new Response("Invalid voice session identifier", { status: 400, headers: securityHeaders });
  }
  const sessionId = requestedSessionId ?? crypto.randomUUID();

  // Validate tenant exists and is active before routing
  const tenant = await resolveTenant(slug, env);
  if (!tenant) {
    return new Response("Tenant not found or suspended", { status: 404 });
  }

  // Origin is required and bound to a single-use signed call ticket.
  const callerOrigin = request.headers.get("Origin");
  if (callerOrigin) {
    const trustedOrigins = new Set([url.origin, "https://mizanconsult.com", "https://www.mizanconsult.com"]);
    if (tenant.domain) {
      try { trustedOrigins.add(new URL(`https://${tenant.domain}`).origin); } catch { /* Invalid tenant domain is never trusted. */ }
    }
    if (!trustedOrigins.has(callerOrigin)) {
      return new Response("Untrusted voice request origin", { status: 403, headers: securityHeaders });
    }
  }

  const token = url.searchParams.get("call_token") || "";
  if (!requestedSessionId || !callerOrigin || !await verifyCallTicket(token, env.SESSION_SECRET, slug, sessionId, callerOrigin)) {
    return new Response("Invalid or expired call ticket", {status:403, headers:securityHeaders});
  }
  if (!await claimVoiceCall(env.DB, slug, sessionId)) {
    return new Response("Call ticket already used or expired", {status:409, headers:securityHeaders});
  }

  // Rewrite the URL so routeAgentRequest sees the instance name as "slug:sessionId"
  const agentUrl = new URL(request.url);
  agentUrl.searchParams.delete("call_token");
  agentUrl.pathname = `/agents/mizan-voice-agent/${slug}:${sessionId}`;

  const agentRequest = new Request(agentUrl, {
    method: request.method,
    headers: request.headers,
  });

  // routeAgentRequest handles DO instantiation + WebSocket upgrade
  // It auto-maps the MIZAN_VOICE_AGENT binding to /agents/mizan-voice-agent/{name}
  try {
    const response = await routeAgentRequest(agentRequest, env);
    if (response?.status === 101) return response;
    await releaseVoiceCall(env.DB,slug,sessionId);
    return response ?? new Response("Agent not found", {status:404});
  } catch (error) {
    await releaseVoiceCall(env.DB,slug,sessionId);
    throw error;
  }
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
    // Cookie-authenticated state changes must originate from this exact origin (CSRF defense).
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.get("Origin");
      if (origin !== url.origin) return json({ error: "Invalid request origin" }, 403);
      const size = Number(request.headers.get("Content-Length") || 0);
      if (size > 64 * 1024) return json({ error: "Request body too large" }, 413);
    }
    // Bound actual streamed bytes, including bodies without Content-Length.
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && path !== "/api/client/auth/logout") {
      const body = await readJsonBody(request);
      request = new Request(request, {body: JSON.stringify(body)});
    }
    if (path === "/api/voice/token" && request.method === "POST") {
      const body = await request.json<{slug?: unknown}>();
      if (typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(body.slug)) return json({error:"Invalid tenant"},400);
      const tenant = await resolveTenant(body.slug,env);
      if (!tenant) return json({error:"Tenant not found"},404);
      const ipKey = await privateVoiceKey(env.SESSION_SECRET,request.headers.get("CF-Connecting-IP") || "unknown");
      const ticket = await reserveVoiceCall(env.DB,tenant.slug,ipKey,tenant.max_concurrent_sessions,url.origin,env.SESSION_SECRET);
      return ticket ? json(ticket) : json({error:"Call capacity or hourly budget exceeded"},429,{"Retry-After":"60"});
    }
    if (path === "/api/public/quote-requests" && request.method === "POST") {
      return json(await submitQuote(await request.json<Record<string,unknown>>(),request.headers.get("CF-Connecting-IP") || "unknown",env),202);
    }
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
    if (err instanceof InputError) return json({error:err.message},err.status,err.status===429 ? {"Retry-After":"900"} : {});
    if (err instanceof SyntaxError) return json({ error: "Malformed JSON" }, 400);
    console.error("API error:", err);
    return json({ error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Portal Auth
// ---------------------------------------------------------------------------

async function portalLogin(request: Request, env: Env): Promise<Response> {
  const input = await request.json<{ email?: unknown; password?: unknown }>();
  if (!input || typeof input.email !== "string" || typeof input.password !== "string" ||
      input.email.length > 254 || !input.email.trim() ||
      input.password.length < 1 || input.password.length > 1024) {
    return json({ error: "Invalid login input" }, 400);
  }
  const email = input.email.trim().toLowerCase();
  const password = input.password;
  const now = Math.floor(Date.now() / 1000);
  const rateKeys = [
    { key: await loginRateKey("account", email), limit: 8 },
    { key: await loginRateKey("ip", request.headers.get("CF-Connecting-IP") || "unknown"), limit: 30 }
  ];
  const retryAfter = await loginThrottleCheck(env, rateKeys, now);
  if (retryAfter > 0) {
    return json({ error: "محاولات كثيرة. حاول لاحقاً." }, 429, { "Retry-After": String(retryAfter) });
  }

  const user = await env.DB.prepare(
    `SELECT id, tenant_slug, email, password_hash, role FROM portal_users WHERE email = ?`
  )
    .bind(email)
    .first<{ id: string; tenant_slug: string; email: string; password_hash: string; role: string }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    await recordFailedLogin(env, rateKeys, now);
    return json({ error: "بيانات الدخول غير صحيحة" }, 401);
  }
  await env.DB.prepare(`DELETE FROM auth_login_attempts WHERE attempt_key = ?`).bind(rateKeys[0].key).run();

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

  // Search is scoped exclusively to the tenant from the signed session.
  if (path === "/api/client/search" && request.method === "GET") {
    const params = parseSearchInput(url, ["all", "knowledge", "calls"]);
    if ("error" in params) return json({ error: params.error }, params.status);
    return json({ results: await searchClientData(env.DB, slug, params.q, params.scope), mode: "text" });
  }

  // Read-only usage reporting. No invoicing, charging, or payment side effects.
  if (path === "/api/client/billing/usage" && request.method === "GET") {
    const month = url.searchParams.get("month") || new Date().toISOString().slice(0,7);
    if (!getUtcMonthBounds(month)) return json({ error: "Invalid billing month" }, 400);
    const [usage, tenant] = await Promise.all([
      getTenantMonthlyUsage(env.DB, slug, month),
      env.DB.prepare(`SELECT plan_tier FROM tenants WHERE slug = ?`).bind(slug).first<{ plan_tier: string }>()
    ]);
    return json({usage, planTier: tenant?.plan_tier ?? null, note: "استهلاك تقريبي — ليست فاتورة أو مطالبة دفع"});
  }

  // CRM follow-up: only records created by this signed-in tenant's voice workflow.
  if (path === "/api/client/requests" && request.method === "GET") {
    const filter = url.searchParams.get("status");
    if (filter && !isRequestStatus(filter)) return json({ error: "Invalid request status" }, 400);
    return json({ requests: await listTenantRequests(env.DB, slug, isRequestStatus(filter) ? filter : undefined) });
  }

  const requestStatusMatch = path.match(/^\/api\/client\/requests\/([a-zA-Z0-9_-]{1,96})\/status$/);
  if (requestStatusMatch && request.method === "PATCH") {
    const body = await request.json<{ status?: unknown }>();
    if (!body || !isRequestStatus(body.status)) return json({ error: "Invalid request status" }, 400);
    const found = await updateTenantRequestStatus(env.DB, slug, requestStatusMatch[1], body.status);
    return found ? json({ ok: true }) : json({ error: "Request not found" }, 404);
  }

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

    const privateContact=await readCallContact(env.DB,slug,sessionId,env.CONTACT_ENC_KEY);
    let callerName: string|null = privateContact?.name ?? null, callerPhone: string|null = privateContact?.phone ?? null;
    if (!privateContact && session.caller_name_enc) callerName = await decryptPII(session.caller_name_enc as string, env);
    if (!privateContact && session.caller_phone_enc) callerPhone = await decryptPII(session.caller_phone_enc as string, env);

    const turns = await env.DB.prepare(
      `SELECT turn_index, speaker, transcript_redacted, latency_ms, created_at
       FROM call_turns WHERE session_id = ? AND tenant_slug = ? ORDER BY turn_index ASC`
    ).bind(sessionId, slug).all();

    return json({
      session: { id: session.id, call_status: session.call_status,
        selected_doctor: session.selected_doctor, selected_slot: session.selected_slot,
        booking_confirmed: session.booking_confirmed, started_at: session.started_at,
        ended_at: session.ended_at, caller_name: callerName, caller_phone: callerPhone, caller_email: privateContact?.email ?? null },
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
    if (typeof faq_text !== "string" || !faq_text.trim() || faq_text.length > 10000 ||
        (category !== undefined && (typeof category !== "string" || category.length > 50))) {
      return json({ error: "Invalid knowledge entry" }, 400);
    }
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
    if (typeof faq_text !== "string" || !faq_text.trim() || faq_text.length > 10000 ||
        typeof category !== "string" || category.length > 50) {
      return json({ error: "Invalid knowledge entry" }, 400);
    }
    const change = await env.DB.prepare(
      `UPDATE tenant_knowledge SET faq_text = ?, category = ?, updated_at = unixepoch()
       WHERE id = ? AND tenant_slug = ?`
    ).bind(faq_text, category, knowledgeMatch[1], slug).run();
    if (change.meta.changes < 1) return json({ error: "Knowledge entry not found" }, 404);
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true });
  }

  // GET /api/client/voice-config
  if (path === "/api/client/voice-config" && request.method === "GET") {
    const config = await env.DB.prepare(
      `SELECT system_prompt, tenant_customization, voice_id, allow_medical_advice, escalation_phone, ttl_seconds
       FROM tenant_voice_config WHERE tenant_slug = ?`
    ).bind(slug).first();
    return json({ config });
  }

  // PUT /api/client/voice-config
  if (path === "/api/client/voice-config" && request.method === "PUT") {
    const body = await request.json<{
      voice_id?: string;
      escalation_phone?: string; ttl_seconds?: number;
    }>();
    validateFields(body, {voice_id:v => typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(v),
      escalation_phone:text(40), ttl_seconds:integer(60,3600)});
    const change = await env.DB.prepare(
      `UPDATE tenant_voice_config
       SET voice_id = COALESCE(?, voice_id),
           escalation_phone = COALESCE(?, escalation_phone),
           ttl_seconds = COALESCE(?, ttl_seconds),
           updated_at = unixepoch()
       WHERE tenant_slug = ?`
    ).bind(
      body.voice_id ?? null, body.escalation_phone ?? null,
      body.ttl_seconds ?? null, slug
    ).run();
    if (change.meta.changes < 1) return json({error:"Tenant voice configuration not found"},404);
    await invalidateTenantCache(slug, null, env);
    return json({ ok: true });
  }

  // PUT /api/client/customization — tenant can ONLY edit customization + escalation
  if (path === "/api/client/customization" && request.method === "PUT") {
    const body = await request.json<{ tenant_customization?: string; escalation_phone?: string }>();
    validateFields(body,{tenant_customization:text(8000),escalation_phone:text(40)});
    if ((body.tenant_customization !== undefined && (typeof body.tenant_customization !== "string" || body.tenant_customization.length > 8000)) ||
        (body.escalation_phone !== undefined && (typeof body.escalation_phone !== "string" || body.escalation_phone.length > 40))) {
      return json({ error: "Invalid customization" }, 400);
    }
    const change = await env.DB.prepare(
      `UPDATE tenant_voice_config
       SET tenant_customization = COALESCE(?, tenant_customization),
           escalation_phone = COALESCE(?, escalation_phone),
           updated_at = unixepoch()
       WHERE tenant_slug = ?`
    ).bind(body.tenant_customization ?? null, body.escalation_phone ?? null, slug).run();
    if (change.meta.changes < 1) return json({ error: "Tenant voice configuration not found" }, 404);
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
    const recentTurnLatencies = await env.DB.prepare(
      `SELECT latency_ms FROM call_turns WHERE tenant_slug = ? AND latency_ms IS NOT NULL
       ORDER BY created_at DESC LIMIT 500`
    ).bind(slug).all<{ latency_ms: number }>();
    const p95 = summarizeLatency(recentTurnLatencies.results.map(row => row.latency_ms));
    return json({
      status: "لوحة التحكم متاحة — خدمات الصوت لم تُختبر الآن",
      knowledge_count: knowledgeCount?.count ?? 0,
      avg_latency: avgLatency?.avg != null ? Math.round(avgLatency.avg) : null,
      recent_p95_latency_ms: p95.p95,
      recent_latency_sample_count: p95.samples,
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

  if (path === "/api/admin/quote-requests" && request.method === "GET") return json({requests:await listQuotes(env,url.searchParams.get("status") || undefined)});
  const quoteMatch=path.match(/^\/api\/admin\/quote-requests\/([a-f0-9-]{36})$/u);
  if (quoteMatch && request.method === "PATCH") {
    const body=await request.json<{status?:unknown}>();
    return await updateQuote(env.DB,quoteMatch[1],body.status) ? json({ok:true}) : json({error:"Request not found"},404);
  }
  if (path === "/api/admin/search" && request.method === "GET") {
    const params = parseSearchInput(url, ["all"]);
    if ("error" in params) return json({ error: params.error }, params.status);
    return json({ results: await searchAdminData(env.DB, params.q), mode: "text" });
  }

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

    if (!body || typeof body.slug !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/u.test(body.slug) ||
        typeof body.name !== "string" || body.name.trim().length < 2 || body.name.length > 120 ||
        typeof body.system_prompt !== "string" || body.system_prompt.length > 8000 ||
        (body.industry !== undefined && (typeof body.industry !== "string" || body.industry.length > 64))) {
      return json({ error: "Invalid tenant input" }, 400);
    }
    validateFields(body, {slug:v=>typeof v === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/u.test(v), name:text(120,2),
      industry:text(64,1),domain,plan_tier:oneOf("pilot_14d","production_pbx"),max_concurrent_sessions:integer(1,100),
      theme_color:v=>typeof v === "string" && /^#[0-9a-f]{6}$/iu.test(v),logo_url:logo,system_prompt:text(8000),
      voice_id:v=>typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(v)});
    const tenantId = `c_${body.slug}`;
    // D1 batch is transactional: avoid an orphan tenant if voice config insertion fails.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO tenants (id, slug, name, industry, domain, plan_tier, max_concurrent_sessions, theme_color, logo_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
        tenantId, body.slug, body.name, body.industry ?? "general", body.domain ?? null,
        body.plan_tier ?? "pilot_14d", body.max_concurrent_sessions ?? 1,
        body.theme_color ?? "#1BA6B8", body.logo_url ?? null
      ),
      env.DB.prepare(`INSERT INTO tenant_voice_config (tenant_slug, system_prompt, tenant_customization, voice_id)
        VALUES (?, ?, ?, ?)`).bind(body.slug, body.system_prompt, body.system_prompt, body.voice_id ?? DEFAULT_MIZAN_VOICE_ID)
    ]);

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
      `SELECT (SELECT COUNT(*) FROM call_sessions WHERE tenant_slug = ?) AS calls,
              (SELECT COUNT(*) FROM call_sessions WHERE tenant_slug = ? AND booking_confirmed = 1) AS bookings,
              (SELECT AVG(latency_ms) FROM call_turns WHERE tenant_slug = ? AND latency_ms IS NOT NULL) AS avg_latency`
    ).bind(slug, slug, slug).first();

    return json({ tenant, voiceConfig, stats });
  }

  // PUT /api/admin/tenants/:slug
  if (tenantMatch && request.method === "PUT") {
    const slug = tenantMatch![1];
    const body = await request.json<{
      name?: string; domain?: string; status?: string; plan_tier?: string;
      max_concurrent_sessions?: number; theme_color?: string; logo_url?: string;
    }>();
    validateFields(body, {name:text(120,2),domain,status:oneOf("active","suspended","trial"),plan_tier:oneOf("pilot_14d","production_pbx"),
      max_concurrent_sessions:integer(1,100),theme_color:v=>typeof v === "string" && /^#[0-9a-f]{6}$/iu.test(v),logo_url:logo});
    const previous = await env.DB.prepare(`SELECT domain FROM tenants WHERE slug = ?`).bind(slug).first<{domain:string|null}>();
    if (!previous) return json({error:"Tenant not found"},404);
    const change = await env.DB.prepare(
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

    if (change.meta.changes < 1) return json({error:"Tenant not found"},404);
    await invalidateTenantCache(slug,previous.domain,env);
    const tenant = await env.DB.prepare(`SELECT domain FROM tenants WHERE slug = ?`).bind(slug).first<{ domain: string | null }>();
    await invalidateTenantCache(slug, tenant?.domain ?? null, env);
    return json({ ok: true });
  }

  // GET /api/admin/metrics — cross-tenant dashboard
  if (path === "/api/admin/metrics" && request.method === "GET") {
    const metrics = await env.DB.prepare(
      `SELECT t.slug, t.name, t.status, t.plan_tier,
              COALESCE(s.total_calls, 0) AS total_calls,
              COALESCE(s.completed, 0) AS completed,
              COALESCE(s.bookings, 0) AS bookings,
              l.avg_latency AS avg_latency
       FROM tenants t
       LEFT JOIN (SELECT tenant_slug, COUNT(*) AS total_calls,
          SUM(CASE WHEN call_status = 'completed' THEN 1 ELSE 0 END) AS completed,
          SUM(CASE WHEN booking_confirmed = 1 THEN 1 ELSE 0 END) AS bookings
          FROM call_sessions GROUP BY tenant_slug) s ON s.tenant_slug = t.slug
       LEFT JOIN (SELECT tenant_slug, AVG(latency_ms) AS avg_latency
          FROM call_turns WHERE latency_ms IS NOT NULL GROUP BY tenant_slug) l ON l.tenant_slug = t.slug
       ORDER BY total_calls DESC`
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
      status: "لوحة التحكم متاحة — خدمات الصوت لم تُختبر الآن",
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

  // PUT /api/admin/global-voice-config — voice selection only; persona is code-owned
  if (path === "/api/admin/global-voice-config" && request.method === "PUT") {
    const body = await request.json<{ system_prompt?: string; voice_id?: string }>();
    validateFields(body, {voice_id:v=>typeof v === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(v)});
    const change = await env.DB.prepare(
      `UPDATE global_voice_config
       SET voice_id = COALESCE(?, voice_id),
           updated_at = unixepoch()
       WHERE id = 1`
    ).bind(body.voice_id ?? null).run();
    if (change.meta.changes < 1) return json({error:"Global voice configuration not found"},404);
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
    validateFields(body, {guard_text:text(8000),enabled:oneOf(0,1)});
    const change = await env.DB.prepare(
      `UPDATE industry_guards
       SET guard_text = COALESCE(?, guard_text),
           enabled = COALESCE(?, enabled)
       WHERE industry = ?`
    ).bind(body.guard_text ?? null, body.enabled ?? null, industry).run();
    if (change.meta.changes < 1) return json({error:"Industry guard not found"},404);
    await env.TENANT_CONFIG.delete(`industry_guard:${industry}`);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}

// ---------------------------------------------------------------------------
// Background Queue Processor
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scheduled Tasks
// ---------------------------------------------------------------------------

async function expireStaleSessions(env: Env): Promise<void> {
  await env.DB.prepare(
    `UPDATE call_sessions
     SET call_status = 'abandoned', ended_at = unixepoch()
     WHERE call_status = 'active' AND started_at < unixepoch() - 1800
       AND NOT EXISTS (SELECT 1 FROM voice_admissions va WHERE va.session_id = call_sessions.id
         AND va.tenant_slug = call_sessions.tenant_slug AND va.state = 'connected' AND va.expires_at > unixepoch())`
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

  const accent = safeAccent(tenant.theme_color);
  const callUrl = `https://mizanconsult.com/c/${slug}`;

  const allowedOrigins=[new URL(request.url).origin];
  if(tenant.domain){try{const origin=new URL("https://"+tenant.domain);if(origin.hostname===tenant.domain)allowedOrigins.push(origin.origin);}catch{}}
  const embedPage=new URL("/c/"+slug+"/embed",request.url).href;
  const js = `(function(){
    var d=document,allowed=${JSON.stringify(allowedOrigins)},url=${JSON.stringify(embedPage)},callUrl=${JSON.stringify(callUrl)};
    if(d.querySelector('[data-mizan-widget="${slug}"]'))return;
    var launch=d.createElement('button'),panel=d.createElement('section'),close=d.createElement('button'),frame=null,fallback=d.createElement('a');
    launch.type='button';launch.textContent='تحدث مع المساعد';launch.dataset.mizanWidget='${slug}';launch.style.cssText='position:fixed;bottom:22px;left:22px;z-index:2147483000;border:0;border-radius:24px;padding:15px 20px;background:${accent};color:white;font:16px Arial;cursor:pointer';
    launch.setAttribute('aria-expanded','false');launch.setAttribute('aria-label','فتح نافذة المكالمة');
    panel.hidden=true;panel.setAttribute('aria-label','نافذة مكالمة ميزان');panel.style.cssText='position:fixed;bottom:80px;left:12px;width:min(430px,calc(100vw - 24px));height:min(720px,calc(100dvh - 100px));background:white;border:1px solid #bdd4dc;border-radius:16px;z-index:2147483001;overflow:hidden;box-shadow:0 12px 48px #0004';
    close.type='button';close.textContent='إغلاق المكالمة';close.style.cssText='height:36px;width:100%;cursor:pointer';
    fallback.href=callUrl;fallback.target='_blank';fallback.rel='noopener';fallback.textContent='فتح صفحة الاتصال المستقلة';fallback.style.cssText='display:block;text-align:center;height:30px;font:14px Arial';
    panel.append(close,fallback);d.body.append(launch,panel);
    function hide(){if(frame){frame.src='about:blank';frame.remove();frame=null}panel.hidden=true;launch.setAttribute('aria-expanded','false');launch.focus()}
    close.onclick=hide;
    launch.onclick=function(){if(!panel.hidden){hide();return}panel.hidden=false;launch.setAttribute('aria-expanded','true');if(allowed.indexOf(location.origin)<0){fallback.textContent='هذا النطاق غير مهيأ للتضمين؛ افتح صفحة الاتصال المستقلة';close.focus();return}frame=d.createElement('iframe');frame.src=url;frame.title='مكالمة المساعد الصوتي';frame.allow='microphone';frame.referrerPolicy='no-referrer';frame.style.cssText='display:block;width:100%;height:calc(100% - 66px);border:0';panel.appendChild(frame);close.focus()};
    panel.addEventListener('keydown',function(e){if(e.key==='Escape')hide()});
  })();`;


  return new Response(js, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
      ...securityHeaders
    },
  });
}

// ---------------------------------------------------------------------------
// Public Voice Page: /c/:slug
// ---------------------------------------------------------------------------

const DEFAULT_THEME = { accent: "#1BA6B8", accent2: "#2BB8C7", glow: "rgba(27, 166, 184, 0.34)" };
function safeAccent(value: string | null | undefined): string {
  return value && /^#[0-9a-fA-F]{6}$/u.test(value) ? value : DEFAULT_THEME.accent;
}
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/gu, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"}[c]!));
}
function safeLogoUrl(raw: string | null | undefined, base: string): string | null {
  if (!raw) return null;
  try { const u = new URL(raw, base); return u.protocol === "https:" ? u.toString() : null; }
  catch { return null; }
}

async function handlePublicVoicePage(request: Request, env: Env, slug: string, embedded=false): Promise<Response> {
  const tenant = await resolveTenant(slug, env);
  if (!tenant) {
    return new Response("Organization not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const wsBase = env.VOICE_WS_BASE || "wss://voice.mizanconsult.com";
  const sessionId = crypto.randomUUID();
  const accent = safeAccent(tenant.theme_color);
  const safeName = escapeHtml(tenant.name);
  const theme = {
    accent,
    accent2: shadeColor(accent, 40),
    glow: hexToRgba(accent, 0.3),
  };
  const logoUrl = safeLogoUrl(tenant.logo_url, request.url);
  const safeLogo = logoUrl ? escapeHtml(logoUrl) : null;
  const avatarContent = logoUrl
    ? `<img src="${safeLogo}" alt="${safeName}">`
    : `<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0zM19 7l-3 7a3 3 0 0 0 6 0zM8 21h8"></path></svg>`;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0B2D4B">
  <title>${safeName} — المساعد الصوتي المباشر</title>
  <meta property="og:title" content="${safeName} — مساعد صوتي">
  <meta property="og:description" content="تحدث الآن مع المساعد الصوتي لـ ${safeName}. احجز موعدك أو استفسر عن خدماتنا فوراً.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://mizanconsult.com/c/${tenant.slug}">
  <meta property="og:locale" content="ar_EG">
  <meta property="og:site_name" content="Mizan HQ">
  ${logoUrl ? `<meta property="og:image" content="${safeLogo}">` : ''}
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${safeName} — مساعد صوتي">
  <meta name="twitter:description" content="تحدث الآن مع المساعد الصوتي لـ ${safeName}.">
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
        <div class="lm" aria-hidden="true"><span style="font-size:24px">م</span></div>
        ميزان هيد كوارتر
      </a>
      <button type="button" class="mz-tour-trigger-btn" onclick="MizanOnboarding.start('call')">🎯 جولة تعريفية</button>
    </div>
    <div class="av">${avatarContent}</div>
    <h1>${safeName}</h1>
    <p class="tag">المساعد جاهز يرد على استفساراتك</p>
    <section class="privacy-disclosure" aria-label="خصوصية المكالمة"><p>${escapeHtml(MIZAN_PROFILE.privacyNotice)}</p><label><input type="checkbox" id="voice-privacy-ack"> فهمت التنبيه وأرغب في بدء المكالمة.</label><p><a href="/privacy" target="_blank" rel="noopener">سياسة الخصوصية</a> · <a href="/terms" target="_blank" rel="noopener">شروط الاستخدام</a></p></section>
    <p id="privacy-call-status" role="status" aria-live="polite"></p>
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
    <button type="button" class="mute-button" id="open-contact" hidden onclick="requestPrivateContact()">إدخال بيانات الطلب كتابة</button>
    <dialog id="private-contact" aria-labelledby="private-contact-title"><h2 id="private-contact-title">بيانات التواصل الآمنة</h2><p class="privacy-notice">الميكروفون متوقف مؤقتًا. ميزان مش هيسمعك وإنت بتملا الاستمارة.</p><form id="private-contact-form"><label>الاسم<input name="name" autocomplete="name" required minlength="2" maxlength="80"></label><label>رقم الموبايل المصري<input name="phone" type="tel" autocomplete="tel" dir="ltr" required maxlength="30"></label><label>البريد الإلكتروني (اختياري)<input name="email" type="email" autocomplete="email" dir="ltr" maxlength="254"></label><label class="privacy-confirm"><input name="confirmed" type="checkbox" required> راجعت البيانات وأؤكد استخدامها لاستكمال طلبي.</label><p>تُحفظ الحقول مشفّرة ولا تُرسل كنص إلى نموذج المحادثة أو مولّد الصوت. <a href="/privacy" target="_blank" rel="noopener">التفاصيل</a></p><p id="contact-feedback" role="status" aria-live="polite"></p><div class="privacy-actions"><button type="submit" id="contact-submit">حفظ واستكمال المكالمة</button><button type="button" id="contact-cancel">إلغاء واستكمال الاستفسارات</button></div></form></dialog>
    <div class="card" id="transcriptContainer">
      <div>اسأل عن مواعيد العمل، أو الخدمات المتاحة، أو احجز ميعاد، أو اعرف مكان الفروع.</div>
      <div class="transcript" id="transcript"></div>
    </div>
    <div class="ft">بدعم من <a href="https://mizanconsult.com">ميزان هيد كوارتر</a></div>
  </div>
  <script src="/js/onboarding.js"></script>
  <script src="/js/private-contact-ui.js"></script>
  <script>
    const TENANT_SLUG=${JSON.stringify(tenant.slug)},SESSION_ID=${JSON.stringify(sessionId)},WS_BASE=${JSON.stringify(wsBase)};
    let ws=null,audioCtx=null,stream=null,audioSource=null,audioNode=null,calling=false,muted=false,audioSink=null,timerInt=null,startT=null,callAttempt=0,playbackTime=0;
    const privateContact=MizanPrivateContact.mount({
      send:message=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message))},
      pause:()=>{if(stream)stream.getAudioTracks().forEach(track=>{track.enabled=false});if(audioSource)audioSource.disconnect();if(audioNode){audioNode.port.onmessage=null;audioNode.disconnect();audioNode=null}if(audioSink){audioSink.disconnect();audioSink=null}},
      resume:()=>{if(calling&&stream){stream.getAudioTracks().forEach(track=>{track.enabled=!muted});connectMicrophone();document.getElementById('status').textContent='متصل — تحدث الآن'}},
      isActive:()=>calling
    });
    function requestPrivateContact(){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'contact_request'}))}
    function connectMicrophone(){
      if(!audioCtx||!audioSource||privateContact.paused)return;
      const fresh=audioNode=new AudioWorkletNode(audioCtx,'pcm-processor');
      audioSource.connect(fresh);
      audioSink=audioCtx.createGain();audioSink.gain.value=0;fresh.connect(audioSink);audioSink.connect(audioCtx.destination);
      fresh.port.onmessage=e=>{if(audioNode!==fresh||privateContact.paused||!calling||!ws||ws.readyState!==WebSocket.OPEN||muted)return;if(audioCtx.currentTime<playbackTime+0.25)return;ws.send(e.data)};
    }
    async function toggleCall(){calling?endCall():startCall()}
    async function startCall(){
      if(!document.getElementById('voice-privacy-ack').checked){document.getElementById('status').textContent='اقرأ تنبيه الخصوصية وأكد الموافقة قبل تشغيل الميكروفون.';document.getElementById('voice-privacy-ack').focus();return}
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
        connectMicrophone();
        s.textContent='جاري الاتصال بالمساعد...';
        const ticketResponse=await fetch('/api/voice/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({slug:TENANT_SLUG})});
        if(!ticketResponse.ok)throw new Error(ticketResponse.status===429?'سعة المكالمات ممتلئة، حاول لاحقاً':'تعذر السماح بالمكالمة');
        const ticket=await ticketResponse.json();
        if(attempt!==callAttempt)return;
        const socket=new WebSocket(WS_BASE+'/agents/mizan-voice-agent/'+TENANT_SLUG+'?session_id='+encodeURIComponent(ticket.sessionId)+'&call_token='+encodeURIComponent(ticket.token));
        ws=socket;
        socket.binaryType='arraybuffer';
        socket.onopen=()=>{
          if(attempt!==callAttempt){socket.close();return}
          calling=true;document.getElementById('open-contact').hidden=false;b.classList.remove('connecting');b.classList.add('active');ow.classList.remove('connecting');ow.classList.add('active');
          s.textContent='متصل — تحدث الآن';s.className='st';c.classList.add('visible');w.classList.remove('idle');
          startT=Date.now();timerInt=setInterval(()=>{const e=Math.floor((Date.now()-startT)/1000);document.getElementById('timer').textContent=String(Math.floor(e/60)).padStart(2,'0')+':'+String(e%60).padStart(2,'0')},1000);
        };
        socket.onmessage=e=>{
          if(attempt!==callAttempt||!calling)return;
          if(e.data instanceof ArrayBuffer){play(e.data);return}
          try{
            const m=JSON.parse(e.data);
            if(privateContact.handle(m))return;
            if(m.type==='transcript')addTurn(m.speaker,m.text);
            if(m.type==='error'){
              console.error('Voice agent error:',m.message);
              s.textContent=m.message||'حدث خطأ في المساعد الصوتي';
              s.className='st error';
            }
            if(!privateContact.paused&&m.type==='status'&&m.status==='stt_reconnecting'){
              s.textContent='نعيد الاتصال بخدمة التعرف الصوتي...';s.className='st connecting';
            }
            if(!privateContact.paused&&m.type==='status'&&m.status==='stt_unavailable'){
              s.textContent='خدمة التعرف الصوتي غير متاحة حالياً. أنهِ الاتصال وحاول مجدداً.';s.className='st error';
            }
            if(!privateContact.paused&&m.type==='status'&&m.status==='stt_connected'){
              s.textContent='متصل — تحدث الآن';s.className='st';
            }
            if(!privateContact.paused&&m.type==='status'&&m.status==='listening'){
              s.textContent='متصل — تحدث الآن';
              s.className='st';
            }
            if(!privateContact.paused&&m.type==='status'&&m.status==='audio_sent'){
              console.info('Agent audio received:',m.bytes,'bytes');
            }
          }catch(err){console.warn('Unrecognized voice message:',err)}
        };
        socket.onclose=()=>{if(attempt===callAttempt)endCall()};
        socket.onerror=()=>{if(attempt===callAttempt)endCall('تعذر الاتصال بالخادم الصوتي. حاول مرة ثانية.')};
      }catch(err){
        console.error('Call initialization failed:',err);
        if(attempt===callAttempt){endCall();s.textContent=err.name==='NotAllowedError'?'لم يتم السماح باستخدام الميكروفون':err.message||'تعذر تهيئة الصوت';s.className='st error'}
      }
    }
    function endCall(errorText){callAttempt++;calling=false;privateContact.end();document.getElementById('open-contact').hidden=true;const b=document.getElementById('callBtn'),ow=document.getElementById('orbWrapper'),s=document.getElementById('status'),c=document.getElementById('callControls'),w=document.getElementById('wave');
      b.classList.remove('active','connecting');ow.classList.remove('active','connecting');s.textContent=errorText||'انتهت المكالمة — جاهز لاتصال جديد';s.className=errorText?'st error':'st';c.classList.remove('visible');w.classList.add('idle');playbackTime=0;muted=false;document.getElementById('muteBtn').classList.remove('muted');document.getElementById('muteLabel').textContent='كتم';
      if(timerInt){clearInterval(timerInt);timerInt=null}if(ws){const oldWs=ws;ws=null;if(oldWs.readyState===WebSocket.CONNECTING||oldWs.readyState===WebSocket.OPEN)oldWs.close()}if(audioNode){audioNode.disconnect();audioNode=null}if(audioSink){audioSink.disconnect();audioSink=null}if(audioSource){audioSource.disconnect();audioSource=null}if(stream){stream.getTracks().forEach(t=>t.stop());stream=null}if(audioCtx){const oldCtx=audioCtx;audioCtx=null;oldCtx.close().catch(()=>{})}}
    function toggleMute(){muted=!muted;if(stream)stream.getAudioTracks().forEach(track=>{track.enabled=!muted&&!privateContact.paused});const b=document.getElementById('muteBtn'),l=document.getElementById('muteLabel');muted?(b.classList.add('muted'),l.textContent='مكتوم'):(b.classList.remove('muted'),l.textContent='كتم')}
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
        s.textContent=privateContact.paused?'الميكروفون متوقف أثناء النموذج':'المساعد بيتكلم...';
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

  const headers: Record<string,string>={"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",...securityHeaders};
  if(embedded){
    delete headers["X-Frame-Options"];
    const origins=[new URL(request.url).origin];
    if(tenant.domain){try{const origin=new URL("https://"+tenant.domain);if(origin.hostname===tenant.domain)origins.push(origin.origin);}catch{}}
    headers["Content-Security-Policy"]="base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors "+origins.join(" ");
  }
  return new Response(html,{headers});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...securityHeaders, ...corsHeaders, ...extra },
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
