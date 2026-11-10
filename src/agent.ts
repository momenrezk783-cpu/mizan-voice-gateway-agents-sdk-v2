// ============================================================================
// Mizan Voice Agent — explicit WebSocket, Deepgram STT, Conversation Manager,
//                     Workers AI LLM, and ElevenLabs TTS
// ============================================================================

import { Agent, routeAgentRequest, type Connection } from "agents";
import { generateText } from "ai";
import { createAI } from "agents/models/ai-sdk";
import {
  resolveTenant,
  getGlobalVoiceConfig,
  getIndustryGuard,
  getTenantVoiceConfig,
  getTenantKnowledge,
  getHQElevenLabsConfig,
  type HQElevenLabsConfig
} from "./lib/tenant";
import {
  detectNonEgyptian,
  extractCallerTitleAndName,
  guardUnconfirmedActionClaim,
   resolvePersonAddressPolicy,
  sanitizeForSpeech,
  sanitizeForSpeechWithViolations,
  type ConversationState,
  type PersonTitleContext
} from "./lib/conversation-manager/guard";
import {
  DEFAULT_INTENTS,
  executeTool,
  getAwaitingConfirmSlots,
  getMissingRequiredSlots,
  ingestCallerUtterance,
  newSession,
  renderLiveState,
  snapshotSession,
  type CallContext,
  type CallMetrics,
  type IntentSpec,
  type Session,
  type ToolDeps
} from "./lib/conversation-manager/manager";
import {
  buildClock,
  buildManagedSystemPrompt
} from "./lib/conversation-manager/prompt";
import { evaluateCall } from "./lib/conversation-manager/evaluator";
import {
  executeTenantBusinessAction,
  fetchActiveLearnings,
  lookupCaller,
  persistCallEvaluationAndLearnings,
  updateCallSessionOutcome,
  upsertCrmContact
} from "./lib/conversation-manager/db";
import { redactPII } from "./lib/crypto";
import {
  DeepgramStreamingSession,
  computePcm16Rms,
  normalizeToLinear16Pcm,
  type DeepgramStreamConfig
} from "./lib/deepgram-stt";

export interface Env {
  DB: D1Database;
  TENANT_CONFIG: KVNamespace;
  AUDIO_BUCKET?: R2Bucket;
  AI: Ai;
  VOICE_METRICS: AnalyticsEngineDataset;
  BACKGROUND_QUEUE: Queue<BackgroundMessage>;
  SESSION_SECRET: string;
  CONTACT_ENC_KEY: string;
  ADMIN_PASSKEY_HASH: string;
  PRIMARY_LLM: string;
  FALLBACK_LLM: string;
  DEEPGRAM_API_KEY?: string;
  DEEPGRAM_MODEL?: string;
  DEEPGRAM_LANGUAGE?: string;
  ELEVENLABS_TTS_KEY?: string;
  ELEVENLABS_API_KEY?: string;
  ENVIRONMENT: string;
}

export interface BackgroundMessage {
  type: "record_turn" | "end_session" | "record_usage";
  tenantSlug: string;
  sessionId: string;
  speaker?: string;
  transcript?: string;
  latencyMs?: number;
  turnIndex?: number;
}

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_TOOL_ROUNDS = 3;

export class MizanVoiceAgent extends Agent<Env> {
  // Keep the active streaming session and conversation in memory for the lifetime
  // of this live call.
  static options = { hibernate: false };

