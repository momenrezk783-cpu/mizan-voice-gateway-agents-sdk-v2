import assert from "node:assert/strict";
import { importTs, mockDialogueResponse } from "./helpers/runtime.mjs";

const { runTextTurn, buildTurnSystemPrompt } = await importTs("src/lib/turn-engine.ts");
const { MizanVoiceAgent } = await importTs("src/agent.ts");
const { newSession, DEFAULT_INTENTS } = await importTs("src/lib/conversation-manager/manager.ts");
const { buildClock, STATIC_MASTER_RULES } = await importTs("src/lib/conversation-manager/prompt.ts");
const { redactPII } = await importTs("src/lib/crypto.ts");

function makeToolDeps(tenantId = "alex-pilot-01", industry = "healthcare") {
  return {
    ctx: {
      callId: "call-turn-engine-test",
      tenantId,
      direction: "inbound",
      callerPhone: null,
      callerType: "unknown",
      caller: {
        firstName: null,
        title: null,
        gender: "male",
        lastSummary: null,
        lastCallAt: null
      },
      business: {
        name: "عيادة الإسكندرية التجريبية",
        agentName: "ميزان",
        agentGender: "male",
        hours: "يومياً من 10 صباحاً حتى 10 مساءً",
        knowledge: "[schedules]\nمواعيد العمل يومياً من 10 صباحاً حتى 10 مساءً",
        handoffNumber: "+201000000001",
        industry
      },
      clock: buildClock("Africa/Cairo", new Date("2026-11-16T10:00:00Z"))
    },
    intents: DEFAULT_INTENTS,
    canTransfer: () => true,
    runAction: async () => ({ ok: true, detail: "done" })
  };
}

// 1. Prompt hierarchy: STATIC_MASTER_RULES stays at top, industryGuard & tenantCustomization injected safely
{
  const deps = makeToolDeps();
  const session = newSession();
  const prompt = buildTurnSystemPrompt({
    tenantSlug: "alex-pilot-01",
    language: "ar",
    industryGuard: "لا تقدم تشخيصاً طبياً.",
    tenantCustomization: "العيادة في سموحة بالإسكندرية.",
    escalationPhone: "+201000000001",
    cmSession: session,
    intents: DEFAULT_INTENTS,
    toolDeps: deps,
    protect: (t) => redactPII(t)
  });
  assert.ok(prompt.startsWith(STATIC_MASTER_RULES), "Prompt must start with locked code-owned persona");
  assert.ok(prompt.includes("لا تقدم تشخيصاً طبياً."), "Industry guard must be present");
  assert.ok(prompt.includes("العيادة في سموحة بالإسكندرية."), "Additive tenant customization must be present");
}

// 2. PII redaction + Arabic output guard (honorifics, MSA, unconfirmed booking claims)
{
  globalThis.__mizanGenerate = async () => ({
    text: "أهلاً يا فندم، مع حضرتك ميزان. سوف أساعدك، لماذا تتصل؟ المواعيد من 10 صباحاً حتى 10 مساءً.",
    finishReason: "stop",
    usage: { inputTokens: 20, outputTokens: 18 }
  });

  const deps = makeToolDeps();
  const session = newSession();
  const res = await runTextTurn({
    env: {
      AI: {},
      PRIMARY_LLM: "@cf/daily-co/phonellm-mini-alpha-2",
      FALLBACK_LLM: "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
    },
    tenantSlug: "alex-pilot-01",
    responseLanguage: "ar",
    escalationPhone: "+201000000001",
    industryGuard: "لا تقدم تشخيصاً طبياً.",
    tenantCustomization: "العيادة في سموحة.",
    personTitleContext: { role: "caller", callerGender: "male" },
    cmSession: session,
    intents: DEFAULT_INTENTS,
    conversation: [],
    toolDeps: deps,
    transcript: "رقمي 01012345678 والرقم القومي 29901011234567 وعايز أعرف مواعيد العيادة",
    hasPrivateContact: false,
    contactDeclined: false,
    protect: (t) => redactPII(t).replace(/\b\d{14}\b/gu, "[رقم قومي]")
  });

  assert.ok(!res.redactedTranscript.includes("01012345678"), "Egyptian phone must be redacted");
  assert.ok(!res.protectedTranscript.includes("29901011234567"), "National ID must be redacted");
  assert.ok(!res.reply.includes("فندم") && !res.reply.includes("حضرتك"), "Banned honorifics must be stripped");
  assert.ok(res.honorificViolations.length >= 2, "Honorific violations must be counted");
  assert.ok(res.msaViolations.length >= 2, "MSA markers (سوف / لماذا) must be detected");
}

