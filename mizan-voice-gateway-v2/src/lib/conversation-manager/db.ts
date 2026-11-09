import type { D1Database } from "@cloudflare/workers-types";

export interface ConversationLearning {
  id: string;
  tenant_id: string | null;
  category: string;
  rule_ar: string;
  source_call_id: string;
  confidence: number;
  active: number;
  created_at: number;
}

export interface LearningCandidate {
  category: "dialect" | "flow" | "objection" | "domain_faq";
  rule_ar: string;
  rationale?: string;
}

export interface LearningEvaluation {
  score_overall: number;
  candidate_learnings: LearningCandidate[];
}

let initialized = false;

async function ensureLearningTable(db: D1Database): Promise<void> {
  if (initialized) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS learnings (
      id TEXT PRIMARY KEY,
      tenant_id TEXT,
      category TEXT NOT NULL,
      rule_ar TEXT NOT NULL,
      source_call_id TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_learnings_active ON learnings(tenant_id, active, confidence DESC)")
  ]);
  initialized = true;
}

export async function fetchActiveLearnings(
  db: D1Database,
  tenantId: string,
  limit = 6
): Promise<string[]> {
  try {
    await ensureLearningTable(db);
    const result = await db.prepare(`
      SELECT rule_ar FROM learnings
      WHERE active = 1 AND (tenant_id = ? OR tenant_id IS NULL)
      ORDER BY confidence DESC, created_at DESC
      LIMIT ?
    `).bind(tenantId, Math.max(1, Math.min(12, Math.floor(limit)))).all<{ rule_ar: string }>();
    return (result.results ?? []).map((row) => String(row.rule_ar || "").trim()).filter(Boolean);
  } catch (error) {
    console.error("Conversation learnings could not be loaded:", error);
    return [];
  }
}

export async function persistCallEvaluationAndLearnings(
  db: D1Database,
  callId: string,
  tenantId: string,
  evaluation: LearningEvaluation
): Promise<void> {
  if (!Number.isFinite(evaluation.score_overall) || evaluation.score_overall < 75) return;
  await ensureLearningTable(db);
  for (const candidate of evaluation.candidate_learnings ?? []) {
    const rule = String(candidate.rule_ar ?? "").trim();
    if (rule.length < 10 || rule.length > 220) continue;
    const scopedTenant = candidate.category === "domain_faq" ? tenantId : null;
    await db.prepare(`
      INSERT INTO learnings (id, tenant_id, category, rule_ar, source_call_id, confidence, active, created_at)
      SELECT ?, ?, ?, ?, ?, ?, 1, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM learnings
        WHERE tenant_id IS ? AND category = ? AND rule_ar = ? AND active = 1
      )
    `).bind(
      crypto.randomUUID(),
      scopedTenant,
      candidate.category,
      rule,
      callId,
      evaluation.score_overall / 100,
      Date.now(),
      scopedTenant,
      candidate.category,
      rule
    ).run();
  }
}