  private tenantSlug: string | null = null;
  private sessionId: string | null = null;
  private tenantName = "ميزان";
  private tenantIndustry = "general";
  private globalPrompt = "";
  private industryGuard = "";
  private tenantCustomization = "";
  private knowledgeContext = "";
  private businessHours: string | null = null;
  private escalationPhone: string | null = null;
  private turnCount = 0;
  private callStartTime = 0;
  private initialized = false;
  private sessionClosed = false;
  private activeConnection: Connection | null = null;
  private deepgramSession: DeepgramStreamingSession | null = null;
  private clientAudioFormat: "linear16" | "float32" = "linear16";
  private conversation: ChatMessage[] = [];
  private processingTurn = false;
  private agentSpeakingUntil = 0;
  private lastProcessedTranscript = "";
  private lastProcessedAt = 0;
  private responseLanguage: "ar" | "en" = "ar";
  private elevenLabsConfig: HQElevenLabsConfig | null = null;
  private personTitleContext: PersonTitleContext = { role: "caller" };
  private deepgramConfigOverride?: DeepgramStreamConfig;

  // Guarded Conversation Manager state
  private cmSession: Session = newSession();
  private callContext: CallContext | null = null;
  private intents: IntentSpec[] = DEFAULT_INTENTS;
  private metrics: CallMetrics = {
    honorificHits: 0,
    msaHits: 0,
    llmErrors: 0,
    llmConsecutive: 0,
    slotRejections: 0,
    bargeIns: 0
  };

  async onStart() {
    this.callStartTime = Date.now();
    this.sessionClosed = false;
    const parts = this.name.split(":");
    this.tenantSlug = parts[0] || null;
    this.sessionId = parts[1] || crypto.randomUUID();

    if (!this.tenantSlug) {
      console.error("Agent started without tenant slug");
      return;
    }

    const tenant = await resolveTenant(this.tenantSlug, this.env);
    if (!tenant) {
      console.error("Tenant not found: " + this.tenantSlug);
      return;
    }

    this.tenantName = tenant.name || this.tenantSlug;
    this.tenantIndustry = tenant.industry || "general";

    const globalConfig = await getGlobalVoiceConfig(this.env);
    this.globalPrompt = globalConfig.system_prompt;
    this.elevenLabsConfig = this.tenantSlug === "mizan-hq"
      ? await getHQElevenLabsConfig(this.env)
      : {
          voice_id: globalConfig.voice_id,
          model_id: "eleven_v4_turbo",
          stability: 0.4,
          similarity_boost: 0.9,
          speed: 0.9
        };
    if (this.tenantSlug === "mizan-hq" && !this.elevenLabsConfig) {
      console.error("HQ ElevenLabs config is missing; public-page voice settings are intentionally ignored");
    }

    this.industryGuard = await getIndustryGuard(this.tenantIndustry, this.env);

    const voiceConfig = await getTenantVoiceConfig(this.tenantSlug, this.env);
    this.tenantCustomization = voiceConfig?.tenant_customization ?? "";
    this.escalationPhone = voiceConfig?.escalation_phone ?? null;

    const knowledge = await getTenantKnowledge(this.tenantSlug, this.env);
    this.businessHours = knowledge.schedules ?? knowledge.hours ?? null;
    this.knowledgeContext = Object.entries(knowledge)
      .map(([category, value]) => "[" + category + "]: " + value)
      .join("\n");

    this.cmSession = newSession();
    this.callContext = {
      callId: this.sessionId,
      tenantId: this.tenantSlug,
      direction: "inbound",
      callerPhone: null,
      callerType: "unknown",
      caller: {
        firstName: null,
        title: null,
        gender: "unknown",
        lastSummary: null,
        lastCallAt: null,
        email: null
      },
      business: {
        name: this.tenantName,
        agentName: "ميزان",
        agentGender: "male",
        hours: this.businessHours,
        knowledge: this.knowledgeContext || null,
        handoffNumber: this.escalationPhone,
        industry: this.tenantIndustry
      },
      clock: buildClock("Africa/Cairo")
    };

    await this.env.DB.prepare(
      "INSERT OR IGNORE INTO call_sessions (id, tenant_slug, direction, call_status, started_at) VALUES (?, ?, 'inbound', 'active', unixepoch())"
    ).bind(this.sessionId, this.tenantSlug).run();

    this.initialized = true;
    console.log("Voice session initialized", {
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      state: this.cmSession.state
    });
  }

