// ============================================================================
// Mizan Conversation Manager — D1 Database Access & Business Action Persistence
// ============================================================================
// Reconciled with the actual deployed Mizan Voice Gateway v2 D1 schema:
//   - `tenants` (keyed by `slug` across gateway tables)
//   - `call_sessions` (AES-GCM 256-bit `caller_name_enc`, `caller_phone_enc`,
//     `selected_doctor`, `selected_slot`, `booking_confirmed`, plus optional
//     conversation-manager columns from migration-002.sql)
//   - `call_turns` (`session_id`, `tenant_slug`, `turn_index`, `speaker`,
//     `transcript_redacted`, `latency_ms`)
//   - `learnings` (`id`, `tenant_id`, `source_call_id`, `text`, `source`,
//     `confidence`, `active`, `applied_count`, `created_at`)
//   - `crm_contacts` (`phone`, `tenant_id`, `title`, `name`, `gender`,
//     `total_calls`, `last_call_at`, `last_call_summary`, `preferences_json`,
//     `updated_at`, PRIMARY KEY (`phone`, `tenant_id`))
//   - `client_queries` (used for callbacks/tickets in portal)
// ============================================================================

import { encryptPII, redactPII } from "../crypto";
import { containsBannedAddress, type CallerGender } from "./guard";
import type { ActionRunResult, CallerType } from "./manager";
import { cleanPromptLine } from "./prompt";

export type LearningCategory =
  | "dialect"
  | "flow"
  | "objection"
  | "domain_faq"
  | "phrasing"
  | "ordering"
  | "pacing"
  | "recovery"
  | "confirmation"
  | "intent_detection";

export interface LearningCandidate {
  key?: string;
  category: LearningCategory;
  rule_ar: string;
  rationale?: string;
  confidence?: number;
  scope?: "global" | "tenant";
  applies_state?: string | null;
  applies_caller?: string | null;
}

export interface LearningEvaluation {
  score_overall: number;
  candidate_learnings: LearningCandidate[];
  call_summary_ar?: string;
  inferred_caller_first_name?: string;
  inferred_caller_gender?: CallerGender;
  inferred_caller_email?: string;
}

export const ALLOWED_LEARNING_SOURCES: readonly LearningCategory[] = [
  "dialect",
  "flow",
  "objection",
  "domain_faq",
  "phrasing",
  "ordering",
  "pacing",
  "recovery",
  "confirmation",
  "intent_detection"
] as const;

