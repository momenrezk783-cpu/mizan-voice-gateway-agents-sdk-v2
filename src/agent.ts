// ============================================================================
// Mizan Voice Agent — explicit WebSocket, Deepgram STT, Conversation Manager,
//                     Workers AI LLM, and ElevenLabs TTS
// ============================================================================

import { Agent, routeAgentRequest, type Connection } from "agents";
import { generateText } from "ai";
import {calendarBooking,captureKnowledgeGap} from "./lib/operations";
import { VoiceTrace, generationUsage, type TracingEnv } from "./lib/tracing";
import { synthesizeSpeech } from "./lib/tts/index";
import { libraryClipForSpeech } from "./lib/clips/index";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import {
  resolveTenant,
  getGlobalVoiceConfig,
  getTenantVoiceConfig,
  getTenantKnowledge,
  getIndustryGuard,
  getHQElevenLabsConfig,
  type HQElevenLabsConfig
} from "./lib/tenant";
import {
  detectNonEgyptian,
  extractCallerTitleAndName,
  guardUnconfirmedActionClaim,
  guardUnconfirmedBookingClaim,
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
  autoAdvance,
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
  lookupCaller,
  persistCallEvaluationAndLearnings,
  updateCallSessionOutcome,
  upsertCrmContact
} from "./lib/conversation-manager/db";
import { MAX_CALL_SECONDS, releaseVoiceCall } from "./lib/voice-access";
import {MIZAN_PROFILE,MIZAN_HQ_FACTS} from "./lib/mizan-profile";
import {validatePrivateContact,saveCallContact,maskContactText,type PrivateContact} from "./lib/private-contact";
import { redactPII } from "./lib/crypto";
import {
  DeepgramStreamingSession,
  computePcm16Rms,
  normalizeToLinear16Pcm,
  type DeepgramStreamConfig
} from "./lib/deepgram-stt";

export interface Env extends TracingEnv {
  INTEGRATION_ALLOWED_HOSTS?:string;
  ASSETS?: Fetcher;
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
  GOOGLE_TTS_API_KEY?: string;
  GOOGLE_TTS_VOICE?: string;
  TTS_PROVIDER?: string;
  TTS_FALLBACK_PROVIDER?: string;
  MIZAN_VOICE_ID?: string;
  ENVIRONMENT: string;
}

export interface BackgroundMessage {
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

type ChatMessage = { role: "user" | "assistant"; content: string };

const MAX_TOOL_ROUNDS = 3;

export class MizanVoiceAgent extends Agent<Env> {
  // Current Agents SDK uses a keepAlive ref for live in-memory work; the old
  // `hibernate: false` option is no longer part of AgentStaticOptions.
  static options = { sendIdentityOnConnect: false };
  private releaseCallKeepAlive: (() => void) | null = null;

  private tenantSlug: string | null = null;
  private sessionId: string | null = null;
  private tenantName = "ميزان";
  private tenantIndustry = "general";
  private knowledgeContext = "";
  private businessHours: string | null = null;
  private escalationPhone: string | null = null;
  private industryGuard = "";
  private tenantCustomization = "";
  private callDeadline = 0;
  private callTimer: ReturnType<typeof setTimeout> | null = null;
  private privateContact: PrivateContact | null = null;
  private spokenNames: string[] = [];
  private contactPaused = false;
  private contactPending: {id:string;expires:number;intent:string|null;phase:"editing"|"saving"|"saved"|"resuming"} | null = null;
  private contactDeclined = false;
  private turnCount = 0;
  private callStartTime = 0;
  private initialized = false;
  private aiPaused=false;
  private hadHumanHandoff=false;
  private operationsRevision=0;
  private operationsEpoch=0;
  private handoffHoldRevision:number|null=null;
  private operationsTimer:ReturnType<typeof setInterval>|null=null;
  private sessionClosed = false;
  private activeConnection: Connection | null = null;
  private deepgramSession: DeepgramStreamingSession | null = null;
  private clientAudioFormat: "linear16" | "float32" = "linear16";
  private conversation: ChatMessage[] = [];
  private processingTurn = false;
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

    this.tenantName = this.tenantSlug === "mizan-hq" ? MIZAN_PROFILE.status : tenant.name || this.tenantSlug;
    this.tenantIndustry = tenant.industry || "general";
    this.intents=structuredClone(DEFAULT_INTENTS);
    const calendar=await this.env.DB.prepare("SELECT provider FROM calendar_integrations WHERE tenant_slug=? AND enabled=1").bind(this.tenantSlug).first<{provider:string}>();
    if(calendar?.provider==='calcom')for(const intent of this.intents)if(intent.action==='book_appointment'){
      const email=intent.slots.find(slot=>slot.name==='email');if(email){email.required=true;email.label='attendee email (private form)';}
    }