  onConnect(connection: Connection) {
    if (!this.initialized) {
      connection.send(JSON.stringify({ type: "error", message: "تعذر تهيئة المساعد الصوتي." }));
      connection.close(1011, "Agent initialization failed");
      return;
    }

    const deepgramKey = (this.env.DEEPGRAM_API_KEY || "").trim();
    if (!deepgramKey) {
      console.error("DEEPGRAM_API_KEY secret is not configured on mizan-voice-gateway");
      connection.send(
        JSON.stringify({
          type: "error",
          message: "مفتاح خدمة التعرف الصوتي (DEEPGRAM_API_KEY) غير مُعد في الخادم."
        })
      );
      connection.close(1011, "Missing DEEPGRAM_API_KEY secret");
      return;
    }

    // Close any pre-existing STT session to guarantee a single active Deepgram session per call
    if (this.deepgramSession) {
      this.deepgramSession.close();
      this.deepgramSession = null;
    }

    this.sessionClosed = false;
    this.activeConnection = connection;

    this.deepgramSession = new DeepgramStreamingSession(
      deepgramKey,
      {
        onInterimTranscript: (interimText) => {
          if (this.sessionClosed || this.processingTurn) return;
          // Interim transcripts are never forwarded to the LLM conversation engine.
          // Send lightweight status indicator only.
          if (interimText) {
            try {
              connection.send(JSON.stringify({ type: "status", status: "transcribing" }));
            } catch {
              // Ignore if socket closed
            }
          }
        },
        onFinalTranscript: async (finalText, _confidence, detectedLanguage) => {
          await this.handleFinalTranscript(connection, finalText, detectedLanguage);
        },
        onError: (error) => {
          console.error("Deepgram STT stream error:", error.message);
        },
        onStatus: (status) => {
          if (this.sessionClosed) return;
          try { connection.send(JSON.stringify({ type: "status", status: `stt_${status}` })); }
          catch { /* caller disconnected */ }
        }
      },
      {
        model: this.env.DEEPGRAM_MODEL || "nova-3",
        language: this.env.DEEPGRAM_LANGUAGE || "ar-EG",
        encoding: "linear16",
        sampleRate: 16000,
        channels: 1,
        endpointingMs: 300,
        utteranceEndMs: 1000,
        ...this.deepgramConfigOverride
      }
    );

    void this.deepgramSession.connect();
    connection.send(
      JSON.stringify({
        type: "status",
        status: "ready",
        sampleRate: 16000,
        encoding: "linear16",
        format: "mp3",
        conversationState: this.cmSession.state
      })
    );
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (this.sessionClosed) return;
    if (!this.initialized || !this.tenantSlug || !this.sessionId) {
      connection.send(JSON.stringify({ type: "error", message: "المساعد الصوتي غير جاهز." }));
      return;
    }

    if (typeof message === "string") {
      let control: { type?: string; encoding?: string };
      try {
        control = JSON.parse(message) as { type?: string; encoding?: string };
      } catch {
        return;
      }

      if (control.type === "audio_format") {
        this.clientAudioFormat = control.encoding === "float32" ? "float32" : "linear16";
        return;
      }

      if (control.type === "audio_end") {
        this.deepgramSession?.finalizeUtterance();
      }
      return;
    }

    // Do not accept audio before `onConnect` initializes the Deepgram session or after close
    if (!this.deepgramSession || this.activeConnection !== connection) {
      return;
    }

    // Half-duplex echo protection: while the agent is speaking (or in the acoustic tail cooldown),
    // ignore low/moderate energy microphone frames so TTS speaker playback never loops back into STT.
    const now = Date.now();
    if (this.processingTurn || now < this.agentSpeakingUntil) {
      const pcm = normalizeToLinear16Pcm(message, this.clientAudioFormat);
      const rms = computePcm16Rms(pcm);
      // Only pass through if user is actively barging in with strong near-field speech
      if (this.processingTurn || rms < 0.08) {
        return;
      }
      // User barged in with high-energy speech: clear the TTS playback lock
      this.metrics.bargeIns++;
      this.agentSpeakingUntil = 0;
    }

    this.deepgramSession.sendAudio(message, this.clientAudioFormat);
  }

