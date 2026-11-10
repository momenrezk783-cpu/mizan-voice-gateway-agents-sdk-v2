import { redactPII } from "../crypto";

export interface LearningCandidate {
  category: "dialect" | "flow" | "objection" | "domain_faq";
  rule_ar: string;
  rationale?: string;
}

export interface LearningEvaluation {
  score_overall: number;
  candidate_learnings: LearningCandidate[];
}

/**
 * Gateway already owns the learnings table. Its schema is intentionally
 * tenant-scoped (tenant_id NOT NULL), with rule text in text and category in source.
 * Do not create a parallel Mizan-source schema or alter the existing table.
 */
export async function fetchActiveLearnings(
  db: D1Database,
  tenantId: string,
  limit = 6
): Promise<string[]> {
  try {
    const result = await db.prepare(`
      SELECT text FROM learnings
      WHERE active = 1
        AND tenant_id = ?
        AND source IN ('dialect', 'flow', 'objection', 'domain_faq')
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).bind(tenantId, Math.max(1, Math.min(12, Math.floor(limit)))).all<{ text: string }>();
    return (result.results ?? [])
      .map((row) => redactPII(String(row.text || "").trim()))
      .filter((rule) => isSafeLearning(rule));
  } catch (error) {
    console.error("Conversation learnings could not be loaded:", error);
    return [];
  }
}

function isSafeLearning(value: string): boolean {
  if (value.length < 10 || value.length > 220) return false;
  if (/(?:\b01[0125]\d{8}\b|\b\d{14}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu.test(value)) return false;
  return !/(?:حضرتك|فندم|افندم|أفندم|باشا|بيه|هانم|سيادتك|سعادتك)/u.test(value);
}

export async function persistCallEvaluationAndLearnings(
  db: D1Database,
  callId: string,
  tenantId: string,
  evaluation: LearningEvaluation
): Promise<void> {
  if (!Number.isFinite(evaluation.score_overall) || evaluation.score_overall < 75) return;

  for (const candidate of evaluation.candidate_learnings ?? []) {
    const rule = redactPII(String(candidate.rule_ar ?? "").trim());
    if (!isSafeLearning(rule)) continue;
    await db.prepare(`
      INSERT INTO learnings (
        id, tenant_id, source_call_id, text, source,
        confidence, active, applied_count, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 1, 0, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM learnings
        WHERE tenant_id = ? AND source = ? AND text = ? AND active = 1
      )
    `).bind(
      crypto.randomUUID(),
      tenantId,
      callId,
      rule,
      candidate.category,
      evaluation.score_overall / 100,
      Date.now(),
      tenantId,
      candidate.category,
      rule
    ).run();
  }
}
