// ============================================================================
// Mizan Voice Agent — Cloudflare Agents SDK with withVoice
// ============================================================================
// System Prompt = 4 layers (locked → additive):
//   1. Global Mizan Identity    — super_admin only, LOCKED
//   2. Industry Guard           — super_admin only, LOCKED
//   3. Tenant Customization     — tenant can ADD (cannot remove core)
//   4. Tenant Knowledge (FAQ)   — tenant can edit
// ============================================================================

import { Agent, routeAgentRequest } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
} from "agents/voice";
import { generateText } from "ai";
import { createAI } from "agents/models/ai-sdk";
import {
  resolveTenant,
  getGlobalVoiceConfig,
  getIndustryGuard,
  getTenantVoiceConfig,
  getTenantKnowledge,
} from "./lib/tenant";
import { redactPII } from "./lib/crypto";

interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  AUDIO_BUCKET: R2Bucket;
  AI: Ai;
  VOICE_METRICS: AnalyticsEngineDataset;
  BACKGROUND_QUEUE: Queue<BackgroundMessage>;
  SESSION_SECRET: string;
  CONTACT_ENC_KEY: string;
  ADMIN_PASSKEY_HASH: string;
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

const VoiceAgent = withVoice(Agent);

export class MizanVoiceAgent extends VoiceAgent<Env> {
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  // Session state
  private tenantSlug: string | null = null;
  private sessionId: string | null = null;
  private globalPrompt: string = "";
  private industryGuard: string = "";
  private tenantCustomization: string = "";
  private knowledgeContext: string = "";
  private escalationPhone: string | null = null;
  private turnCount = 0;
  private callStartTime = 0;
  private initialized = false;

  async onStart() {
    this.callStartTime = Date.now();

    const parts = this.name.split(":");
    this.tenantSlug = parts[0] ?? null;
    this.sessionId = parts[1] ?? crypto.randomUUID();

    if (!this.tenantSlug) {
      console.error("Agent started without tenant slug");
      return;
    }

    // 1. Load tenant (includes industry)
    const tenant = await resolveTenant(this.tenantSlug, this.env);
    if (!tenant) {
      console.error(`Tenant not found: ${this.tenantSlug}`);
      return;
    }

    // 2. Load GLOBAL Mizan identity (LOCKED — super_admin only)
    const globalConfig = await getGlobalVoiceConfig(this.env);
    this.globalPrompt = globalConfig.system_prompt;

    // 3. Load industry guard (LOCKED — super_admin only)
    this.industryGuard = await getIndustryGuard(tenant.industry, this.env);

    // 4. Load tenant customization (ADDITIVE — tenant can edit)
    const voiceConfig = await getTenantVoiceConfig(this.tenantSlug, this.env);
    this.tenantCustomization = voiceConfig?.tenant_customization ?? "";
    this.escalationPhone = voiceConfig?.escalation_phone ?? null;

    // 5. Load tenant knowledge (FAQ — tenant can edit)
    const knowledge = await getTenantKnowledge(this.tenantSlug, this.env);
    this.knowledgeContext = Object.entries(knowledge)
      .map(([cat, text]) => `[${cat}]: ${text}`)
      .join("\n");

    // 6. Create call session record
    await this.env.DB.prepare(
      `INSERT INTO call_sessions (id, tenant_slug, direction, call_status, started_at)
       VALUES (?, ?, 'inbound', 'active', unixepoch())`
    )
      .bind(this.sessionId, this.tenantSlug)
      .run();

    this.initialized = true;
  }

  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    if (!this.initialized || !this.tenantSlug || !this.sessionId) {
      return "عذراً، حدث خطأ في تهيئة المكالمة. يرجى المحاولة مرة أخرى.";
    }

    const turnStart = Date.now();
    this.turnCount++;

    // Record caller turn (non-blocking via queue)
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "caller",
      transcript: redactPII(transcript),
      turnIndex: this.turnCount,
    });

    // Build the full system prompt (4 layers)
    const fullPrompt = this.buildSystemPrompt();

    // Call LLM
    let reply: string;
    try {
      const ai = createAI({ binding: this.env.AI });
      const result = await generateText({
        model: ai(this.env.PRIMARY_LLM),
        messages: [
          { role: "system", content: fullPrompt },
          ...context.messages.slice(-10),
          { role: "user", content: transcript },
        ],
        temperature: 0,
        maxTokens: 200,
      });
      reply = result.text;
    } catch (err) {
      console.error("Primary LLM failed:", err);
      try {
        const ai = createAI({ binding: this.env.AI });
        const result = await generateText({
          model: ai(this.env.FALLBACK_LLM),
          messages: [
            { role: "system", content: fullPrompt },
            ...context.messages.slice(-10),
            { role: "user", content: transcript },
          ],
          temperature: 0.7,
          maxTokens: 200,
        });
        reply = result.text;
      } catch {
        reply = "عذراً، حدث خطأ تقني. يرجى المحاولة مرة أخرى.";
      }
    }

    this.turnCount++;
    const latency = Date.now() - turnStart;

    // Record agent turn (non-blocking)
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "agent",
      transcript: redactPII(reply),
      latencyMs: latency,
      turnIndex: this.turnCount,
    });

    // Per-tenant latency metric
    this.env.VOICE_METRICS.writeDataPoint({
      blobs: [this.tenantSlug, this.sessionId],
      doubles: [latency],
      indexes: [this.tenantSlug],
    });

    return reply;
  }

  async onClose() {
    if (!this.tenantSlug || !this.sessionId) return;

    await this.env.BACKGROUND_QUEUE.send({
      type: "end_session",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
    });
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_usage",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
    });
  }

  // -------------------------------------------------------------------------
  // System Prompt Builder — 4 layers (locked → additive)
  // -------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    // Layer 1: Global Mizan Identity (LOCKED)
    let prompt = this.globalPrompt;

    // Layer 2: Industry Guard (LOCKED)
    if (this.industryGuard) {
      prompt += `\n\n--- قواعد الأمان ---\n${this.industryGuard}`;
    }

    // Layer 3: Tenant Customization (ADDITIVE — tenant adds, cannot remove)
    if (this.tenantCustomization) {
      prompt += `\n\n--- تعليمات خاصة ---\n${this.tenantCustomization}`;
    }

    // Layer 4: Tenant Knowledge (FAQ — tenant can edit)
    if (this.knowledgeContext) {
      prompt += `\n\n--- معلومات النشاط ---\n${this.knowledgeContext}`;
    }

    // Escalation
    if (this.escalationPhone) {
      prompt += `\n\nرقم التحويل/الطوارئ: ${this.escalationPhone}`;
    }

    // Language directive (LOCKED)
    prompt += `\n\nتحدث باللهجة المصرية بأسلوب ودود ومهني. كن موجزاً.`;

    return prompt;
  }
}

export { routeAgentRequest };
