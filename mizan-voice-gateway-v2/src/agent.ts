// ============================================================================
// Mizan Voice Agent — Cloudflare Agents SDK with withVoice
// ============================================================================
// This replaces the entire manual DO + WebSocket + STT/TTS pipeline from v1.
// The Agents SDK handles:
//   - WebSocket connection lifecycle (Hibernation API — DOs sleep when idle)
//   - Audio streaming (binary PCM frames from browser)
//   - STT (Deepgram Flux on Workers AI — no API key needed)
//   - Turn detection (model-driven — no client end-of-speech signaling)
//   - TTS (Workers AI — no API key needed)
//   - Conversation history persistence (SQLite-backed DO)
//   - Reconnection (clients can resume mid-stream)
//
// The ONLY method we write is onTurn() — called when the patient finishes
// speaking. We load tenant config, call the LLM, guard medical advice,
// record the turn to D1, and return the reply text for TTS.
//
// Per-tenant isolation: Agent instance name = "tenantSlug:sessionId"
// Each call gets its own isolated Agent with its own conversation state.
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
import { resolveTenant, getTenantVoiceConfig, getTenantKnowledge } from "./lib/tenant";
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

// Create the voice-enabled Agent class
const VoiceAgent = withVoice(Agent);

export class MizanVoiceAgent extends VoiceAgent<Env> {
  // Workers AI powers STT and TTS — no external API keys required
  // Deepgram Flux: model-driven turn detection, ultra-low latency
  // Aura-1: natural multilingual TTS
  transcriber = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);

  // Cached tenant config (loaded once per Agent instance)
  private tenantSlug: string | null = null;
  private sessionId: string | null = null;
  private systemPrompt: string = "";
  private knowledgeContext: string = "";
  private allowMedicalAdvice = false;
  private escalationPhone: string | null = null;
  private turnCount = 0;
  private callStartTime = 0;
  private initialized = false;

  // -------------------------------------------------------------------------
  // Called when a WebSocket client connects — initialize tenant context
  // -------------------------------------------------------------------------

  async onStart() {
    this.callStartTime = Date.now();

    // Parse tenant slug and session ID from instance name: "al-nour:uuid-1234"
    const parts = this.name.split(":");
    this.tenantSlug = parts[0] ?? null;
    this.sessionId = parts[1] ?? crypto.randomUUID();

    if (!this.tenantSlug) {
      console.error("Agent started without tenant slug");
      return;
    }

    // Load tenant config from KV cache (fast) or D1 (source of truth)
    const tenant = await resolveTenant(this.tenantSlug, this.env);
    if (!tenant) {
      console.error(`Tenant not found: ${this.tenantSlug}`);
      return;
    }

    const voiceConfig = await getTenantVoiceConfig(this.tenantSlug, this.env);
    if (!voiceConfig) {
      console.error(`Voice config not found for tenant: ${this.tenantSlug}`);
      return;
    }

    // Load FAQ knowledge for this tenant
    const knowledge = await getTenantKnowledge(this.tenantSlug, this.env);

    // Initialize session state
    this.systemPrompt = voiceConfig.system_prompt;
    this.allowMedicalAdvice = voiceConfig.allow_medical_advice === 1;
    this.escalationPhone = voiceConfig.escalation_phone;

    // Build knowledge context from FAQ entries
    this.knowledgeContext = Object.entries(knowledge)
      .map(([cat, text]) => `[${cat}]: ${text}`)
      .join("\n");

    // Create call session record in D1
    await this.env.DB.prepare(
      `INSERT INTO call_sessions (id, tenant_slug, direction, call_status, started_at)
       VALUES (?, ?, 'inbound', 'active', unixepoch())`
    )
      .bind(this.sessionId, this.tenantSlug)
      .run();

    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // THE CORE METHOD — called each time the patient finishes speaking
  // -------------------------------------------------------------------------

  async onTurn(transcript: string, context: VoiceTurnContext): Promise<string> {
    if (!this.initialized || !this.tenantSlug || !this.sessionId) {
      return "عذراً، حدث خطأ في تهيئة المكالمة. يرجى المحاولة مرة أخرى.";
    }

    const turnStart = Date.now();
    this.turnCount++;

    // Record caller turn to D1 (PII redacted) via queue (non-blocking)
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "caller",
      transcript: redactPII(transcript),
      turnIndex: this.turnCount,
    });

    // Build the full system prompt with live FAQ context + safety rules
    const fullPrompt = this.buildSystemPrompt();

    // Call LLM via Workers AI (PhoneLLM Mini — optimized for voice agents)
    let reply: string;
    try {
      const ai = createAI({ binding: this.env.AI });
      const result = await generateText({
        model: ai(this.env.PRIMARY_LLM),
        messages: [
          { role: "system", content: fullPrompt },
          ...context.messages.slice(-10), // Last 10 turns for context window
          { role: "user", content: transcript },
        ],
        temperature: 0,
        maxTokens: 200,
      });
      reply = result.text;
    } catch (err) {
      console.error("Primary LLM failed, using fallback:", err);
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

    // Safety: block medical advice if tenant policy disallows it
    if (!this.allowMedicalAdvice) {
      reply = this.guardMedicalAdvice(reply);
    }

    this.turnCount++;

    // Record agent turn to D1 (PII redacted) via queue
    const latency = Date.now() - turnStart;
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "agent",
      transcript: redactPII(reply),
      latencyMs: latency,
      turnIndex: this.turnCount,
    });

    // Report per-tenant latency metric
    this.env.VOICE_METRICS.writeDataPoint({
      blobs: [this.tenantSlug, this.sessionId],
      doubles: [latency],
      indexes: [this.tenantSlug],
    });

    return reply;
  }

  // -------------------------------------------------------------------------
  // Called when the WebSocket connection closes — finalize session
  // -------------------------------------------------------------------------

  async onClose() {
    if (!this.tenantSlug || !this.sessionId) return;

    const duration = Math.floor((Date.now() - this.callStartTime) / 1000);

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
  // System prompt builder — injects tenant personality + FAQ + safety rules
  // -------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    let prompt = this.systemPrompt;

    // Inject live FAQ/knowledge context
    if (this.knowledgeContext) {
      prompt += `\n\n--- معلومات العيادة الحالية ---\n${this.knowledgeContext}`;
    }

    // Medical advice guard (Egyptian healthcare compliance)
    if (!this.allowMedicalAdvice) {
      prompt += `\n\n--- قواعد الأمان ---\n`;
      prompt += `لا تقم بتقديم أي تشخيص طبي أو نصائح علاجية أو جرعات دوائية. `;
      prompt += `وجه المتصل لزيارة الطبيب أو الاتصال بالعيادة مباشرة. `;
      prompt += `أنت مساعد حجز ومعلومات فقط، وليس طبيباً.`;
    }

    // Escalation number
    if (this.escalationPhone) {
      prompt += `\n\nرقم الطوارئ/التحويل: ${this.escalationPhone}`;
    }

    // Language directive
    prompt += `\n\nتحدث باللهجة المصرية بأسلوب ودود ومهني. كن موجزاً في إجاباتك.`;

    return prompt;
  }

  // -------------------------------------------------------------------------
  // Medical advice guard — append disclaimer if diagnostic keywords detected
  // -------------------------------------------------------------------------

  private guardMedicalAdvice(text: string): string {
    const diagnosticPatterns = /يشخص|علاج|دواء|جرعة|تشخيص|أعراض تدل|وصفة|مضاد حيوي/i;
    if (diagnosticPatterns.test(text)) {
      return text + "\n\nملاحظة: هذه معلومات عامة وليست بديلاً عن استشارة الطبيب.";
    }
    return text;
  }
}

// ---------------------------------------------------------------------------
// Export the Agent for the Worker entry point
// ---------------------------------------------------------------------------

export { routeAgentRequest };