const FORBIDDEN_LEARNING_PATTERNS = [
  /(?:حضرتك|فندم|افندم|أفندم|باشا|بيه|هانم|سيادتك|سعادتك)/u,
  /\b(?:ماذا|لماذا|كيف\s+يمكن|سوف\s+أ|يسعدني)\b/u,
  /(?:ادّعي|تظاهر|اكذب|اخفِ|أخفِ|بدون\s+تأكيد|تجاهل\s+التأكيد)/iu,
  /(?:اختلق|اخترع|قدّر|افترض)\s+(?:سعر|سياسة|رسوم|تكلفة)/iu,
  /(?:هذا\s+البرومبت|النظام\s+البرومبت|تجاهل\s+التعليمات|ignore\s+previous)/iu,
  /(?:\b01[0125]\d{8}\b|\b\d{14}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/iu
];

export function isSafeLearning(value: string): boolean {
  const cleaned = String(value ?? "").trim();
  if (cleaned.length < 10 || cleaned.length > 260) return false;
  if (/[<>]/u.test(cleaned)) return false;
  if (containsBannedAddress(cleaned)) return false;
  return !FORBIDDEN_LEARNING_PATTERNS.some((rx) => rx.test(cleaned));
}

/**
 * Load active tenant-scoped (and optional global) learnings from D1 `learnings`.
 */
export async function fetchActiveLearnings(
  db: D1Database,
  tenantId: string,
  limit = 6
): Promise<string[]> {
  try {
    const placeholders = ALLOWED_LEARNING_SOURCES.map(() => "?").join(", ");
    const safeLimit = Math.max(1, Math.min(24, Math.floor(limit)));
    const result = await db
      .prepare(
        `SELECT text, tenant_id, confidence
         FROM learnings
         WHERE active = 1
           AND (tenant_id = ? OR tenant_id = 'global')
           AND confidence >= 0.55
           AND source IN (${placeholders})
         ORDER BY
           CASE WHEN tenant_id = ? THEN 0 ELSE 1 END,
           confidence DESC,
           applied_count DESC,
           created_at DESC
         LIMIT ?`
      )
      .bind(tenantId, ...ALLOWED_LEARNING_SOURCES, tenantId, safeLimit * 2)
      .all<{ text: string; tenant_id: string; confidence: number }>();

    const seen = new Set<string>();
    const out: string[] = [];
    for (const row of result.results ?? []) {
      const rule = redactPII(String(row.text || "").trim());
      if (!isSafeLearning(rule)) continue;
      if (seen.has(rule)) continue;
      seen.add(rule);
      out.push(rule);
      if (out.length >= safeLimit) break;
    }
    return out;
  } catch (error) {
    console.error("Conversation learnings could not be loaded:", error);
    return [];
  }
}

/**
 * Persist call evaluation learnings into D1 `learnings`.
 * Reconciled with the existing `learnings` schema:
 *   (id, tenant_id, source_call_id, text, source, confidence, active, applied_count, created_at)
 * If an identical active learning already exists for (tenant_id, source, text),
 * bumps `applied_count` and takes `MAX(confidence, newConfidence)`.
 */
export async function persistCallEvaluationAndLearnings(
  db: D1Database,
  callId: string,
  tenantId: string,
  evaluation: LearningEvaluation
): Promise<{ accepted: number; rejected: number }> {
  let accepted = 0;
  let rejected = 0;

  if (!Number.isFinite(evaluation.score_overall) || evaluation.score_overall < 60) {
    return { accepted: 0, rejected: (evaluation.candidate_learnings ?? []).length };
  }

  for (const candidate of evaluation.candidate_learnings ?? []) {
    const rule = redactPII(String(candidate.rule_ar ?? "").trim());
    const category = candidate.category;
    const rawConf =
      typeof candidate.confidence === "number" && Number.isFinite(candidate.confidence)
        ? candidate.confidence
        : evaluation.score_overall / 100;
    const confidence = Math.max(0, Math.min(1, rawConf));

    if (
      !ALLOWED_LEARNING_SOURCES.includes(category) ||
      confidence < 0.5 ||
      !isSafeLearning(rule)
    ) {
      rejected++;
      continue;
    }

    const existing = await db
      .prepare(
        `SELECT id, confidence, applied_count
         FROM learnings
         WHERE tenant_id = ? AND source = ? AND text = ? AND active = 1
         LIMIT 1`
      )
      .bind(tenantId, category, rule)
      .first<{ id: string; confidence: number; applied_count: number }>();

    if (existing?.id) {
      const nextConf = Math.max(Number(existing.confidence ?? 0.5), confidence);
      await db
        .prepare(
          `UPDATE learnings
           SET applied_count = COALESCE(applied_count, 0) + 1,
               confidence = ?,
               source_call_id = ?
           WHERE id = ? AND tenant_id = ?`
        )
        .bind(nextConf, callId, existing.id, tenantId)
        .run();
      accepted++;
      continue;
    }

    await db
      .prepare(
        `INSERT INTO learnings (
           id, tenant_id, source_call_id, text, source,
           confidence, active, applied_count, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        callId,
        rule,
        category,
        confidence,
        Date.now()
      )
      .run();
    accepted++;
  }

  return { accepted, rejected };
}

// ---------------------------------------------------------------------------
// CRM Contact Lookup & Upsert (reconciled with deployed `crm_contacts` table)
// ---------------------------------------------------------------------------

export interface CrmContactRecord {
  phone: string;
  tenant_id: string;
  title: string | null;
  name: string | null;
  gender: CallerGender;
  total_calls: number;
  last_call_at: number | null;
  last_call_summary: string | null;
  preferences_json: string | null;
}

export async function lookupCaller(
  db: D1Database,
  tenantId: string,
  phone: string
): Promise<{ callerType: CallerType; crm: CrmContactRecord } | null> {
  if (!tenantId || !phone) return null;
  try {
    const row = await db
      .prepare(
        `SELECT phone, tenant_id, title, name, gender, total_calls,
                last_call_at, last_call_summary, preferences_json
         FROM crm_contacts
         WHERE tenant_id = ? AND phone = ?
         LIMIT 1`
      )
      .bind(tenantId, phone)
      .first<CrmContactRecord>();

    if (!row) return null;
    const gender: CallerGender =
      row.gender === "male" || row.gender === "female" ? row.gender : "unknown";
    return {
      callerType: "returning_customer",
      crm: {
        ...row,
        gender
      }
    };
  } catch (error) {
    console.error("CRM caller lookup failed:", error);
    return null;
  }
}

export async function upsertCrmContact(
  db: D1Database,
  tenantId: string,
  phone: string,
  update: {
    title?: string | null;
    name?: string | null;
    gender?: CallerGender;
    lastSummary?: string | null;
    lastCallAt?: number;
    email?: string | null;
  }
): Promise<void> {
  if (!tenantId || !phone || !/^01[0125]\d{8}$/u.test(phone)) return;
  try {
    const safeTitle = update.title ? cleanPromptLine(update.title, 30) : null;
    const safeName = update.name ? cleanPromptLine(update.name, 60) : null;
    const safeGender: CallerGender =
      update.gender === "male" || update.gender === "female" ? update.gender : "unknown";
    const safeSummary = update.lastSummary
      ? redactPII(cleanPromptLine(update.lastSummary, 300))
      : null;
    const nowSec = update.lastCallAt ?? Math.floor(Date.now() / 1000);
    const prefsJson = update.email
      ? JSON.stringify({ email: cleanPromptLine(update.email.toLowerCase(), 120) })
      : null;

    await db
      .prepare(
        `INSERT INTO crm_contacts (
           phone, tenant_id, title, name, gender, total_calls,
           last_call_at, last_call_summary, preferences_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
         ON CONFLICT(phone, tenant_id) DO UPDATE SET
           title = COALESCE(excluded.title, crm_contacts.title),
           name = COALESCE(excluded.name, crm_contacts.name),
           gender = CASE WHEN excluded.gender != 'unknown' THEN excluded.gender ELSE crm_contacts.gender END,
           total_calls = COALESCE(crm_contacts.total_calls, 0) + 1,
           last_call_at = COALESCE(excluded.last_call_at, crm_contacts.last_call_at),
           last_call_summary = COALESCE(excluded.last_call_summary, crm_contacts.last_call_summary),
           preferences_json = COALESCE(excluded.preferences_json, crm_contacts.preferences_json),
           updated_at = excluded.updated_at`
      )
      .bind(
        phone,
        tenantId,
        safeTitle,
        safeName,
        safeGender,
        nowSec,
        safeSummary,
        prefsJson,
        nowSec
      )
      .run();
  } catch (error) {
    console.error("CRM contact upsert failed:", error);
  }
}

// ---------------------------------------------------------------------------
// Call Transcript Loading (reconciled with `call_turns` table)
// ---------------------------------------------------------------------------

export interface StoredCallTurn {
  turn_index: number;
  speaker: "caller" | "agent";
  transcript_redacted: string;
  latency_ms: number | null;
  created_at: number;
}

export async function loadCallTranscript(
  db: D1Database,
  sessionId: string,
  tenantSlug: string
): Promise<StoredCallTurn[]> {
  try {
    const res = await db
      .prepare(
        `SELECT turn_index, speaker, transcript_redacted, latency_ms, created_at
         FROM call_turns
         WHERE session_id = ? AND tenant_slug = ?
         ORDER BY turn_index ASC`
      )
      .bind(sessionId, tenantSlug)
      .all<StoredCallTurn>();
    return res.results ?? [];
  } catch (error) {
    console.error("Could not load call transcript from call_turns:", error);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Business Action Execution (D1 + Optional Signed HTTPS Webhook)
// ---------------------------------------------------------------------------

async function hmacSignHex(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function executeTenantBusinessAction(opts: {
  db: D1Database;
  sessionId: string;
  tenantSlug: string;
  action: string;
  slots: Record<string, string>;
  idempotencyKey: string;
  contactEncKey?: string;
  webhookUrl?: string | null;
  webhookSecret?: string | null;
}): Promise<ActionRunResult> {
  const { db, sessionId, tenantSlug, action, slots, idempotencyKey, contactEncKey } = opts;
  const callerName = (slots.name || "").trim();
  const callerPhone = (slots.phone || "").trim();

  // Hard guard: never execute a booking/callback/ticket action without a validated Egyptian mobile number (REG-01/REG-02)
  if (!/^01[0125]\d{8}$/u.test(callerPhone)) {
    return {
      ok: false,
      detail: "Invalid or missing 11-digit Egyptian mobile number."
    };
  }
  if (callerName.length < 2) {
    return {
      ok: false,
      detail: "Missing caller name."
    };
  }

  let nameEnc: string | null = null;
  let phoneEnc: string | null = null;
  if (contactEncKey && contactEncKey.trim()) {
    try {
      nameEnc = await encryptPII(callerName, { CONTACT_ENC_KEY: contactEncKey });
      phoneEnc = await encryptPII(callerPhone, { CONTACT_ENC_KEY: contactEncKey });
    } catch (encError) {
      console.error("PII encryption failed during action execution:", encError);
      return { ok: false, detail: "Failed to encrypt caller contact data." };
    }
  }

  try {
    if (action === "book_appointment") {
      const dateStr = (slots.date || "").trim();
      const timeStr = (slots.time || "").trim();
      if (!dateStr || !timeStr) {
        return { ok: false, detail: "Missing appointment date or time." };
      }
      const selectedSlot = `${dateStr} ${timeStr}`;
      const selectedDoctor = slots.doctor ? cleanPromptLine(slots.doctor, 80) : null;

      const updateResult = await db
        .prepare(
          `UPDATE call_sessions
           SET caller_name_enc = COALESCE(?, caller_name_enc),
               caller_phone_enc = COALESCE(?, caller_phone_enc),
               selected_doctor = COALESCE(?, selected_doctor),
               selected_slot = ?,
               booking_confirmed = 0
           WHERE id = ? AND tenant_slug = ?`
        )
        .bind(nameEnc, phoneEnc, selectedDoctor, selectedSlot, sessionId, tenantSlug)
        .run();
      const changes = (updateResult as { meta?: { changes?: number }; changes?: number }).meta?.changes
        ?? (updateResult as { changes?: number }).changes ?? 0;
      if (changes < 1) return { ok: false, detail: "Call session does not exist or is not owned by this tenant." };

      await upsertCrmContact(db, tenantSlug, callerPhone, {
        name: callerName,
        email: slots.email ?? null,
        lastSummary: `حجز موعد يوم ${dateStr} الساعة ${timeStr}${selectedDoctor ? ` مع ${selectedDoctor}` : ""}`
      });
    } else if (action === "request_callback" || action === "create_ticket") {
      const subject = action === "request_callback" ? "طلب معاودة اتصال" : "شكوى عميل";
      const detailText = cleanPromptLine(slots.topic || slots.issue || subject, 300);

      const updateResult = await db
        .prepare(
          `UPDATE call_sessions
           SET caller_name_enc = COALESCE(?, caller_name_enc),
               caller_phone_enc = COALESCE(?, caller_phone_enc),
               selected_slot = ?
           WHERE id = ? AND tenant_slug = ?`
        )
        .bind(nameEnc, phoneEnc, `${subject}: ${detailText.slice(0, 80)}`, sessionId, tenantSlug)
        .run();
      const changes = (updateResult as { meta?: { changes?: number }; changes?: number }).meta?.changes
        ?? (updateResult as { changes?: number }).changes ?? 0;
      if (changes < 1) return { ok: false, detail: "Call session does not exist or is not owned by this tenant." };

      // Also record in `client_queries` if the table exists in D1
      try {
        const nowIso = new Date().toISOString();
        await db
          .prepare(
            `INSERT INTO client_queries (
               id, client_name, client_email, subject, message, status,
               created_at, updated_at, tenant_id, client_phone
             ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`
          )
          .bind(
            crypto.randomUUID(),
            "متصل مسجل — راجع سجل المكالمة",
            null,
            subject,
            redactPII(detailText),
            nowIso,
            nowIso,
            tenantSlug,
            "[مشفر في سجل المكالمة]"
          )
          .run();
      } catch (error) {
        if (action === "create_ticket") return { ok: false, detail: "Ticket table unavailable; request noted in call session only." };
        // A callback remains tracked in the call session even without a separate ticket record.
      }

      await upsertCrmContact(db, tenantSlug, callerPhone, {
        name: callerName,
        email: slots.email ?? null,
        lastSummary: `${subject}: ${detailText}`
      });
    } else {
      return { ok: false, detail: `Unsupported action "${action}".` };
    }
  } catch (dbErr) {
    console.error("D1 action execution failed:", dbErr);
    return { ok: false, detail: "Database error while recording the request." };
  }

  // A provider must return an explicit confirmation receipt; HTTP 2xx alone only means accepted.
  let providerConfirmed = false;
  if (opts.webhookUrl) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(opts.webhookUrl);
      if (parsedUrl.protocol !== "https:") {
        return action === "book_appointment" ? { ok: true, bookingConfirmed: false, detail: "Appointment request saved; confirmation unavailable." }
          : { ok: false, detail: "Webhook URL must use HTTPS." };
      }
    } catch {
      return action === "book_appointment" ? { ok: true, bookingConfirmed: false, detail: "Appointment request saved; confirmation unavailable." }
        : { ok: false, detail: "Webhook URL is invalid." };
    }

    const body = JSON.stringify({
      callId: sessionId,
      tenantSlug,
      action,
      slots,
      idempotencyKey
    });
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-idempotency-key": idempotencyKey
    };
    if (opts.webhookSecret) {
      headers["x-mizan-signature"] = await hmacSignHex(body, opts.webhookSecret);
    }

    try {
      const res = await fetch(parsedUrl.toString(), {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) {
        return action === "book_appointment"
          ? { ok: true, bookingConfirmed: false, detail: "Appointment request saved locally; confirmation is pending." }
          : { ok: false, detail: `Webhook returned HTTP ${res.status}.` };
      }
      if (action === "book_appointment") {
        const receipt = await res.json().catch(() => null);
        providerConfirmed = Boolean(receipt && typeof receipt === "object" &&
          "confirmed" in receipt && receipt.confirmed === true &&
          "confirmation_id" in receipt && typeof receipt.confirmation_id === "string" && receipt.confirmation_id.length > 0);
      }
    } catch {
      return action === "book_appointment"
        ? { ok: true, bookingConfirmed: false, detail: "Appointment request saved locally; confirmation is pending." }
        : { ok: false, detail: "Could not reach tenant action webhook." };
    }
    if (action === "book_appointment" && providerConfirmed) {
      const confirmation = await db.prepare(
        `UPDATE call_sessions SET booking_confirmed = 1 WHERE id = ? AND tenant_slug = ?`
      ).bind(sessionId, tenantSlug).run();
      const changes = (confirmation as { meta?: { changes?: number }; changes?: number }).meta?.changes
        ?? (confirmation as { changes?: number }).changes ?? 0;
      if (changes < 1) return { ok: false, detail: "Confirmation could not be persisted." };
    }
  }

  const summaryDetail =
    action === "book_appointment"
      ? providerConfirmed
        ? `Appointment confirmed by provider for ${slots.date} at ${slots.time}.`
        : `Appointment request saved for ${slots.date} at ${slots.time}; confirmation is pending.`
      : action === "request_callback"
        ? "Callback request registered."
        : "Support ticket created.";

  return { ok: true, detail: summaryDetail, ...(action === "book_appointment" ? { bookingConfirmed: providerConfirmed } : {}) };
}

/**
 * Persist conversation-manager metadata on `call_sessions` when a call ends.
 * Gracefully falls back if migration-002 columns have not yet been applied.
 */
export async function updateCallSessionOutcome(
  db: D1Database,
  sessionId: string,
  tenantSlug: string,
  meta: {
    intentId?: string | null;
    intentResolved?: boolean;
    handedOff?: boolean;
    endReason?: string;
    totalTurns?: number;
    honorificHits?: number;
    msaHits?: number;
    llmErrors?: number;
    evaluationScore?: number;
    summaryAr?: string | null;
  }
): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE call_sessions
         SET intent_id = COALESCE(?, intent_id),
             intent_resolved = COALESCE(?, intent_resolved),
             handed_off = COALESCE(?, handed_off),
             end_reason = COALESCE(?, end_reason),
             total_turns = COALESCE(?, total_turns),
             honorific_hits = COALESCE(?, honorific_hits),
             msa_hits = COALESCE(?, msa_hits),
             llm_errors = COALESCE(?, llm_errors),
             evaluation_score = COALESCE(?, evaluation_score),
             summary_ar = COALESCE(?, summary_ar)
         WHERE id = ? AND tenant_slug = ?`
      )
      .bind(
        meta.intentId ?? null,
        typeof meta.intentResolved === "boolean" ? (meta.intentResolved ? 1 : 0) : null,
        typeof meta.handedOff === "boolean" ? (meta.handedOff ? 1 : 0) : null,
        meta.endReason ?? null,
        meta.totalTurns ?? null,
        meta.honorificHits ?? null,
        meta.msaHits ?? null,
        meta.llmErrors ?? null,
        meta.evaluationScore ?? null,
        meta.summaryAr ? redactPII(cleanPromptLine(meta.summaryAr, 300)) : null,
        sessionId,
        tenantSlug
      )
      .run();
  } catch {
    // Extended columns in migration-002 are optional at runtime if migration was not yet run
  }
}
