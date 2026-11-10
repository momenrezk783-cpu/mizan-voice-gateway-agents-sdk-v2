// ============================================================================
// Mizan Conversation Manager — Post-Call Evaluator & Learning Validator
// ============================================================================
// Combines deterministic Egyptian-dialect & honorific scoring with Workers AI
// structured post-call evaluation, strict safety validation of extracted
// learnings, and CRM contact inference extraction.
// ============================================================================

import {
  containsBannedAddress,
  detectNonEgyptian,
  isProceduralPhrase,
  type CallerGender,
  type ConversationState,
  type PersonTitleContext
} from "./guard";
import {
  ALLOWED_LEARNING_SOURCES,
  isSafeLearning,
  type LearningCandidate,
  type LearningCategory,
  type LearningEvaluation
} from "./db";
import { cleanPromptLine } from "./prompt";

export type ConversationEvaluation = LearningEvaluation & {
  score_dialect: number;
  score_respect: number;
  score_flow: number;
  banned_words_found: string[];
  dialect_violations: string[];
  failure_modes: string[];
};

const FORBIDDEN_IN_LEARNING =
  /حضرتك|فندم|افندم|أفندم|باشا|بيه|هانم|سيادتك|سعادتك|تجاهل التأكيد|بدون تأكيد|ادّعي|تظاهر|اكذب|اختلق|اخترع|تجاهل التعليمات|ignore previous/iu;

export function validateLearning(rule: string): boolean {
  const value = String(rule ?? "").trim();
  if (value.length < 10 || value.length > 260) return false;
  if (FORBIDDEN_IN_LEARNING.test(value)) return false;
  return isSafeLearning(value);
}

function clampScore(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : fallback;
}

