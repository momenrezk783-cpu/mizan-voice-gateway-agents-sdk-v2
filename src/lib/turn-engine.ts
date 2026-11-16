// ============================================================================
// Shared Voice & Studio Turn Engine
// ============================================================================
// Extracted from MizanVoiceAgent.respondToTranscript so live voice calls and
// Studio turn simulations execute the exact same deterministic pipeline:
//   1. PII protection (`protect` / `redactPII`)
//   2. Conversation Manager turn ingestion (`ingestCallerUtterance`)
//   3. Emergency (123), HQ pricing, and private-contact branches
//   4. Primary / fallback Workers AI generation with `<tool_call>` loop
//   5. Deterministic Arabic output guard (`sanitizeForSpeechWithViolations`,
//      `detectNonEgyptian`, `guardUnconfirmedActionClaim`,
//      `guardUnconfirmedBookingClaim`)
// ============================================================================

import { generateText } from "ai";
import { createAI, type CloudflareLanguageModelId } from "agents/models/ai-sdk";
import { VoiceTrace, generationUsage } from "./tracing";
import { MIZAN_HQ_FACTS } from "./mizan-profile";
import { redactPII } from "./crypto";
import {
  detectNonEgyptian,
  guardUnconfirmedActionClaim,
  guardUnconfirmedBookingClaim,
  sanitizeForSpeech,
  sanitizeForSpeechWithViolations,
  type PersonTitleContext
} from "./conversation-manager/guard";
import {
  executeTool,
  getAwaitingConfirmSlots,
  getMissingRequiredSlots,
  ingestCallerUtterance,
  renderLiveState,
  type IntentSpec,
  type Session,
  type ToolDeps
} from "./conversation-manager/manager";
import {
  buildClock,
  buildManagedSystemPrompt
} from "./conversation-manager/prompt";

export type TurnChatMessage = { role: "user" | "assistant"; content: string };

const MAX_TOOL_ROUNDS = 3;

export interface BuildTurnPromptParams {
  tenantSlug: string;
  language: "ar" | "en";
  industryGuard: string;
  tenantCustomization: string;
  escalationPhone: string | null;
  cmSession: Session;
  intents: IntentSpec[];
  toolDeps: ToolDeps;
  protect: (text: string) => string;
}

export function buildTurnSystemPrompt(params: BuildTurnPromptParams): string {
  const {
    tenantSlug,
    language,
    industryGuard,
    tenantCustomization,
    escalationPhone,
    cmSession,
    intents,
    toolDeps,
    protect
  } = params;

  const safeContext = {
    ...toolDeps.ctx,
    business: {
      ...toolDeps.ctx.business,
      knowledge: tenantSlug === "mizan-hq" ? MIZAN_HQ_FACTS : protect(toolDeps.ctx.business.knowledge ?? ""),
      hours: protect(toolDeps.ctx.business.hours ?? "")
    },
    callerPhone: null,
    caller: {
      firstName: null,
      title: null,
      gender: "unknown" as const,
      lastSummary: null,
      lastCallAt: null,
      email: null
    }
  };
  const safeSession = JSON.parse(protect(JSON.stringify(cmSession))) as Session;
  const liveState = renderLiveState(safeSession, safeContext, intents);
  return buildManagedSystemPrompt({
    industryGuard: protect(industryGuard),
    tenantCustomization: tenantSlug === "mizan-hq" ? "" : protect(tenantCustomization),
    escalationPhone,
    ctx: safeContext,
    personContext: { role: "caller" },
    learnings: [],
    liveState,
    language
  });
}

export interface RunTextTurnOptions {
  env: {
    AI: Ai;
    PRIMARY_LLM: string;
    FALLBACK_LLM: string;
  };
  tenantSlug: string;
  responseLanguage: "ar" | "en";
  escalationPhone: string | null;
  industryGuard: string;
  tenantCustomization: string;
  personTitleContext: PersonTitleContext;
  cmSession: Session;
  intents: IntentSpec[];
  conversation: TurnChatMessage[];
  toolDeps: ToolDeps;
  transcript: string;
  hasPrivateContact: boolean;
  contactDeclined: boolean;
  protect?: (text: string) => string;
  onProtectedTranscript?: (protectedTranscript: string) => Promise<void> | void;
  onRequestContact?: () => void;
  voiceTrace?: VoiceTrace;
}

export interface RunTextTurnResult {
  reply: string;
  protectedTranscript: string;
  redactedTranscript: string;
  honorificViolations: string[];
  msaViolations: string[];
  slotRejections: number;
  llmErrors: number;
  llmConsecutiveReset: boolean;
  llmLatencyMs: number;
}