    const globalConfig = await getGlobalVoiceConfig(this.env);
    this.industryGuard = await getIndustryGuard(this.tenantIndustry,this.env);
    this.elevenLabsConfig = this.tenantSlug === "mizan-hq"
      ? await getHQElevenLabsConfig(this.env)
      : {
          voice_id: globalConfig.voice_id,
          model_id: "eleven_v4_turbo",
          stability: 0.5,
          similarity_boost: 0.75,
          speed: 1.0
        };
    if (this.tenantSlug === "mizan-hq" && !this.elevenLabsConfig) {
      console.error("HQ ElevenLabs config is missing; public-page voice settings are intentionally ignored");
    }


    const voiceConfig = await getTenantVoiceConfig(this.tenantSlug, this.env);
    this.escalationPhone = voiceConfig?.escalation_phone ?? null;
    this.tenantCustomization = this.tenantSlug === "mizan-hq" ? "" : voiceConfig?.tenant_customization ?? "";
    if (this.tenantSlug !== "mizan-hq" && this.elevenLabsConfig && voiceConfig?.voice_id && /^[A-Za-z0-9_-]{8,128}$/u.test(voiceConfig.voice_id)) {
      this.elevenLabsConfig.voice_id = voiceConfig.voice_id;
    }

    const knowledge = await getTenantKnowledge(this.tenantSlug, this.env);
    this.businessHours = knowledge.schedules ?? knowledge.hours ?? null;
    this.knowledgeContext = this.tenantSlug === "mizan-hq" ? MIZAN_HQ_FACTS : Object.entries(knowledge)
      .map(([category, value]) => "[" + category + "]: " + value)
      .join("\n");
    if(this.tenantSlug === "mizan-hq") this.businessHours=null;

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