export async function evaluateCall(
  ai: Ai | undefined,
  modelId: string,
  state: ConversationState
): Promise<ConversationEvaluation> {
  const personContext: PersonTitleContext = {
    role: "caller",
    callerName: state.caller.name,
    callerTitle: state.caller.title,
    callerGender: state.caller.gender
  };
  const assistantTurns = state.transcript.filter((turn) => turn.role === "assistant");
  const bannedFound: string[] = [];
  const dialectViolations: string[] = [];

  for (const turn of assistantTurns) {
    if (containsBannedAddress(turn.content, personContext)) {
      bannedFound.push(`turn#${turn.idx}: ${turn.content.slice(0, 60)}`);
    }
    const violations = detectNonEgyptian(turn.content);
    if (violations.length) {
      dialectViolations.push(`turn#${turn.idx}: ${violations.join(",")}`);
    }
  }

  const baseRespect = bannedFound.length ? Math.max(0, 100 - bannedFound.length * 30) : 100;
  const baseDialect = dialectViolations.length ? Math.max(0, 95 - dialectViolations.length * 25) : 95;
  const baseFlow =
    state.outcome === "completed" || state.intentResolved
      ? 92
      : state.outcome === "handoff"
        ? 80
        : 75;

  const fallbackSummary =
    state.intentId === "book_appointment" && state.intentResolved
      ? "تم تأكيد حجز الموعد بنجاح خلال المكالمة."
      : state.intentId === "callback_request" && state.intentResolved
        ? "تم تسجيل طلب معاودة الاتصال من الفريق."
        : state.intentId === "complaint" && state.intentResolved
          ? "تم تسجيل شكوى المتصل للمتابعة."
          : "مكالمة استفسار عام مع المساعد الصوتي.";

  const fallback: ConversationEvaluation = {
    score_overall: Math.round((baseRespect + baseDialect + baseFlow) / 3),
    score_dialect: baseDialect,
    score_respect: baseRespect,
    score_flow: baseFlow,
    banned_words_found: bannedFound,
    dialect_violations: dialectViolations,
    failure_modes: [],
    candidate_learnings: [],
    call_summary_ar: fallbackSummary,
    inferred_caller_first_name:
      state.caller.name && !isProceduralPhrase(state.caller.name) ? state.caller.name : undefined,
    inferred_caller_gender: state.caller.gender
  };

  if (!ai || assistantTurns.length === 0) return fallback;

  const transcript = state.transcript
    .map((turn) => `[${turn.idx}] ${turn.role}: ${turn.content}`)
    .join("\n")
    .slice(0, 6000);

  const prompt = `إنت مراجع جودة لمكالمات ميزان في مصر. قيّم المكالمة حسب طبيعية العامية المصرية القاهرية، واحترام المتصل بدون «حضرتك» أو «يا فندم»، ودقة جمع البيانات وتأكيدها، وعدم اختلاق وعود أو إجراءات.
المكالمة:
${transcript}
النية: ${state.intentId ?? "unknown"} | تم الحل: ${Boolean(state.intentResolved)} | النتيجة: ${state.outcome ?? "unknown"}
أعد JSON فقط بهذا الشكل:
{"score_overall":0,"score_dialect":0,"score_respect":0,"score_flow":0,"call_summary_ar":"ملخص من جملتين بالعامية المصرية","inferred_caller_first_name":"","inferred_caller_gender":"male|female|unknown","failure_modes":[],"candidate_learnings":[{"category":"dialect|flow|objection|domain_faq|phrasing|ordering|pacing|recovery|confirmation|intent_detection","rule_ar":"قاعدة قصيرة قابلة للتطبيق","rationale":"السبب","confidence":0.8}]}
القواعد المستخلصة يجب أن تكون محددة وآمنة، ولا تحتوي بيانات شخصية أو ألفاظًا ممنوعة.`;

  try {
    const response = (await ai.run(modelId as Parameters<Ai["run"]>[0], {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      temperature: 0.1
    })) as { response?: string };

    const raw = String(response?.response ?? "").trim();
    const match = raw.match(/\{[\s\S]*\}/u);
    if (!match) return fallback;

    const parsed = JSON.parse(match[0]) as Partial<ConversationEvaluation> & {
      call_summary_ar?: string;
      inferred_caller_first_name?: string;
      inferred_caller_gender?: string;
    };

    const candidates: LearningCandidate[] = (parsed.candidate_learnings ?? [])
      .filter(
        (candidate): candidate is LearningCandidate =>
          Boolean(candidate) &&
          ALLOWED_LEARNING_SOURCES.includes(candidate.category as LearningCategory) &&
          validateLearning(candidate.rule_ar)
      )
      .map((candidate) => ({
        category: candidate.category,
        rule_ar: candidate.rule_ar.trim(),
        rationale: String(candidate.rationale ?? "").slice(0, 300),
        confidence:
          typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
            ? Math.max(0.5, Math.min(1, candidate.confidence))
            : undefined
      }));

    const inferredNameRaw = String(parsed.inferred_caller_first_name ?? "").trim();
    const inferredName =
      inferredNameRaw && !isProceduralPhrase(inferredNameRaw)
        ? cleanPromptLine(inferredNameRaw, 40)
        : fallback.inferred_caller_first_name;

    const inferredGender: CallerGender =
      parsed.inferred_caller_gender === "male" || parsed.inferred_caller_gender === "female"
        ? parsed.inferred_caller_gender
        : fallback.inferred_caller_gender ?? "unknown";

    const summaryAr = parsed.call_summary_ar
      ? cleanPromptLine(parsed.call_summary_ar, 300)
      : fallbackSummary;

    return {
      score_overall: clampScore(parsed.score_overall, fallback.score_overall),
      score_dialect: clampScore(parsed.score_dialect, fallback.score_dialect),
      score_respect: bannedFound.length
        ? Math.min(60, clampScore(parsed.score_respect, 60))
        : clampScore(parsed.score_respect, fallback.score_respect),
      score_flow: clampScore(parsed.score_flow, fallback.score_flow),
      banned_words_found: bannedFound,
      dialect_violations: dialectViolations,
      failure_modes: Array.isArray(parsed.failure_modes)
        ? parsed.failure_modes.map(String).slice(0, 10)
        : [],
      candidate_learnings: candidates,
      call_summary_ar: summaryAr,
      inferred_caller_first_name: inferredName,
      inferred_caller_gender: inferredGender
    };
  } catch (error) {
    console.error("Conversation evaluation failed:", error);
    return fallback;
  }
}