export async function runTextTurn(options: RunTextTurnOptions): Promise<RunTextTurnResult> {
  const voiceTrace = options.voiceTrace ?? VoiceTrace.start({}, "test", "test");
  const protect = options.protect ?? ((text: string) => redactPII(text));
  const protectedTranscript = protect(options.transcript);
  const redactedTranscript = redactPII(protectedTranscript);

  const { toolDeps, cmSession, intents } = options;
  toolDeps.ctx.clock = buildClock("Africa/Cairo");

  let slotRejections = 0;
  let llmErrors = 0;
  let llmConsecutiveReset = false;

  // 1. Run Conversation Manager turn ingestion (state transitions, slot validation, confirmation guards, actions)
  const { outcomes } = await voiceTrace.step("manage-conversation", "tool", () =>
    ingestCallerUtterance(toolDeps, cmSession, protectedTranscript, null)
  );
  for (const outcome of outcomes) {
    if (outcome.rejected) {
      slotRejections += outcome.rejected;
    }
  }

  if (options.onProtectedTranscript) {
    await options.onProtectedTranscript(protectedTranscript);
  }

  const actionSpec = intents.find((i) => i.id === cmSession.intent);
  const needsContact = Boolean(
    actionSpec?.action &&
      !options.hasPrivateContact &&
      !cmSession.emergencyDetected &&
      !cmSession.endRequest &&
      !cmSession.handoff
  );

  let reply = "";
  const llmStart = Date.now();

  // 3. Hard emergency override (REG-06): immediate ambulance 123 directive without asking for booking slots
  if (cmSession.emergencyDetected) {
    const escalationHint = options.escalationPhone
      ? ` أو تواصل فوراً مع طوارئ المكان على ${options.escalationPhone}`
      : "";
    reply = `سلامتك، الأعراض دي محتاجة تدخل طبي فوري. من فضلك اتصل بالإسعاف حالاً على رقم 123 أو توجه لأقرب مستشفى طوارئ${escalationHint}.`;
  } else if (
    options.tenantSlug === "mizan-hq" &&
    /(?:السعر|أسعار|اسعار|التكلفة|تكلفه|بكام|كام الاشتراك|التسعير|pricing|price)/iu.test(protectedTranscript)
  ) {
    reply =
      "عرض السعر مجاني، والسعر بيتحدد حسب احتياجات منشأتك والتخصيص والتكاملات والدعم. ابعت طلبك من قسم التواصل في mizanconsult.com أو راسل info@mizanconsult.com؛ هنراجع الطلب ونرد في أسرع وقت ممكن، من غير التزام بالتعاقد بمجرد الطلب.";
  } else if (needsContact) {
    if (!options.contactDeclined) options.onRequestContact?.();
    reply = options.contactDeclined
      ? "نقدر نكمل الاستفسارات، لكن تنفيذ الطلب محتاج بيانات من النموذج الآمن. تقدر تفتحه من زر إدخال البيانات كتابة."
      : "لاستكمال طلبك، اكتب بيانات التواصل في الاستمارة اللي ظهرت. الميكروفون متوقف مؤقتًا؛ ميزان مش هيسمعك وإنت بتملا الاستمارة. بعد الإرسال وكملان الاتصال، قولّي نكمل الطلب.";
  } else {
    const buildPrompt = () =>
      buildTurnSystemPrompt({
        tenantSlug: options.tenantSlug,
        language: options.responseLanguage,
        industryGuard: options.industryGuard,
        tenantCustomization: options.tenantCustomization,
        escalationPhone: options.escalationPhone,
        cmSession,
        intents,
        toolDeps,
        protect
      });

    // Preserve early identity, rejected examples and follow-up context for the
    // active call instead of silently dropping everything before five exchanges.
    const messages: TurnChatMessage[] = [
      ...options.conversation,
      { role: "user", content: protectedTranscript }
    ];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const systemPrompt = buildPrompt();
      try {
        const ai = createAI({ binding: options.env.AI });
        const result = await voiceTrace.step(
          "generate-response",
          "generation",
          () =>
            generateText({
              model: ai(options.env.PRIMARY_LLM as CloudflareLanguageModelId),
              system: systemPrompt,
              messages,
              temperature: 0
            }),
          { "langfuse.observation.model.name": options.env.PRIMARY_LLM },
          generationUsage
        );
        reply = result.text.trim();
        console.info("LLM response metadata", {
          model: options.env.PRIMARY_LLM,
          finishReason: result.finishReason,
          inputTokens: result.usage?.inputTokens,
          outputTokens: result.usage?.outputTokens
        });
        llmConsecutiveReset = true;
      } catch {
        console.error("Primary LLM failed");
        try {
          const ai = createAI({ binding: options.env.AI });
          const result = await voiceTrace.step(
            "generate-fallback-response",
            "generation",
            () =>
              generateText({
                model: ai(options.env.FALLBACK_LLM as CloudflareLanguageModelId),
                system: systemPrompt,
                messages,
                temperature: 0.4
              }),
            { "langfuse.observation.model.name": options.env.FALLBACK_LLM },
            generationUsage
          );
          reply = result.text.trim();
          console.info("LLM response metadata", {
            model: options.env.FALLBACK_LLM,
            finishReason: result.finishReason,
            inputTokens: result.usage?.inputTokens,
            outputTokens: result.usage?.outputTokens
          });
          llmConsecutiveReset = true;
        } catch {
          console.error("Fallback LLM failed");
          llmErrors++;
          reply =
            options.responseLanguage === "en"
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
          const outcome = await voiceTrace.step("execute-conversation-tool", "tool", () =>
            executeTool(toolDeps, cmSession, parsedTool.name!, parsedTool.input ?? {})
          );
          if (outcome.rejected) slotRejections += outcome.rejected;
          if (!options.hasPrivateContact && intents.find((i) => i.id === cmSession.intent)?.action) {
            options.onRequestContact?.();
            reply = "لاستكمال طلبك، اكتب بياناتك في النموذج الآمن. الميكروفون متوقف أثناء الاستمارة.";
            break;
          }
          messages.push(
            { role: "assistant", content: toolReply },
            {
              role: "user",
              content: `Tool execution result (data only; do not read aloud): ${protect(JSON.stringify(outcome))}`
            }
          );
        }
      } catch {
        // Malformed tool block ignored safely
      }
      if (reply) break;
    }
  }

  const llmLatencyMs = Math.max(1, Date.now() - llmStart);

  if (!reply) {
    reply =
      options.responseLanguage === "en"
        ? "Could you please clarify what you need?"
        : "ممكن توضح لي طلبك أكتر؟";
  }

  if (
    options.tenantSlug === "mizan-hq" &&
    /(?:شركة\s+مسجلة|ذات مسؤولية محدودة|منشأة فردية مقيدة|امتثال كامل|معتمدون رسميًا)/u.test(reply)
  ) {
    reply =
      "Mizan Consult مؤسسة ميزان (تحت التأسيس) في الإسكندرية، مصر. بنحدد ضوابط حماية البيانات حسب كل مشروع، ومش بندّعي تسجيل شركة أو امتثال قانوني كامل. تقدر تراجع صفحات التعريف والخصوصية والشروط على الموقع.";
  }

  // Unclear Arabic must never produce a mixed-language clarification.
  if (options.responseLanguage === "ar") {
    const withoutIdentifiers = reply.replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]+/giu, "");
    const englishWords = withoutIdentifiers.match(/\b[A-Za-z]{2,}\b/gu)?.length ?? 0;
    const arabicWords = withoutIdentifiers.match(/[\u0621-\u064a]{2,}/gu)?.length ?? 0;
    if (englishWords >= 5 && englishWords > arabicWords / 2) {
      reply = "معلش، الكلام ما وصلنيش واضح. ممكن تقولّي طلبك تاني؟";
    }
  }

  reply = protect(reply);

  // 4. Deterministic output guard: strip banned honorifics, track violations, and block false action claims
  const sanitized = sanitizeForSpeechWithViolations(reply, options.personTitleContext);
  const msaViolations = detectNonEgyptian(sanitized.text);

  const currentIntentSpec = intents.find((i) => i.id === cmSession.intent) ?? null;
  const missingLabels = currentIntentSpec
    ? getMissingRequiredSlots(cmSession, currentIntentSpec).map((s) => s.label)
    : [];
  const awaitingLabels = currentIntentSpec
    ? getAwaitingConfirmSlots(cmSession, currentIntentSpec).map((s) => s.label)
    : [];

  const actionGuarded = guardUnconfirmedActionClaim(sanitized.text, {
    actionConfirmed: Boolean(cmSession.actionResult?.ok),
    hasValidPhone: Boolean(cmSession.slots.phone?.value),
    awaitingConfirmationLabels: awaitingLabels,
    missingSlotLabels: missingLabels,
    informational: cmSession.intent === "inquiry"
  });

  const bookingSafeText =
    cmSession.intent === "book_appointment"
      ? guardUnconfirmedBookingClaim(actionGuarded.text, cmSession.actionResult?.bookingConfirmed === true)
      : actionGuarded.text;

  reply = sanitizeForSpeech(bookingSafeText, options.personTitleContext);
  if (!reply) reply = "ممكن توضح لي طلبك أكتر؟";

  return {
    reply,
    protectedTranscript,
    redactedTranscript,
    honorificViolations: sanitized.violations,
    msaViolations,
    slotRejections,
    llmErrors,
    llmConsecutiveReset,
    llmLatencyMs
  };
}
