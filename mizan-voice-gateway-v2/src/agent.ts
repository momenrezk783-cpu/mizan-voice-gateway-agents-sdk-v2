// ============================================================================
// Mizan Voice Agent — explicit WebSocket, STT, LLM and TTS pipeline
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
  ELEVENLABS_TTS_KEY?: string;
  ELEVENLABS_API_KEY?: string;
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

type ChatMessage = { role: "user" | "assistant"; content: string };

type AITranscription = {
  text?: string;
  language?: string;
  transcription_info?: { language?: string; language_probability?: number };
};
export class MizanVoiceAgent extends Agent<Env> {
  // Keep the active audio buffer and conversation in memory for the lifetime
  // of this live call. The browser sends utterance boundaries as audio_end.
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
  private audioChunks: Float32Array[] = [];
  private audioSampleCount = 0;
  private conversation: ChatMessage[] = [];
  private processingAudio = false;
  private responseLanguage: "ar" | "en" = "ar";
  private elevenLabsConfig: HQElevenLabsConfig | null = null;
  private personTitleContext: PersonTitleContext = { role: "caller" };

  async onStart() {
    this.callStartTime = Date.now();
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
    connection.send(JSON.stringify({ type: "status", status: "ready", sampleRate: 16000, format: "mp3" }));
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (!this.initialized || !this.tenantSlug || !this.sessionId) {
      connection.send(JSON.stringify({ type: "error", message: "المساعد الصوتي غير جاهز." }));
      return;
    }

    if (typeof message === "string") {
      let control: { type?: string };
      try {
        control = JSON.parse(message) as { type?: string };
      } catch {
        return;
      }
      if (control.type === "audio_end") {
        await this.flushAudio(connection);
      }
      return;
    }

    const samples = this.toFloat32(message);
    if (!samples.length) return;

    this.audioChunks.push(samples);
    this.audioSampleCount += samples.length;

    // Flush long utterances periodically even if the browser has not emitted
    // an end-of-utterance marker (for example, continuous speech).
    if (this.audioSampleCount >= 16000 * 10) {
      await this.flushAudio(connection);
    }
  }

  private toFloat32(message: ArrayBuffer | ArrayBufferView): Float32Array {
    let bytes: Uint8Array;
    if (message instanceof ArrayBuffer) {
      bytes = new Uint8Array(message);
    } else {
      bytes = new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
    }
    const usableBytes = bytes.byteLength - (bytes.byteLength % 4);
    if (usableBytes === 0) return new Float32Array(0);
    const copy = bytes.slice(0, usableBytes);
    const values = new Float32Array(copy.buffer);
    // Clamp and reject invalid samples before they reach the ASR model.
    const clean = new Float32Array(values.length);
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      clean[i] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
    }
    return clean;
  }

  private async flushAudio(connection: Connection) {
    if (this.processingAudio || this.audioSampleCount < 1600) return;
    this.processingAudio = true;

    const chunks = this.audioChunks;
    this.audioChunks = [];
    this.audioSampleCount = 0;

    try {
      const samples = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        samples.set(chunk, offset);
        offset += chunk.length;
      }

      const wav = this.encodeWav(samples, 16000);
      const audioBase64 = this.toBase64(wav);
      connection.send(JSON.stringify({ type: "status", status: "transcribing" }));

      const transcription = await this.env.AI.run(
        "@cf/openai/whisper-large-v3-turbo",
        {
          audio: audioBase64,
          task: "transcribe",
          language: "ar",
          vad_filter: false,
          initial_prompt: "الكلام باللهجة المصرية العامية. اكتب الكلام المنطوق بالعربية فقط، مع الحفاظ على أسماء الأشخاص والشركات كما نُطقت."
        }
      ) as AITranscription;

      // Arabic-only mode: never auto-detect or switch the conversation to another language.
      this.responseLanguage = "ar";

      const transcript = (transcription?.text || "").trim();
      if (!transcript) {
        connection.send(JSON.stringify({ type: "status", status: "listening" }));
        return;
      }

      connection.send(JSON.stringify({ type: "transcript", speaker: "caller", text: transcript }));
      await this.respondToTranscript(connection, transcript);
    } catch (error) {
      console.error("Voice pipeline failed:", error);
      connection.send(JSON.stringify({ type: "error", message: "حصلت مشكلة أثناء معالجة الصوت. اتكلم مرة تانية من فضلك." }));
    } finally {
      this.processingAudio = false;
      if (this.audioSampleCount >= 1600) {
        await this.flushAudio(connection);
      } else {
        try {
          connection.send(JSON.stringify({ type: "status", status: "listening" }));
        } catch {
          // The client may have disconnected while the model was running.
        }
      }
    }
  }

  private async respondToTranscript(connection: Connection, transcript: string) {
    if (!this.tenantSlug || !this.sessionId) return;
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
      ? "\\n\\n--- قواعد تعلمها المحرك من المكالمات الناجحة ---\\n" + activeLearnings.map((rule) => "- " + rule).join("\\n")
      : "";
    const personBlock = "\\n\\n--- مخاطبة المتصل ---\\n" +
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

    connection.send(JSON.stringify({ type: "transcript", speaker: "agent", text: reply }));
    connection.send(JSON.stringify({ type: "status", status: "speaking" }));

    try {
      const audio = await this.synthesizeElevenLabsAudio(reply);
      connection.send(audio);
      connection.send(JSON.stringify({ type: "status", status: "audio_sent", bytes: audio.byteLength }));
    } catch (ttsError) {
      console.error("ElevenLabs TTS failed:", ttsError);
      connection.send(JSON.stringify({ type: "error", message: "تعذر تشغيل صوت ميزان من إعدادات HQ." }));
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

  private encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
    const bytesPerSample = 2;
    const dataLength = samples.length * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    const writeText = (position: number, value: string) => {
      for (let i = 0; i < value.length; i++) view.setUint8(position + i, value.charCodeAt(i));
    };

    writeText(0, "RIFF");
    view.setUint32(4, 36 + dataLength, true);
    writeText(8, "WAVE");
    writeText(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * bytesPerSample, true);
    view.setUint16(32, bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeText(36, "data");
    view.setUint32(40, dataLength, true);

    let position = 44;
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(position, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      position += 2;
    }
    return buffer;
  }

  private toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
    }
    return btoa(binary);
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
          content: turn.content,
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