  private async handleFinalTranscript(
    connection: Connection,
    transcript: string,
    _detectedLanguage: "ar" | "en"
  ) {
    if (this.sessionClosed || !this.initialized || !this.tenantSlug || !this.sessionId) {
      return;
    }

    const cleaned = transcript.trim();
    if (!cleaned) return;

    // Prevent concurrent or duplicate back-to-back turns for the exact same utterance
    const now = Date.now();
    if (this.processingTurn) {
      return;
    }
    if (cleaned === this.lastProcessedTranscript && now - this.lastProcessedAt < 2000) {
      return;
    }

    this.processingTurn = true;
    this.lastProcessedTranscript = cleaned;
    this.lastProcessedAt = now;

    // Preserve Arabic-default response mode per Mizan Voice Gateway behavior
    this.responseLanguage = "ar";

    try {
      connection.send(JSON.stringify({ type: "transcript", speaker: "caller", text: cleaned }));
      await this.respondToTranscript(connection, cleaned);
    } catch (error) {
      console.error("Voice pipeline failed:", error);
      if (!this.sessionClosed) {
        try {
          connection.send(
            JSON.stringify({
              type: "error",
              message: "حصلت مشكلة أثناء معالجة الصوت. اتكلم مرة تانية من فضلك."
            })
          );
        } catch {
          // Client may have disconnected
        }
      }
    } finally {
      this.processingTurn = false;
      if (!this.sessionClosed) {
        try {
          connection.send(JSON.stringify({ type: "status", status: "listening" }));
        } catch {
          // Client may have disconnected
        }
      }
    }
  }

  private createToolDeps(): ToolDeps {
    if (!this.callContext) {
      this.callContext = {
        callId: this.sessionId || crypto.randomUUID(),
        tenantId: this.tenantSlug || "default",
        direction: "inbound",
        callerPhone: null,
        callerType: "unknown",
        caller: {
          firstName: this.personTitleContext.callerName ?? null,
          title: this.personTitleContext.callerTitle ?? null,
          gender: this.personTitleContext.callerGender ?? "unknown",
          lastSummary: null,
          lastCallAt: null,
          email: null
        },
        business: {
          name: this.tenantName,
          agentName: "ميزان",
          agentGender: "male",
          hours: this.businessHours,
          knowledge: this.knowledgeContext || null,
          handoffNumber: this.escalationPhone,
          industry: this.tenantIndustry
        },
        clock: buildClock("Africa/Cairo")
      };
    }

    return {
      ctx: this.callContext,
      intents: this.intents,
      runAction: (action, slots, idempotencyKey) =>
        executeTenantBusinessAction({
          db: this.env.DB,
          sessionId: this.sessionId!,
          tenantSlug: this.tenantSlug!,
          action,
          slots,
          idempotencyKey,
          contactEncKey: this.env.CONTACT_ENC_KEY
        }),
      canTransfer: () => Boolean(this.escalationPhone)
    };
  }

