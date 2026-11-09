// ============================================================================
// Mizan Voice Agent — explicit WebSocket, Deepgram STT, LLM and ElevenLabs TTS
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
  extractCallerTitleAndName,
  resolvePersonAddressPolicy,
  sanitizeForSpeech,
  type ConversationState,
  type PersonTitleContext
} from "./lib/conversation-manager/guard";
import { evaluateCall } from "./lib/conversation-manager/evaluator";
import {
  fetchActiveLearnings,
  persistCallEvaluationAndLearnings
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
  AUDIO_BUCKET: R2Bucket;
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

export class MizanVoiceAgent extends Agent<Env> {
  // Keep the active streaming session and conversation in memory for the lifetime
  // of this live call.
  static options = { hibernate: false };

  private tenantSlug: string | null = null;
  private sessionId: string | null = null;
  private globalPrompt = "";
  private industryGuard = "";
  private tenantCustomization = "";
  private knowledgeContext = "";
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

    this.industryGuard = await getIndustryGuard(tenant.industry || "general", this.env);

    const voiceConfig = await getTenantVoiceConfig(this.tenantSlug, this.env);
    this.tenantCustomization = voiceConfig?.tenant_customization ?? "";
    this.escalationPhone = voiceConfig?.escalation_phone ?? null;

    const knowledge = await getTenantKnowledge(this.tenantSlug, this.env);
    this.knowledgeContext = Object.entries(knowledge)
      .map(([category, value]) => "[" + category + "]: " + value)
      .join("\n");

    await this.env.DB.prepare(
      "INSERT INTO call_sessions (id, tenant_slug, direction, call_status, started_at) VALUES (?, ?, 'inbound', 'active', unixepoch())"
    ).bind(this.sessionId, this.tenantSlug).run();

    this.initialized = true;
    console.log("Voice session initialized", { tenantSlug: this.tenantSlug, sessionId: this.sessionId });
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
        format: "mp3"
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

    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "caller",
      transcript: redactPII(transcript),
      turnIndex: this.turnCount,
    });

    const activeLearnings = await fetchActiveLearnings(this.env.DB, this.tenantSlug, 6);
    const addressPolicy = resolvePersonAddressPolicy(this.personTitleContext);
    const learningBlock = activeLearnings.length
      ? "\n\n--- قواعد تعلمها المحرك من المكالمات الناجحة ---\n" + activeLearnings.map((rule) => "- " + rule).join("\n")
      : "";
    const personBlock = "\n\n--- مخاطبة المتصل ---\n" +
      "صيغة المخاطبة المناسبة: " + addressPolicy.preferredAddress + ". " +
      "ممنوع استخدام حضرتك أو يا فندم أو تخمين لقب مهني غير معلن.";
    const systemPrompt = this.buildSystemPrompt(this.responseLanguage) + personBlock + learningBlock;
    const recentMessages = this.conversation.slice(-10);
    let reply = "";

    try {
      const ai = createAI({ binding: this.env.AI });
      const result = await generateText({
        model: ai(this.env.PRIMARY_LLM),
        system: systemPrompt,
        messages: [...recentMessages, { role: "user", content: transcript }],
        temperature: 0,
        maxOutputTokens: 220,
      });
      reply = result.text.trim();
    } catch (primaryError) {
      console.error("Primary LLM failed:", primaryError);
      try {
        const ai = createAI({ binding: this.env.AI });
        const result = await generateText({
          model: ai(this.env.FALLBACK_LLM),
          system: systemPrompt,
          messages: [...recentMessages, { role: "user", content: transcript }],
          temperature: 0.4,
          maxOutputTokens: 220,
        });
        reply = result.text.trim();
      } catch (fallbackError) {
        console.error("Fallback LLM failed:", fallbackError);
        reply =
          this.responseLanguage === "en"
            ? "Sorry, I'm having a temporary technical issue. Could you please try again?"
            : "عذراً، حصلت مشكلة تقنية مؤقتة. ممكن تحاول تاني؟";
      }
    }

    if (!reply) {
      reply =
        this.responseLanguage === "en"
          ? "Could you please clarify what you need?"
          : "ممكن توضح لي طلبك أكتر؟";
    }
    reply = sanitizeForSpeech(reply, this.personTitleContext);
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
      turnIndex: this.turnCount,
    });

    this.env.VOICE_METRICS?.writeDataPoint({
      blobs: [this.tenantSlug, this.sessionId],
      doubles: [latency],
      indexes: [this.tenantSlug],
    });

    if (this.sessionClosed) return;

    connection.send(JSON.stringify({ type: "transcript", speaker: "agent", text: reply }));
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
    let prompt = this.globalPrompt;
    if (this.industryGuard) prompt += "\n\n--- قواعد الأمان ---\n" + this.industryGuard;
    if (this.tenantCustomization) prompt += "\n\n--- تعليمات خاصة ---\n" + this.tenantCustomization;
    if (this.knowledgeContext) prompt += "\n\n--- معلومات النشاط ---\n" + this.knowledgeContext;
    if (this.escalationPhone) prompt += "\n\nرقم التحويل/الطوارئ: " + this.escalationPhone;

    if (language === "en") {
      prompt +=
        "\n\n--- Response language (highest priority) ---\n" +
        "The caller is speaking English. Reply in clear, natural English only. " +
        "Do not switch to Arabic or mix languages unless the caller switches to Arabic. " +
        "Keep the response concise, friendly, and professional.";
    } else {
      prompt +=
        "\n\n--- لغة الرد (أولوية قصوى) ---\n" +
        "تحدث باللهجة المصرية فقط بأسلوب ودود ومهني وموجز. " +
        "إذا انتقل المتصل إلى الإنجليزية، اتبع لغته في الرد.";
    }
    return prompt;
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
      sessionId: this.sessionId,
    });
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_usage",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
    });

    if (this.conversation.some((turn) => turn.role === "assistant")) {
      const evalState: ConversationState = {
        callId: this.sessionId,
        tenantId: this.tenantSlug,
        caller: {
          phone: "",
          name: this.personTitleContext.callerName ?? undefined,
          title: this.personTitleContext.callerTitle ?? undefined,
          gender: this.personTitleContext.callerGender ?? "unknown",
          isReturning: false
        },
        transcript: this.conversation.map((turn, idx) => ({
          idx,
          role: turn.role,
          content: redactPII(turn.content)
            .replace(/\b\d{14}\b/gu, "[رقم قومي]")
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]"),
          ts: this.callStartTime + idx * 1000
        })),
        outcome: "caller_hung_up"
      };
      try {
        const evaluation = await evaluateCall(this.env.AI, this.env.PRIMARY_LLM, evalState);
        await persistCallEvaluationAndLearnings(
          this.env.DB,
          this.sessionId,
          this.tenantSlug,
          evaluation
        );
        console.info("Conversation evaluation saved", {
          sessionId: this.sessionId,
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