// 3. Simulator vs Live Agent equivalence on the same utterance & model output
{
  const cannedModelOutput = "أهلاً يا فندم، مواعيد العمل يومياً من 10 صباحاً لـ 10 مساءً.";
  globalThis.__mizanGenerate = async () => ({
    text: cannedModelOutput,
    finishReason: "stop",
    usage: { inputTokens: 15, outputTokens: 12 }
  });

  const simSession = newSession();
  const simResult = await runTextTurn({
    env: {
      AI: {},
      PRIMARY_LLM: "@cf/daily-co/phonellm-mini-alpha-2",
      FALLBACK_LLM: "@cf/deepseek-ai/deepseek-v4.1-flash-1017"
    },
    tenantSlug: "alex-pilot-01",
    responseLanguage: "ar",
    escalationPhone: "+201000000001",
    industryGuard: "لا تقدم تشخيصاً طبياً.",
    tenantCustomization: "العيادة في سموحة.",
    personTitleContext: { role: "caller", callerGender: "unknown" },
    cmSession: simSession,
    intents: DEFAULT_INTENTS,
    conversation: [],
    toolDeps: makeToolDeps(),
    transcript: "إيه مواعيد العمل عندكم؟",
    hasPrivateContact: false,
    contactDeclined: false
  });

  const sentMessages = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => mockDialogueResponse(url);
  try {
    const agent = new MizanVoiceAgent(
      { name: "alex-pilot-01:11111111-2222-4333-8444-555555555555" },
      {
        ENVIRONMENT: "staging",
        PRIMARY_LLM: "@cf/daily-co/phonellm-mini-alpha-2",
        FALLBACK_LLM: "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
        ELEVENLABS_TTS_KEY: "el-test-key",
        AI: {},
        BACKGROUND_QUEUE: { send: async () => {} },
        TENANT_CONFIG: { get: async () => null, put: async () => {} },
        DB: {
          prepare: (sql) => ({
            bind: () => ({
              first: async () =>
                sql.includes("voice_admissions")
                  ? { ai_paused: 0, escalation_target: null, revision: 0, expires_at: Math.floor(Date.now() / 1000) + 600 }
                  : { version_number: 1 },
              run: async () => ({}),
              all: async () => ({ results: [] })
            })
          }),
          batch: async () => []
        }
      }
    );
    agent.tenantSlug = "alex-pilot-01";
    agent.sessionId = "11111111-2222-4333-8444-555555555555";
    agent.industryGuard = "لا تقدم تشخيصاً طبياً.";
    agent.tenantCustomization = "العيادة في سموحة.";
    agent.elevenLabsConfig = {
      voice_id: "2DkHmQavK9V2UzTYrMYT",
      model_id: "eleven_v4_turbo",
      stability: 0.5,
      similarity_boost: 0.75,
      speed: 1
    };
    const fakeConn = {
      send(payload) {
        if (typeof payload === "string") sentMessages.push(JSON.parse(payload));
      },
      close() {}
    };
    agent.activeConnection = fakeConn;
    await agent.respondToTranscript(fakeConn, "إيه مواعيد العمل عندكم؟");
  } finally {
    globalThis.fetch = originalFetch;
    delete globalThis.__mizanGenerate;
  }

  const agentTranscriptMsg = sentMessages.find((m) => m.type === "transcript" && m.speaker === "agent");
  assert.ok(agentTranscriptMsg, "Live agent must emit transcript event");
  assert.equal(
    agentTranscriptMsg.text,
    simResult.reply,
    "Simulator and live MizanVoiceAgent must produce the exact same guarded reply"
  );
}

console.log("PASS shared turn-engine equivalence, PII redaction, and Arabic output guard checks");
