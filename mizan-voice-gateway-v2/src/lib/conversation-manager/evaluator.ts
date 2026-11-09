import {
  containsBannedAddress,
  detectNonEgyptian,
  type ConversationState,
  type PersonTitleContext,
} from "./guard";
import type { LearningCandidate, LearningEvaluation } from "./db";

export type ConversationEvaluation = LearningEvaluation & {
  score_dialect: number;
  score_respect: number;
  score_flow: number;
  banned_words_found: string[];
  dialect_violations: string[];
  failure_modes: string[];
};

const FORBIDDEN_IN_LEARNING = /حضرتك|فندم|افندم|أفندم|باشا|بيه|هانم|سيادتك|سعادتك|تجاهل التأكيد|بدون تأكيد/u;

export function validateLearning(rule: string): boolean {
  const value = String(rule ?? "").trim();
  return value.length >= 10 && value.length <= 220 && !FORBIDDEN_IN_LEARNING.test(value);
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
    callerGender: state.caller.gender,
  };
  const assistantTurns = state.transcript.filter((turn) => turn.role === "assistant");
  const bannedFound: string[] = [];
  const dialectViolations: string[] = [];

  for (const turn of assistantTurns) {
    if (containsBannedAddress(turn.content, personContext)) {
      bannedFound.push(`turn#${turn.idx}: ${turn.content.slice(0, 60)}`);
    }
    const violations = detectNonEgyptian(turn.content);
    if (violations.length) dialectViolations.push(`turn#${turn.idx}: ${violations.join(",")}`);
  }

  const baseRespect = bannedFound.length ? Math.max(0, 100 - bannedFound.length * 30) : 100;
  const baseDialect = dialectViolations.length ? Math.max(0, 95 - dialectViolations.length * 25) : 95;
  const baseFlow = state.outcome === "completed" ? 90 : 75;
  const fallback: ConversationEvaluation = {
    score_overall: Math.round((baseRespect + baseDialect + baseFlow) / 3),
    score_dialect: baseDialect,
    score_respect: baseRespect,
    score_flow: baseFlow,
    banned_words_found: bannedFound,
    dialect_violations: dialectViolations,
    failure_modes: [],
    candidate_learnings: [],
  };
  if (!ai || assistantTurns.length === 0) return fallback;

  const transcript = state.transcript
    .map((turn) => `[${turn.idx}] ${turn.role}: ${turn.content}`)
    .join("\n")
    .slice(0, 6000);
  const prompt = `إنت مراجع جودة لمكالمات ميزان في مصر. قيّم المكالمة حسب طبيعية العامية المصرية، واحترام المتصل بدقة، ووضوح التدفق.\n\nالمكالمة:\n${transcript}\nالنتيجة: ${state.outcome ?? "unknown"}\nأعد JSON فقط بهذا الشكل:\n{"score_overall":0,"score_dialect":0,"score_respect":0,"score_flow":0,"failure_modes":[],"candidate_learnings":[{"category":"dialect|flow|objection|domain_faq","rule_ar":"قاعدة قصيرة وقابلة للتطبيق","rationale":"سبب قصير"}]}\nالقواعد المستخلصة يجب أن تكون محددة وآمنة، ولا تحتوي بيانات شخصية أو ألفاظًا ممنوعة.`;

  try {
    const response = await ai.run(modelId as Parameters<Ai["run"]>[0], {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 450,
      temperature: 0.1,
    }) as { response?: string };
    const raw = String(response?.response ?? "").trim();
    const match = raw.match(/\{[\s\S]*\}/u);
    if (!match) return fallback;
    const parsed = JSON.parse(match[0]) as Partial<ConversationEvaluation>;
    const candidates: LearningCandidate[] = (parsed.candidate_learnings ?? [])
      .filter((candidate): candidate is LearningCandidate => !!candidate &&
        ["dialect", "flow", "objection", "domain_faq"].includes(candidate.category) &&
        validateLearning(candidate.rule_ar))
      .map((candidate) => ({
        category: candidate.category,
        rule_ar: candidate.rule_ar.trim(),
        rationale: String(candidate.rationale ?? "").slice(0, 300),
      }));
    return {
      score_overall: clampScore(parsed.score_overall, fallback.score_overall),
      score_dialect: clampScore(parsed.score_dialect, fallback.score_dialect),
      score_respect: bannedFound.length ? Math.min(60, clampScore(parsed.score_respect, 60)) : clampScore(parsed.score_respect, fallback.score_respect),
      score_flow: clampScore(parsed.score_flow, fallback.score_flow),
      banned_words_found: bannedFound,
      dialect_violations: dialectViolations,
      failure_modes: Array.isArray(parsed.failure_modes) ? parsed.failure_modes.map(String).slice(0, 10) : [],
      candidate_learnings: candidates,
    };
  } catch (error) {
    console.error("Conversation evaluation failed:", error);
    return fallback;
  }
}