  async onConnect(connection: Connection) {
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

    if (this.activeConnection || this.sessionClosed) {
      connection.close(1008,"Call already connected or ended");
      return;
    }
    const admission = await this.env.DB.prepare(`SELECT expires_at FROM voice_admissions
      WHERE session_id = ? AND tenant_slug = ? AND state = 'connected'`).bind(this.sessionId,this.tenantSlug).first<{expires_at:number}>();
    if (!admission || admission.expires_at * 1000 <= Date.now()) {
      connection.close(1008,"Call reservation expired");
      return;
    }
    this.callDeadline = admission.expires_at * 1000;
    this.callTimer = setTimeout(() => {
      connection.close(1000,"Maximum call duration reached");
      void this.onClose(connection,1000,"Maximum call duration reached",true);
    }, Math.min(MAX_CALL_SECONDS * 1000,this.callDeadline - Date.now()));

    // Close any pre-existing STT session to guarantee a single active Deepgram session per call
    if (this.deepgramSession) {
      this.deepgramSession.close();
      this.deepgramSession = null;
    }

    this.sessionClosed = false;
    this.activeConnection = connection;
    this.releaseCallKeepAlive?.();
    this.releaseCallKeepAlive = await this.keepAlive();

    await this.syncOperations(connection);
    if(this.sessionClosed)return;
    if(!this.aiPaused)this.startStt(connection);
    this.operationsTimer=setInterval(()=>{void this.syncOperations(connection).catch(()=>{
      this.aiPaused=true;this.deepgramSession?.close();this.deepgramSession=null;
      connection.send(JSON.stringify({type:'handoff',status:'human_required',auto_dial:false}));
    });},2000);
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

  private startStt(connection: Connection) {
    this.deepgramSession?.close();
    const session = new DeepgramStreamingSession(
      (this.env.DEEPGRAM_API_KEY || "").trim(),
      {
        onInterimTranscript: (interimText) => {
          if (this.sessionClosed || this.contactPaused || this.aiPaused || this.processingTurn || this.deepgramSession !== session) return;
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
        onSpeechStarted: () => {
          if(this.sessionClosed || this.contactPaused || this.aiPaused || this.deepgramSession !== session)return;
          // Raw VAD may be loudspeaker echo. Interruption requires the caller's explicit browser control; never cut TTS on SpeechStarted alone.
        },
        onFinalTranscript: async (finalText, _confidence, detectedLanguage) => {
          if (this.deepgramSession === session && !this.contactPaused && !this.aiPaused) await this.handleFinalTranscript(connection, finalText, detectedLanguage);
        },
        onError: (error) => {
          console.error("Deepgram STT stream error");
        },
        onStatus: (status) => {
          if (this.sessionClosed || this.deepgramSession !== session) return;
          if (status === "connected" && this.contactPending?.phase === "resuming") {
            const id=this.contactPending.id; this.contactPending=null; this.contactPaused=false;
            connection.send(JSON.stringify({type:"contact_resumed",requestId:id}));
            return;
          }
          try { connection.send(JSON.stringify({ type: "status", status: `stt_${status}` })); }
          catch { /* caller disconnected */ }
        }
      },
      {
        model: this.env.DEEPGRAM_MODEL || "nova-3",
        encoding: "linear16",
        sampleRate: 16000,
        channels: 1,
        endpointingMs: 300,
        utteranceEndMs: 1000,
        ...this.deepgramConfigOverride,
        language: "ar"
      }
    );

    this.deepgramSession = session;
    void session.connect();
  }

  private protect(text:string):string {
    // These are approved public business contacts, not caller-provided secrets.
    const publicContacts=this.tenantSlug === "mizan-hq" ? [MIZAN_PROFILE.email,MIZAN_PROFILE.phone,MIZAN_PROFILE.phoneDisplay] : [];
    let safe=text;
    publicContacts.forEach((value,index)=>{safe=safe.split(value).join(`PUBLICCONTACTTOKEN${index}END`)});
    safe=maskContactText(safe,this.privateContact ?? {},this.spokenNames);
    publicContacts.forEach((value,index)=>{safe=safe.split(`PUBLICCONTACTTOKEN${index}END`).join(value)});
    return safe;
  }

  private noteSpokenName(text:string) {
    const name=extractCallerTitleAndName(text,{},false).name;
    if(name && !this.spokenNames.includes(name)) {this.spokenNames.push(name);if(this.spokenNames.length>32)this.spokenNames.shift();}
  }

  private requestContact(connection:Connection) {
    if(this.contactPending || this.sessionClosed) return;
    const spec=this.intents.find(i=>i.id===this.cmSession.intent);
    if(!spec?.action || this.cmSession.actionResult?.ok) return;
    this.contactPending={id:crypto.randomUUID(),expires:Date.now()+300000,intent:this.cmSession.intent,phase:"editing"};
    this.contactPaused=true;
    this.deepgramSession?.close(); this.deepgramSession=null;
    connection.send(JSON.stringify({type:"contact_required",requestId:this.contactPending.id,fields:["name","phone",...(spec.slots.some(s=>s.name==="email")?["email"]:[])],requiredFields:spec.slots.filter(s=>s.required).map(s=>s.name)}));
  }

  private async handleContactControl(connection:Connection,control:Record<string,unknown>) {
    if(control.type==="contact_request") { this.contactDeclined=false; this.requestContact(connection); return; }
    const pending=this.contactPending;
    if(!pending || control.requestId!==pending.id || pending.intent!==this.cmSession.intent) return;
    if(control.type==="contact_resume" && pending.phase==="saved") {
      pending.phase="resuming"; if(!this.aiPaused)this.startStt(connection); return;
    }
    if(control.type==="contact_cancel" && pending.phase==="editing") {
      pending.phase="saved"; this.contactDeclined=true;
      connection.send(JSON.stringify({type:"contact_result",requestId:pending.id,ok:true,cancelled:true})); return;
    }
    if(control.type!=="contact_submit" || pending.phase!=="editing") return;
    if(Date.now()>pending.expires || control.confirmed!==true) {
      connection.send(JSON.stringify({type:"contact_result",requestId:pending.id,ok:false,message:"راجع تأكيد البيانات أو ألغِ النموذج لطلب نموذج جديد."})); return;
    }
    pending.phase="saving";
    try {
      const contact=validatePrivateContact(control.contact);
      if(this.intents.find(i=>i.id===pending.intent)?.slots.some(s=>s.name==='email'&&s.required) && !contact.email)throw new Error('Attendee email required');
      await saveCallContact(this.env.DB,this.tenantSlug!,this.sessionId!,contact,this.env.CONTACT_ENC_KEY);
      if(this.sessionClosed || this.contactPending!==pending) return;
      this.privateContact=contact;
      for(const field of ["name","phone","email"] as const) {
        if(contact[field]) this.cmSession.slots[field]={value:contact[field]!,confirmed:true,source:"caller",setAtTurn:this.cmSession.totalTurns};
        else delete this.cmSession.slots[field];
      }
      this.contactDeclined=false; autoAdvance(this.cmSession,this.intents);
      pending.phase="saved";
      // Remove earlier incidental contact occurrences before any later provider request.
      this.conversation=this.conversation.map(turn=>({...turn,content:this.protect(turn.content)}));
      connection.send(JSON.stringify({type:"contact_result",requestId:pending.id,ok:true}));
    } catch {
      pending.phase="editing";
      connection.send(JSON.stringify({type:"contact_result",requestId:pending.id,ok:false,message:"تعذر حفظ البيانات. راجع الاسم ورقم الموبايل والبريد ثم حاول مجددًا، أو ألغِ النموذج."}));
    }
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer | ArrayBufferView) {
    if (this.sessionClosed || this.activeConnection !== connection) return;
    if (this.callDeadline && Date.now() >= this.callDeadline) {
      connection.close(1000,"Maximum call duration reached");
      await this.onClose(connection,1000,"Maximum call duration reached",true);
      return;
    }
    if (!this.initialized || !this.tenantSlug || !this.sessionId) {
      connection.send(JSON.stringify({ type: "error", message: "المساعد الصوتي غير جاهز." }));
      return;
    }

    if (typeof message === "string") {
      if(message.length>4096) { connection.close(1009,"Control message too large"); return; }
      let control: Record<string,unknown>;
      try {
        control = JSON.parse(message) as { type?: string; encoding?: string };
      } catch {
        return;
      }

      if (String(control.type).startsWith("contact_")) { await this.handleContactControl(connection,control); return; }
      if (this.contactPaused || this.aiPaused) return;
      if (control.type === "audio_format") {
        this.clientAudioFormat = control.encoding === "float32" ? "float32" : "linear16";
        return;
      }

      if (control.type === "audio_end") {
        this.deepgramSession?.finalizeUtterance();
      }
      return;
    }

    if (this.contactPaused || this.aiPaused) return;
    // Do not accept audio before `onConnect` initializes the Deepgram session or after close
    if (!this.deepgramSession || this.activeConnection !== connection) {
      return;
    }

    this.deepgramSession.sendAudio(message, this.clientAudioFormat);
  }

  private async handleFinalTranscript(
    connection: Connection,
    transcript: string,
    _detectedLanguage: "ar" | "en"
  ) {
    if (this.sessionClosed || this.contactPaused || !this.initialized || !this.tenantSlug || !this.sessionId) {
      return;
    }

    this.noteSpokenName(transcript);
    if(this.activeConnection){await this.syncOperations(connection);if(this.aiPaused)return;}
    const cleaned = this.protect(transcript.trim());
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

    const voiceTrace = VoiceTrace.start(this.env, this.sessionId || "unknown", this.tenantSlug || "unknown");
    try {
      connection.send(JSON.stringify({ type: "transcript", speaker: "caller", text: cleaned }));
      await this.respondToTranscript(connection, cleaned, voiceTrace);
    } catch (error) {
      voiceTrace.fail();
      console.error("Voice pipeline failed");
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
      await voiceTrace.finish();
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
      secureContact:true,
      ctx: this.callContext,
      intents: this.intents,
      runAction: async (action, slots, idempotencyKey) => {
        if(this.activeConnection)await this.syncOperations(this.activeConnection);
        if(this.aiPaused || this.sessionClosed)return {ok:false,detail:'Session paused or ended'};
        if (!this.privateContact) return Promise.resolve({ok:false,detail:"Complete the private on-screen contact form before executing this request."});
        const privateSlots={...slots,...this.privateContact};
        const calendar=action==='book_appointment' ? await calendarBooking(this.env,this.tenantSlug!,this.sessionId!,idempotencyKey,privateSlots) : null;
        if(calendar && !calendar.ok)return calendar;
        return executeTenantBusinessAction({
          db: this.env.DB,
          sessionId: this.sessionId!,
          tenantSlug: this.tenantSlug!,
          action,
          slots: privateSlots,
          verifiedCalendarBooking:calendar?.ok===true,
          idempotencyKey,
          contactEncKey: this.env.CONTACT_ENC_KEY
        });
      },
      canTransfer: () => Boolean(this.escalationPhone)
    };
  }

  private async respondToTranscript(connection: Connection, transcript: string, voiceTrace: VoiceTrace = VoiceTrace.start({}, "test", "test")) {
    if (this.sessionClosed || !this.tenantSlug || !this.sessionId) return;
    const turnStart = Date.now();
    const operationsEpoch=this.operationsEpoch;
    this.turnCount++;

    this.noteSpokenName(transcript);
    transcript=this.protect(transcript);
    const toolDeps = this.createToolDeps();
    toolDeps.ctx.clock = buildClock("Africa/Cairo");
    // 1. Run Conversation Manager turn ingestion (state transitions, slot validation, confirmation guards, actions)
    const { outcomes } = await voiceTrace.step("manage-conversation", "tool", () => ingestCallerUtterance(
      toolDeps,
      this.cmSession,
      transcript,
      null
    ));
    for (const outcome of outcomes) {
      if (outcome.rejected) {
        this.metrics.slotRejections += outcome.rejected;
      }
    }

    // A supplied phone is not identity verification: never load another caller's history.
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_turn",
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId,
      speaker: "caller",
      transcript: redactPII(transcript),
      turnIndex: this.turnCount
    });

    const actionSpec=this.intents.find(i=>i.id===this.cmSession.intent);
    const needsContact=Boolean(actionSpec?.action && !this.privateContact && !this.cmSession.emergencyDetected && !this.cmSession.endRequest && !this.cmSession.handoff);
    let reply = "";

    // 3. Hard emergency override (REG-06): immediate ambulance 123 directive without asking for booking slots
    if (this.cmSession.emergencyDetected) {
      const escalationHint = this.escalationPhone ? ` أو تواصل فوراً مع طوارئ المكان على ${this.escalationPhone}` : "";
      reply = `سلامتك، الأعراض دي محتاجة تدخل طبي فوري. من فضلك اتصل بالإسعاف حالاً على رقم 123 أو توجه لأقرب مستشفى طوارئ${escalationHint}.`;
    } else if(this.tenantSlug === "mizan-hq" && /(?:السعر|أسعار|اسعار|التكلفة|تكلفه|بكام|كام الاشتراك|التسعير|pricing|price)/iu.test(transcript)) {
      reply="عرض السعر مجاني، والسعر بيتحدد حسب احتياجات منشأتك والتخصيص والتكاملات والدعم. ابعت طلبك من قسم التواصل في mizanconsult.com أو راسل info@mizanconsult.com؛ هنراجع الطلب ونرد في أسرع وقت ممكن، من غير التزام بالتعاقد بمجرد الطلب.";
    } else if(needsContact) {
      if (!this.contactDeclined) this.requestContact(connection);
      reply=this.contactDeclined ? "نقدر نكمل الاستفسارات، لكن تنفيذ الطلب محتاج بيانات من النموذج الآمن. تقدر تفتحه من زر إدخال البيانات كتابة." : "لاستكمال طلبك، اكتب بيانات التواصل في الاستمارة اللي ظهرت. الميكروفون متوقف مؤقتًا؛ ميزان مش هيسمعك وإنت بتملا الاستمارة. بعد الإرسال وكملان الاتصال، قولّي نكمل الطلب.";
    } else {
      const buildPrompt = () => this.buildSystemPrompt(this.responseLanguage);

      // Preserve early identity, rejected examples and follow-up context for the
      // active call instead of silently dropping everything before five exchanges.
      const messages: ChatMessage[] = [...this.conversation, { role: "user", content: transcript }];

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        const systemPrompt = buildPrompt();
        try {
          const ai = createAI({ binding: this.env.AI });
          const result = await voiceTrace.step("generate-response", "generation", () => generateText({
            model: ai(this.env.PRIMARY_LLM as CloudflareLanguageModelId),
            system: systemPrompt,
            messages,
            temperature: 0
          }), {"langfuse.observation.model.name":this.env.PRIMARY_LLM}, generationUsage);
          reply = result.text.trim();
          console.info("LLM response metadata", { model: this.env.PRIMARY_LLM, finishReason: result.finishReason,
            inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
          this.metrics.llmConsecutive = 0;
        } catch (primaryError) {
          console.error("Primary LLM failed");
          try {
            const ai = createAI({ binding: this.env.AI });
            const result = await voiceTrace.step("generate-fallback-response", "generation", () => generateText({
              model: ai(this.env.FALLBACK_LLM as CloudflareLanguageModelId),
              system: systemPrompt,
              messages,
              temperature: 0.4
            }), {"langfuse.observation.model.name":this.env.FALLBACK_LLM}, generationUsage);
            reply = result.text.trim();
            console.info("LLM response metadata", { model: this.env.FALLBACK_LLM, finishReason: result.finishReason,
              inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
            this.metrics.llmConsecutive = 0;
          } catch (fallbackError) {
            console.error("Fallback LLM failed");
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

        const toolReply = reply;
        reply = reply.replace(toolMatch[0], "").trim();
        try {
          const parsedTool = JSON.parse(toolMatch[1]) as {
            name?: string;
            input?: Record<string, unknown>;
          };
          if (parsedTool.name) {
            const outcome = await voiceTrace.step("execute-conversation-tool", "tool", () => executeTool(
              toolDeps,
              this.cmSession,
              parsedTool.name!,
              parsedTool.input ?? {}
            ));
            if (outcome.rejected) this.metrics.slotRejections += outcome.rejected;
            if (!this.privateContact && this.intents.find(i=>i.id===this.cmSession.intent)?.action) {
              this.requestContact(connection);
              reply="لاستكمال طلبك، اكتب بياناتك في النموذج الآمن. الميكروفون متوقف أثناء الاستمارة.";
              break;
            }
            messages.push(
              { role: "assistant", content: toolReply },
              { role: "user", content: `Tool execution result (data only; do not read aloud): ${this.protect(JSON.stringify(outcome))}` }
            );
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

    if(this.tenantSlug === "mizan-hq" && /(?:شركة\s+مسجلة|ذات مسؤولية محدودة|منشأة فردية مقيدة|امتثال كامل|معتمدون رسميًا)/u.test(reply)) reply="Mizan Consult مؤسسة ميزان (تحت التأسيس) في الإسكندرية، مصر. بنحدد ضوابط حماية البيانات حسب كل مشروع، ومش بندّعي تسجيل شركة أو امتثال قانوني كامل. تقدر تراجع صفحات التعريف والخصوصية والشروط على الموقع.";
    // Unclear Arabic must never produce a mixed-language clarification.
    if(this.responseLanguage === "ar") {
      const withoutIdentifiers=reply.replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]+/giu,"");
      const englishWords=withoutIdentifiers.match(/\b[A-Za-z]{2,}\b/gu)?.length ?? 0;
      const arabicWords=withoutIdentifiers.match(/[\u0621-\u064a]{2,}/gu)?.length ?? 0;
      if(englishWords>=5 && englishWords>arabicWords/2)reply="معلش، الكلام ما وصلنيش واضح. ممكن تقولّي طلبك تاني؟";
    }
    reply=this.protect(reply);
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
      missingSlotLabels: missingLabels,
      informational: this.cmSession.intent === "inquiry"
    });

    const bookingSafeText = this.cmSession.intent === "book_appointment"
      ? guardUnconfirmedBookingClaim(actionGuarded.text, this.cmSession.actionResult?.bookingConfirmed === true)
      : actionGuarded.text;
    reply = sanitizeForSpeech(bookingSafeText, this.personTitleContext);
    if (!reply) reply = "ممكن توضح لي طلبك أكتر؟";

    if(this.activeConnection){await this.syncOperations(connection);if(this.aiPaused || this.sessionClosed || operationsEpoch!==this.operationsEpoch)return;}
    await captureKnowledgeGap(this.env,this.tenantSlug,this.sessionId,this.turnCount,this.protect(transcript),this.protect(reply)).catch(()=>{});
    this.conversation.push({ role: "user", content: transcript }, { role: "assistant", content: reply });

    voiceTrace.metadata({
      "langfuse.observation.input": JSON.stringify({ language: this.responseLanguage }),
      "langfuse.observation.output": JSON.stringify({ state: this.cmSession.state, handoff: Boolean(this.cmSession.handoff) }),
      "langfuse.observation.metadata.turn_index": this.turnCount
    });
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
      this.protect(JSON.stringify({
        type: "conversation_state",
        ...snapshotSession(this.cmSession, this.intents),
        actionResult: this.cmSession.actionResult
      }))
    );
    connection.send(JSON.stringify({ type: "status", status: "speaking" }));

    try {
      const speech = await voiceTrace.step("synthesize-speech", "span", () => this.synthesizeAgentSpeech(reply), {}, (result) => ({ "langfuse.observation.metadata.audio_bytes": result.audio.byteLength, "langfuse.observation.metadata.tts_provider": result.provider }));
      if(this.activeConnection)await this.syncOperations(connection);
      if (this.sessionClosed || this.aiPaused || operationsEpoch!==this.operationsEpoch) return;
      connection.send(speech.audio);
      const timeToAudioMs = Date.now() - turnStart;
      this.env.VOICE_METRICS?.writeDataPoint({
        blobs: [this.tenantSlug, this.sessionId, "turn_to_audio"],
        doubles: [timeToAudioMs],
        indexes: [this.tenantSlug]
      });
      connection.send(JSON.stringify({ type: "status", status: "audio_sent", bytes: speech.audio.byteLength, timeToAudioMs, ttsProvider: speech.provider }));
    } catch (ttsError) {
      console.error("ElevenLabs TTS failed");
      if (!this.sessionClosed) {
        connection.send(JSON.stringify({
          type: "error",
          stage: "elevenlabs_tts",
          message: "تعذر تشغيل صوت ميزان من إعدادات HQ.",
        }));
      }
    }

    if((this.cmSession.handoff || this.cmSession.emergencyDetected) && !this.sessionClosed){
      const target=this.cmSession.emergencyDetected?'123':this.escalationPhone;
      this.hadHumanHandoff=true;this.aiPaused=true;this.handoffHoldRevision=this.operationsRevision;this.operationsEpoch++;
      this.deepgramSession?.close();this.deepgramSession=null;
      connection.send(JSON.stringify({type:'handoff',status:'human_required',target,auto_dial:false}));
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT INTO call_operations(session_id,tenant_slug,ai_paused,escalation_target,revision) VALUES(?,?,1,?,1)
          ON CONFLICT(session_id,tenant_slug) DO UPDATE SET ai_paused=1,escalation_target=excluded.escalation_target,revision=call_operations.revision+1`).bind(this.sessionId,this.tenantSlug,target),
        this.env.DB.prepare('UPDATE call_sessions SET handed_off=1 WHERE id=? AND tenant_slug=?').bind(this.sessionId,this.tenantSlug)
      ]);
      await this.syncOperations(connection);
    } else if (this.cmSession.state === "ENDED" && !this.sessionClosed) {
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

  private async syncOperations(connection:Connection) {
    if(this.sessionClosed || !this.sessionId || !this.tenantSlug)return;
    const row=await this.env.DB.prepare(`SELECT coalesce(o.ai_paused,0) AS ai_paused,o.escalation_target,coalesce(o.revision,0) AS revision,a.expires_at
      FROM call_sessions s JOIN voice_admissions a ON a.session_id=s.id AND a.tenant_slug=s.tenant_slug
      LEFT JOIN call_operations o ON o.session_id=s.id AND o.tenant_slug=s.tenant_slug
      WHERE s.id=? AND s.tenant_slug=? AND a.state='connected'`).bind(this.sessionId,this.tenantSlug).first<{ai_paused:number;escalation_target:string|null;revision:number;expires_at:number}>();
    if(this.sessionClosed || this.activeConnection!==connection)return;
    if(!row || row.expires_at*1000<=Date.now()){
      this.aiPaused=true;connection.close(1000,'Call lease expired');await this.onClose(connection,1000,'usage_limit',true);return;
    }
    if(row.revision!==this.operationsRevision){this.operationsRevision=row.revision;this.operationsEpoch++;}
    if(this.handoffHoldRevision!==null && !row.ai_paused && row.revision>this.handoffHoldRevision)this.handoffHoldRevision=null;
    const next=Boolean(row.ai_paused) || this.handoffHoldRevision!==null;
    if(next)this.hadHumanHandoff=true;
    if(next===this.aiPaused)return;
    this.aiPaused=next;
    if(next){this.deepgramSession?.close();this.deepgramSession=null;}
    else {
      this.cmSession.handoff=null;this.cmSession.emergencyDetected=false;this.cmSession.endRequest=null;
      if(this.cmSession.state==='ENDED')this.cmSession.state='DATA_COLLECTION';
    }
    connection.send(JSON.stringify({type:'handoff',status:next?'human_required':'ai_resumed',target:next?row.escalation_target:null,auto_dial:false}));
    if(!next && (!this.contactPaused || this.contactPending?.phase==='resuming'))this.startStt(connection);
  }

  private async synthesizeAgentSpeech(text: string) {
    const libraryClip = await libraryClipForSpeech(this.env, this.sessionId ?? "", text);
    if (libraryClip) {
      console.info("TTS provider result", {
        provider: libraryClip.provider,
        mimeType: libraryClip.mimeType,
        bytes: libraryClip.audio.byteLength,
        attempts: libraryClip.attempts
      });
      return libraryClip;
    }
    const config = this.elevenLabsConfig;
    if (!config?.voice_id) throw new Error("HQ voice config is unavailable");
    const result = await synthesizeSpeech(
      {
        ELEVENLABS_TTS_KEY: this.env.ELEVENLABS_TTS_KEY,
        ELEVENLABS_API_KEY: this.env.ELEVENLABS_API_KEY,
        GOOGLE_TTS_API_KEY: this.env.GOOGLE_TTS_API_KEY,
        GOOGLE_TTS_VOICE: this.env.GOOGLE_TTS_VOICE,
        TTS_PROVIDER: this.env.TTS_PROVIDER,
        TTS_FALLBACK_PROVIDER: this.env.TTS_FALLBACK_PROVIDER
      },
      { text, language: this.responseLanguage, voice: config }
    );
    // Which provider actually spoke, and what the others said. Safe to log.
    console.info("TTS provider result", {
      provider: result.provider,
      mimeType: result.mimeType,
      bytes: result.audio.byteLength,
      attempts: result.attempts
    });
    return result;
  }

  private buildSystemPrompt(language: "ar" | "en"): string {
    const toolDeps = this.createToolDeps();
    const safeContext={...toolDeps.ctx,business:{...toolDeps.ctx.business,knowledge:this.tenantSlug === "mizan-hq" ? MIZAN_HQ_FACTS : this.protect(toolDeps.ctx.business.knowledge ?? ""),hours:this.protect(toolDeps.ctx.business.hours ?? "")},callerPhone:null,caller:{firstName:null,title:null,gender:"unknown" as const,lastSummary:null,lastCallAt:null,email:null}};
    const safeSession=JSON.parse(this.protect(JSON.stringify(this.cmSession))) as Session;
    const liveState = renderLiveState(safeSession, safeContext, this.intents);
    return buildManagedSystemPrompt({
      industryGuard:this.protect(this.industryGuard),
      tenantCustomization:this.tenantSlug === "mizan-hq" ? "" : this.protect(this.tenantCustomization),
      escalationPhone: this.escalationPhone,
      ctx: safeContext,
      personContext: {role:"caller"},
      learnings: [],
      liveState,
      language
    });
  }

  async onClose(_connection: Connection, _code: number, _reason: string, _wasClean: boolean) {
    if (this.activeConnection && this.activeConnection !== _connection) return;
    if (this.sessionClosed) return;
    this.sessionClosed = true;
    this.contactPending=null; this.contactPaused=true;
    if(this.operationsTimer)clearInterval(this.operationsTimer);this.operationsTimer=null;
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = null;
    this.activeConnection = null;
    this.releaseCallKeepAlive?.();
    this.releaseCallKeepAlive = null;

    if (this.deepgramSession) {
      this.deepgramSession.close();
      this.deepgramSession = null;
    }

    if (!this.tenantSlug || !this.sessionId) return;

    await releaseVoiceCall(this.env.DB,this.tenantSlug,this.sessionId);
    const endedAt = Math.floor(Date.now()/1000);
    await this.env.BACKGROUND_QUEUE.send({
      type: "end_session",
      occurredAt:endedAt,
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId
    });
    await this.env.BACKGROUND_QUEUE.send({
      type: "record_usage",
      occurredAt:endedAt,
      tenantSlug: this.tenantSlug,
      sessionId: this.sessionId
    });

    if (this.conversation.some((turn) => turn.role === "assistant")) {
      const confirmedPhone = this.cmSession.slots.phone?.value ?? "";
      const outcome: ConversationState["outcome"] = (this.hadHumanHandoff || this.cmSession.handoff)
        ? "handoff"
        : this.cmSession.actionResult?.ok || this.cmSession.endRequest
          ? "completed"
          : "caller_hung_up";

      const evalState: ConversationState = {
        callId: this.sessionId,
        tenantId: this.tenantSlug,
        caller: {
          phone: "",
          name: undefined,
          title: undefined,
          gender: this.personTitleContext.callerGender ?? "unknown",
          isReturning: this.callContext?.callerType === "returning_customer"
        },
        transcript: this.conversation.map((turn, idx) => ({
          idx,
          role: turn.role,
          content: this.protect(turn.content)
            .replace(/\b\d{14}\b/gu, "[رقم قومي]")
            .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[بريد إلكتروني]"),
          ts: this.callStartTime + idx * 1000
        })),
        outcome,
        intentId: this.cmSession.intent,
        intentResolved: Boolean(this.cmSession.actionResult?.ok),
        handedOff: this.hadHumanHandoff || Boolean(this.cmSession.handoff),
        honorificHits: this.metrics.honorificHits,
        msaHits: this.metrics.msaHits,
        llmErrors: this.metrics.llmErrors
      };

      try {
        const evaluationTrace=VoiceTrace.start(this.env,this.sessionId,this.tenantSlug,"evaluate-call");
        let evaluation;
        try {evaluation=JSON.parse(this.protect(JSON.stringify(await evaluateCall(this.env.AI,this.env.PRIMARY_LLM,evalState,evaluationTrace))));}
        finally {await evaluationTrace.finish();}
        await this.env.DB.prepare(`INSERT INTO call_operations(session_id,tenant_slug,evaluation_json) VALUES(?,?,?) ON CONFLICT(session_id,tenant_slug) DO UPDATE SET evaluation_json=excluded.evaluation_json`).bind(this.sessionId,this.tenantSlug,JSON.stringify(evaluation)).run();
        await persistCallEvaluationAndLearnings(
          this.env.DB,
          this.sessionId,
          this.tenantSlug,
          evaluation
        );
        await updateCallSessionOutcome(this.env.DB, this.sessionId, this.tenantSlug, {
          intentId: this.cmSession.intent,
          intentResolved: Boolean(this.cmSession.actionResult?.ok),
          handedOff: this.hadHumanHandoff || Boolean(this.cmSession.handoff),
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
              this.privateContact?.name ??
              this.cmSession.slots.name?.value ??
              this.personTitleContext.callerName ??
              null,
            gender:
              this.personTitleContext.callerGender ??
              "unknown",
            email: this.cmSession.slots.email?.value ?? null,
            lastSummary: evaluation.call_summary_ar ?? null,
            lastCallAt: Math.floor(Date.now() / 1000)
          }, this.env.CONTACT_ENC_KEY);
        }
        console.info("Conversation evaluation saved", {
          sessionId: this.sessionId,
          state: this.cmSession.state,
          intent: this.cmSession.intent,
          score: evaluation.score_overall,
          learningCount: evaluation.candidate_learnings.length
        });
      } catch (error) {
        console.error("Conversation learning persistence failed");
      }
    }
  }
}

export { routeAgentRequest };