  private async respondToTranscript(connection: Connection, transcript: string) {
    if (this.sessionClosed || !this.tenantSlug || !this.sessionId) return;
    const turnStart = Date.now();
    this.turnCount++;

    const callerIdentity = extractCallerTitleAndName(transcript, this.personTitleContext);
    this.personTitleContext = {
      role: "caller",
      callerName: callerIdentity.name,
      callerTitle: callerIdentity.title,
      callerGender: callerIdentity.gender
    };

    const toolDeps = this.createToolDeps();
    toolDeps.ctx.clock = buildClock("Africa/Cairo");
    if (callerIdentity.name) toolDeps.ctx.caller.firstName = callerIdentity.name;
    if (callerIdentity.title) toolDeps.ctx.caller.title = callerIdentity.title;
    if (callerIdentity.gender !== "unknown") toolDeps.ctx.caller.gender = callerIdentity.gender;

    // 1. Run Conversation Manager turn ingestion (state transitions, slot validation, confirmation guards, actions)
    const { outcomes } = await ingestCallerUtterance(
      toolDeps,
      this.cmSession,
      transcript,
      callerIdentity.name
    );
    for (const outcome of outcomes) {
      if (outcome.rejected) {
        this.metrics.slotRejections += outcome.rejected;
      }
    }

    // 2. If a valid phone number was collected, check CRM contacts to enrich returning customer context
    const collectedPhone = this.cmSession.slots.phone?.value ?? null;
    if (collectedPhone && toolDeps.ctx.callerPhone !== collectedPhone) {
      toolDeps.ctx.callerPhone = collectedPhone;
      const crmMatch = await lookupCaller(this.env.DB, this.tenantSlug, collectedPhone);
      if (crmMatch) {
        toolDeps.ctx.callerType = crmMatch.callerType;
        toolDeps.ctx.caller.lastSummary = crmMatch.crm.last_call_summary;
        toolDeps.ctx.caller.lastCallAt = crmMatch.crm.last_call_at;
        if (!toolDeps.ctx.caller.firstName && crmMatch.crm.name) {
          toolDeps.ctx.caller.firstName = crmMatch.crm.name;
          this.personTitleContext.callerName = crmMatch.crm.name;
        }
        if (toolDeps.ctx.caller.gender === "unknown" && crmMatch.crm.gender !== "unknown") {
          toolDeps.ctx.caller.gender = crmMatch.crm.gender;
          this.personTitleContext.callerGender = crmMatch.crm.gender;
        }
      } else {
        toolDeps.ctx.callerType = "new_lead";
      }
    }

    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "caller",
      transcript: redactPII(transcript),
      turnIndex: this.turnCount
    });

    let reply = "";

    // 3. Hard emergency override (REG-06): immediate ambulance 123 directive without asking for booking slots
    if (this.cmSession.emergencyDetected) {
      const escalationHint = this.escalationPhone ? ` أو تواصل فوراً مع طوارئ المكان على ${this.escalationPhone}` : "";
      reply = `سلامتك، الأعراض دي محتاجة تدخل طبي فوري. من فضلك اتصل بالإسعاف حالاً على رقم 123 أو توجه لأقرب مستشفى طوارئ${escalationHint}.`;
    } else {
      const activeLearnings = await fetchActiveLearnings(this.env.DB, this.tenantSlug, 6);
      const liveState = renderLiveState(this.cmSession, toolDeps.ctx, this.intents);
      const systemPrompt = buildManagedSystemPrompt({
        globalPrompt: this.globalPrompt,
        industryGuard: this.industryGuard,
        tenantCustomization: this.tenantCustomization,
        escalationPhone: this.escalationPhone,
        ctx: toolDeps.ctx,
        personContext: this.personTitleContext,
        learnings: activeLearnings,
        liveState,
        language: this.responseLanguage
      });

      const recentMessages = this.conversation.slice(-10);

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        try {
          const ai = createAI({ binding: this.env.AI });
          const result = await generateText({
            model: ai(this.env.PRIMARY_LLM),
            system: systemPrompt,
            messages: [...recentMessages, { role: "user", content: transcript }],
            temperature: 0,
            maxOutputTokens: 220
          });
          reply = result.text.trim();
          this.metrics.llmConsecutive = 0;
        } catch (primaryError) {
          console.error("Primary LLM failed:", primaryError);
          try {
            const ai = createAI({ binding: this.env.AI });
            const result = await generateText({
              model: ai(this.env.FALLBACK_LLM),
              system: systemPrompt,
              messages: [...recentMessages, { role: "user", content: transcript }],
              temperature: 0.4,
              maxOutputTokens: 220
            });
            reply = result.text.trim();
            this.metrics.llmConsecutive = 0;
          } catch (fallbackError) {
            console.error("Fallback LLM failed:", fallbackError);
            this.metrics.llmErrors++;
            this.metrics.llmConsecutive++;
            reply =
              this.responseLanguage === "en"
                ? "Sorry, I'm having a temporary technical issue. Could you please try again?"
                : "عذراً، حصلت مشكلة تقنية مؤقتة. ممكن تحاول تاني؟";
          }
        }

        // Support optional structured `<tool_call>{"name":...,"input":...}</tool_call>` blocks if emitted by the model
        const toolMatch = reply.match(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/u);
        if (!toolMatch) break;

        reply = reply.replace(toolMatch[0], "").trim();
        try {
          const parsedTool = JSON.parse(toolMatch[1]) as {
            name?: string;
            input?: Record<string, unknown>;
          };
          if (parsedTool.name) {
            const outcome = await executeTool(
              toolDeps,
              this.cmSession,
              parsedTool.name,
              parsedTool.input ?? {}
            );
            if (outcome.rejected) this.metrics.slotRejections += outcome.rejected;
          }
        } catch {
          // Malformed tool block ignored safely
        }
        if (reply) break;
      }
    }

    if (!reply) {
      reply =
        this.responseLanguage === "en"
          ? "Could you please clarify what you need?"
          : "ممكن توضح لي طلبك أكتر؟";
    }

    // 4. Deterministic output guard: strip banned honorifics, track violations, and block false action claims
    const sanitized = sanitizeForSpeechWithViolations(reply, this.personTitleContext);
    this.metrics.honorificHits += sanitized.violations.length;
    const msaViolations = detectNonEgyptian(sanitized.text);
    this.metrics.msaHits += msaViolations.length;

    const currentIntentSpec = this.intents.find((i) => i.id === this.cmSession.intent) ?? null;
    const missingLabels = currentIntentSpec
      ? getMissingRequiredSlots(this.cmSession, currentIntentSpec).map((s) => s.label)
      : [];
    const awaitingLabels = currentIntentSpec
      ? getAwaitingConfirmSlots(this.cmSession, currentIntentSpec).map((s) => s.label)
      : [];

    const actionGuarded = guardUnconfirmedActionClaim(sanitized.text, {
      actionConfirmed: Boolean(this.cmSession.actionResult?.ok),
      hasValidPhone: Boolean(this.cmSession.slots.phone?.value),
      awaitingConfirmationLabels: awaitingLabels,
      missingSlotLabels: missingLabels
    });

    reply = sanitizeForSpeech(actionGuarded.text, this.personTitleContext);
    if (!reply) reply = "ممكن توضح لي طلبك أكتر؟";

    this.conversation.push({ role: "user", content: transcript }, { role: "assistant", content: reply });
    if (this.conversation.length > 20) this.conversation = this.conversation.slice(-20);

    const latency = Date.now() - turnStart;
    this.turnCount++;

    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "agent",
      transcript: redactPII(reply),
      latencyMs: latency,
      turnIndex: this.turnCount
    });

    this.env.VOICE_METRICS?.writeDataPoint({
      blobs: [this.tenantSlug, this.sessionId],
      doubles: [latency],
      indexes: [this.tenantSlug]
    });

    if (this.sessionClosed) return;

    connection.send(JSON.stringify({ type: "transcript", speaker: "agent", text: reply }));
    connection.send(
      JSON.stringify({
        type: "conversation_state",
        ...snapshotSession(this.cmSession, this.intents),
        actionResult: this.cmSession.actionResult
      })
    );
    connection.send(JSON.stringify({ type: "status", status: "speaking" }));

    try {
      const audio = await this.synthesizeElevenLabsAudio(reply);
      if (this.sessionClosed) return;
      // Estimate MP3 playback duration at 128 kbps (16,000 bytes/sec) + 350ms acoustic echo tail
      const estimatedDurationMs = Math.max(600, Math.round((audio.byteLength / 16000) * 1000) + 350);
      this.agentSpeakingUntil = Date.now() + estimatedDurationMs;
      connection.send(audio);
      connection.send(JSON.stringify({ type: "status", status: "audio_sent", bytes: audio.byteLength }));
    } catch (ttsError) {
      console.error("ElevenLabs TTS failed:", ttsError);
      if (!this.sessionClosed) {
        connection.send(JSON.stringify({ type: "error", message: "تعذر تشغيل صوت ميزان من إعدادات HQ." }));
      }
    }

    if (this.cmSession.state === "ENDED" && !this.sessionClosed) {
      try {
        connection.send(
          JSON.stringify({
            type: "control",
            command: this.cmSession.handoff ? "transfer" : "end_call",
            reason: this.cmSession.handoff?.reason ?? this.cmSession.endRequest?.reason ?? "agent_end"
          })
        );
      } catch {
        // Ignore if client already closed
      }
    }
  }

  private async synthesizeElevenLabsAudio(text: string): Promise<ArrayBuffer> {
    const apiKey = (this.env.ELEVENLABS_TTS_KEY || this.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) throw new Error("ELEVENLABS_TTS_KEY secret is not configured");
    const config = this.elevenLabsConfig;
    if (!config?.voice_id) throw new Error("HQ ElevenLabs voice config is unavailable");

    const endpoint = new URL("https://api.elevenlabs.io/v1/text-to-speech/" + encodeURIComponent(config.voice_id));
    endpoint.searchParams.set("output_format", "mp3_44100_128");
    let lastError = "ElevenLabs request failed";

    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let response: Response;
      try {
        response = await fetch(endpoint.toString(), {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            text,
            model_id: config.model_id,
            language_code: this.responseLanguage === "en" ? "en" : "ar",
            voice_settings: {
              stability: config.stability,
              similarity_boost: config.similarity_boost,
              speed: config.speed,
              use_speaker_boost: true
            }
          }),
          signal: controller.signal
        });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt === 3) throw new Error("ElevenLabs network/timeout error: " + lastError);
        await new Promise((resolve) => setTimeout(resolve, attempt * 300));
        continue;
      } finally {
        clearTimeout(timeout);
      }

      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType && !contentType.startsWith("audio/") && !contentType.includes("octet-stream")) {
          throw new Error("ElevenLabs returned unexpected content type: " + contentType);
        }
        const audio = await response.arrayBuffer();
        if (audio.byteLength < 100) throw new Error("ElevenLabs returned empty or incomplete MP3 audio");
        return audio;
      }

      const errorBody = (await response.text()).slice(0, 300);
      lastError = "ElevenLabs HTTP " + response.status + ": " + errorBody;
      const retryable = response.status === 429 || response.status === 500 ||
        response.status === 502 || response.status === 503 || response.status === 504;
      if (!retryable || attempt === 3) throw new Error(lastError);
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const delayMs = retryAfter > 0
        ? Math.min(3000, Math.max(250, retryAfter * 1000))
        : attempt * 400;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(lastError);
  }

  private buildSystemPrompt(language: "ar" | "en"): string {
    const toolDeps = this.createToolDeps();
    const liveState = renderLiveState(this.cmSession, toolDeps.ctx, this.intents);
    return buildManagedSystemPrompt({
      globalPrompt: this.globalPrompt,
      industryGuard: this.industryGuard,
      tenantCustomization: this.tenantCustomization,
      escalationPhone: this.escalationPhone,
      ctx: toolDeps.ctx,
      personContext: this.personTitleContext,
      learnings: [],
      liveState,
      language
    });
  }

  async onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean) {
    if (this.sessionClosed) return;
    this.sessionClosed = true;
    this.activeConnection = null;

    if (this.deepgramSession) {
      this.deepgramSession.close();
      this.deepgramSession = null;
    }

    if (!this.tenantSlug || !this.sessionId) return;

    await this.env.BACKGROUND_QUEUE.send({
      type: "end_session",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId
    });
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_usage",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId
    });

    if (this.conversation.some((turn) => turn.role === "assistant")) {
      const confirmedPhone = this.cmSession.slots.phone?.value ?? "";
      const outcome: ConversationState["outcome"] = this.cmSession.handoff
        ? "handoff"
        : this.cmSession.actionResult?.ok || this.cmSession.endRequest
          ? "completed"
          : "caller_hung_up";

      const evalState: ConversationState = {
        callId: this.sessionId,
        tenantId: this.tenantSlug,
        caller: {
          phone: confirmedPhone,
          name:
            this.cmSession.slots.name?.value ??
            this.personTitleContext.callerName ??
            undefined,
          title: this.personTitleContext.callerTitle ?? undefined,
          gender: this.personTitleContext.callerGender ?? "unknown",
          isReturning: this.callContext?.callerType === "returning_customer"
        },
        transcript: this.conversation.map((turn, idx) => ({
          idx,
          role: turn.role,
          content: redactPII(turn.content)
            .replace(/\b\d{14}\b/gu, "[رقم قومي]")
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]"),
          ts: this.callStartTime + idx * 1000
        })),
        outcome,
        intentId: this.cmSession.intent,
        intentResolved: Boolean(this.cmSession.actionResult?.ok),
        handedOff: Boolean(this.cmSession.handoff),
        honorificHits: this.metrics.honorificHits,
        msaHits: this.metrics.msaHits,
        llmErrors: this.metrics.llmErrors
      };

      try {
        const evaluation = await evaluateCall(this.env.AI, this.env.PRIMARY_LLM, evalState);
        await persistCallEvaluationAndLearnings(
          this.env.DB,
          this.sessionId,
          this.tenantSlug,
          evaluation
        );
        await updateCallSessionOutcome(this.env.DB, this.sessionId, this.tenantSlug, {
          intentId: this.cmSession.intent,
          intentResolved: Boolean(this.cmSession.actionResult?.ok),
          handedOff: Boolean(this.cmSession.handoff),
          endReason:
            this.cmSession.handoff?.reason ??
            this.cmSession.endRequest?.reason ??
            outcome,
          totalTurns: this.cmSession.totalTurns,
          honorificHits: this.metrics.honorificHits,
          msaHits: this.metrics.msaHits,
          llmErrors: this.metrics.llmErrors,
          evaluationScore: evaluation.score_overall,
          summaryAr: evaluation.call_summary_ar ?? null
        });
        if (confirmedPhone) {
          await upsertCrmContact(this.env.DB, this.tenantSlug, confirmedPhone, {
            title: this.personTitleContext.callerTitle,
            name:
              evaluation.inferred_caller_first_name ??
              this.cmSession.slots.name?.value ??
              this.personTitleContext.callerName ??
              null,
            gender:
              evaluation.inferred_caller_gender ??
              this.personTitleContext.callerGender ??
              "unknown",
            email: this.cmSession.slots.email?.value ?? null,
            lastSummary: evaluation.call_summary_ar ?? null,
            lastCallAt: Math.floor(Date.now() / 1000)
          });
        }
        console.info("Conversation evaluation saved", {
          sessionId: this.sessionId,
          state: this.cmSession.state,
          intent: this.cmSession.intent,
          score: evaluation.score_overall,
          learningCount: evaluation.candidate_learnings.length
        });
      } catch (error) {
        console.error("Conversation learning persistence failed:", error);
      }
    }
  }
}

export { routeAgentRequest };
