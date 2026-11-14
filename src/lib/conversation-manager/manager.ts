// ============================================================================
// Mizan Conversation Manager — State Machine, Slot Validation & Tool Executor
// ============================================================================
// Pure TypeScript state machine ported from the Mizan Conversation Manager archive
// and adapted for Mizan Voice Gateway v2 (Cloudflare Agents SDK + D1).
//
// DIVISION OF LABOUR:
//   Code: owns state, validates data, enforces transition & confirmation guards,
//         accumulates chunked Egyptian mobile digits, and executes side-effects.
//   LLM : decides what to say and which tool to call; cannot move the call into
//         a state the guards disallow, cannot confirm data on the same turn it
//         was collected, and cannot pass unvalidated parameters to perform_action.
// ============================================================================

import { isProceduralPhrase, stripMarks, type CallerGender } from "./guard";

export type CallState = "GREETING" | "DATA_COLLECTION" | "ACTION" | "CLOSING" | "ENDED";
export type CallerType = "new_lead" | "returning_customer" | "unknown";
export type Gender = CallerGender;
export type Arm = "treated" | "holdout" | "disabled";
export type EndReason = "agent_end" | "caller_hangup" | "handoff" | "idle_timeout" | "max_duration" | "error";

export type ValidatorName = "text" | "phone_eg" | "email" | "date_iso" | "time_hhmm";

export interface SlotSpec {
  name: string;
  label: string;
  required: boolean;
  validator: ValidatorName;
  needsConfirm?: boolean;
  prefill?: "caller_id" | "crm_name" | "crm_email";
  carryOver?: boolean;
}

export interface IntentSpec {
  id: string;
  label: string;
  action: string | null;
  slots: SlotSpec[];
}

export interface CallContext {
  callId: string;
  tenantId: string;
  direction: "inbound" | "outbound";
  callerPhone: string | null;
  callerType: CallerType;
  caller: {
    firstName: string | null;
    title?: string | null;
    gender: Gender;
    lastSummary: string | null;
    lastCallAt: number | null;
    email?: string | null;
  };
  business: {
    name: string;
    agentName: string;
    agentGender: "male" | "female";
    hours: string | null;
    knowledge: string | null;
    handoffNumber: string | null;
    industry?: string;
  };
  clock: {
    todayIso: string;
    weekday: string;
    localTime: string;
    timezone: string;
    greetingWord: string;
  };
}

export interface CallMetrics {
  honorificHits: number;
  msaHits: number;
  llmErrors: number;
  llmConsecutive: number;
  slotRejections: number;
  bargeIns: number;
}

export interface SlotValue {
  value: string;
  confirmed: boolean;
  source: "caller" | "caller_id" | "crm";
  setAtTurn: number;
}

export interface Session {
  state: CallState;
  intent: string | null;
  intentFresh: boolean;
  slots: Record<string, SlotValue>;
  slotFailures: Record<string, number>;
  actionResult: ActionRunResult | null;
  actionCache: Record<string, ActionRunResult>;
  totalTurns: number;
  turnsInState: number;
  trace: Array<{ state: CallState; atTurn: number; ts: number; via: "init" | "auto" | "model" }>;
  endRequest: { reason: string } | null;
  handoff: { reason: string; sent: boolean } | null;
  pendingPhoneDigits: string;
  emergencyDetected: boolean;
}

export function newSession(): Session {
  return {
    state: "GREETING",
    intent: null,
    intentFresh: false,
    slots: {},
    slotFailures: {},
    actionResult: null,
    actionCache: {},
    totalTurns: 0,
    turnsInState: 0,
    trace: [{ state: "GREETING", atTurn: 0, ts: Date.now(), via: "init" }],
    endRequest: null,
    handoff: null,
    pendingPhoneDigits: "",
    emergencyDetected: false
  };
}

// ---------------------------------------------------------------------------
// Default intent catalogue (tenants can override via configuration)
// ---------------------------------------------------------------------------
const NAME: SlotSpec = {
  name: "name",
  label: "caller's first name",
  required: true,
  validator: "text",
  prefill: "crm_name",
  carryOver: true
};

const PHONE: SlotSpec = {
  name: "phone",
  label: "mobile number",
  required: true,
  validator: "phone_eg",
  needsConfirm: true,
  prefill: "caller_id",
  carryOver: true
};

export const DEFAULT_INTENTS: IntentSpec[] = [
  {
    id: "book_appointment",
    label: "book an appointment / consultation",
    action: "book_appointment",
    slots: [
      NAME,
      PHONE,
      { name: "date", label: "preferred date (YYYY-MM-DD)", required: true, validator: "date_iso", needsConfirm: true },
      { name: "time", label: "preferred time (HH:MM, 24h)", required: true, validator: "time_hhmm", needsConfirm: true },
      { name: "doctor", label: "preferred doctor or specialty — OPTIONAL", required: false, validator: "text" },
      {
        name: "email",
        label: "email — OPTIONAL, only if the caller offers it",
        required: false,
        validator: "email",
        needsConfirm: true,
        prefill: "crm_email",
        carryOver: true
      }
    ]
  },
  {
    id: "callback_request",
    label: "wants a human to call them back",
    action: "request_callback",
    slots: [
      NAME,
      PHONE,
      { name: "topic", label: "what the callback is about (short)", required: true, validator: "text" }
    ]
  },
  {
    id: "complaint",
    label: "complaint or problem with a previous service",
    action: "create_ticket",
    slots: [
      NAME,
      PHONE,
      { name: "issue", label: "one-sentence description of the problem", required: true, validator: "text" }
    ]
  },
  {
    id: "inquiry",
    label: "general question about the business",
    action: null,
    slots: []
  }
];

// ---------------------------------------------------------------------------
// Slot validation & normalization
// ---------------------------------------------------------------------------

const ARABIC_SPOKEN_DIGITS: Array<[RegExp, string]> = [
  [/(?:^|\s)(?:صفر|زيرو)(?=$|\s|[،,.])/gu, " 0 "],
  [/(?:^|\s)واحد(?=$|\s|[،,.])/gu, " 1 "],
  [/(?:^|\s)(?:اتنين|إتنين|اثنين)(?=$|\s|[،,.])/gu, " 2 "],
  [/(?:^|\s)(?:تلاتة|تلاته|ثلاثة)(?=$|\s|[،,.])/gu, " 3 "],
  [/(?:^|\s)(?:أربعة|اربعة|اربعه|أربعه)(?=$|\s|[،,.])/gu, " 4 "],
  [/(?:^|\s)(?:خمسة|خمسه)(?=$|\s|[،,.])/gu, " 5 "],
  [/(?:^|\s)(?:ستة|سته)(?=$|\s|[،,.])/gu, " 6 "],
  [/(?:^|\s)(?:سبعة|سبعه)(?=$|\s|[،,.])/gu, " 7 "],
  [/(?:^|\s)(?:تمانية|تمانيه|ثمانية)(?=$|\s|[،,.])/gu, " 8 "],
  [/(?:^|\s)(?:تسعة|تسعه)(?=$|\s|[،,.])/gu, " 9 "]
];

export function normalizeDigits(s: string): string {
  return String(s ?? "").replace(/[\u0660-\u0669\u06F0-\u06F9]/gu, (d) => {
    const c = d.charCodeAt(0);
    return String(c - (c >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

export function normalizeSpokenAndIndicDigits(s: string): string {
  let out = normalizeDigits(stripMarks(String(s ?? "")));
  for (const [rx, digit] of ARABIC_SPOKEN_DIGITS) {
    out = out.replace(rx, digit);
  }
  return out;
}

const VALIDATORS: Record<ValidatorName, (raw: string, todayIso: string) => string | null> = {
  text: (v) => {
    const t = String(v ?? "").trim().replace(/\s+/gu, " ");
    return t.length >= 2 && t.length <= 160 ? t : null;
  },
  phone_eg: (v) => {
    // Egyptian mobiles: 010/011/012/015 + 8 digits (11 digits total)
    let d = normalizeDigits(v).replace(/[^\d+]/gu, "");
    d = d.replace(/^(\+20|0020|20)/u, "0");
    if (/^1[0125]\d{8}$/u.test(d)) d = "0" + d;
    return /^01[0125]\d{8}$/u.test(d) ? d : null;
  },
  email: (v) => {
    const e = String(v ?? "").trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/u.test(e) ? e : null;
  },
  date_iso: (v, todayIso) => {
    const d = normalizeDigits(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(d)) return null;
    const parsed = new Date(`${d}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) return null;
    return d >= todayIso ? d : null;
  },
  time_hhmm: (v) => {
    const m = normalizeDigits(v).trim().match(/^(\d{1,2}):(\d{2})$/u);
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    return h <= 23 && mi <= 59 ? `${String(h).padStart(2, "0")}:${m[2]}` : null;
  }
};

export function validateSlot(
  validator: ValidatorName,
  raw: string,
  todayIso: string,
  slotName?: string
): string | null {
  const val = VALIDATORS[validator](raw, todayIso);
  if (!val) return null;
  if (slotName === "name" && isProceduralPhrase(val)) {
    return null;
  }
  return val;
}

/**
 * Cross-turn Egyptian mobile number accumulator (REG-01 / REG-02).
 * Handles callers speaking 11-digit Egyptian mobile numbers across multiple turns
 * (e.g. "010" -> "1234" -> "5678") and returns the validated 11-digit number once complete.
 */
export function accumulatePhoneDigits(session: Session, utterance: string): string | null {
  const normalized = normalizeSpokenAndIndicDigits(utterance);
  // Check if utterance already contains a full Egyptian mobile number
  const directMatch = normalized.replace(/[^\d+]/gu, "");
  const directValid = validateSlot("phone_eg", directMatch, "");
  if (directValid) {
    session.pendingPhoneDigits = "";
    return directValid;
  }

  // Extract digit runs from the utterance (excluding obvious time/year patterns like "الساعة 4" or "2026")
  const withoutTimes = normalized
    .replace(/الساعة\s*\d{1,2}(?::\d{2})?/gu, "")
    .replace(/\b202\d-\d{2}-\d{2}\b/gu, "");
  const rawDigits = withoutTimes.replace(/\D+/gu, "");
  if (!rawDigits) return null;

  let combined = session.pendingPhoneDigits + rawDigits;
  combined = combined.replace(/^(?:0020|20)/u, "0");
  if (/^1[0125]/u.test(combined)) combined = "0" + combined;

  // Only buffer if it starts with a valid Egyptian mobile prefix (0, 01, 010, 011, 012, 015)
  const prefixIdx = combined.search(/01[0125]|^01?$|^0$/u);
  if (prefixIdx > 0) {
    combined = combined.slice(prefixIdx);
  }
  if (!/^(?:0|01|01[0125]\d{0,8})$/u.test(combined)) {
    // If latest chunk itself starts a new mobile prefix, reset buffer to latest chunk
    const fresh = rawDigits.replace(/^1([0125])/u, "01$1");
    if (/^(?:0|01|01[0125]\d{0,8})$/u.test(fresh)) {
      session.pendingPhoneDigits = fresh;
      return fresh.length === 11 ? validateSlot("phone_eg", fresh, "") : null;
    }
    return null;
  }

  if (combined.length === 11) {
    const valid = validateSlot("phone_eg", combined, "");
    if (valid) {
      session.pendingPhoneDigits = "";
      return valid;
    }
  }

  session.pendingPhoneDigits = combined.slice(0, 11);
  return null;
}

// ---------------------------------------------------------------------------
// State machine transitions & guards
// ---------------------------------------------------------------------------
const specOf = (s: Session, intents: IntentSpec[]): IntentSpec | null =>
  intents.find((i) => i.id === s.intent) ?? null;

export const getMissingRequiredSlots = (s: Session, sp: IntentSpec): SlotSpec[] =>
  sp.slots.filter((x) => x.required && !s.slots[x.name]);

export const getAwaitingConfirmSlots = (s: Session, sp: IntentSpec): SlotSpec[] =>
  sp.slots.filter((x) => x.needsConfirm && s.slots[x.name] && !s.slots[x.name].confirmed);

function go(s: Session, to: CallState, via: "auto" | "model"): void {
  if (to === s.state) return;
  if (to === "DATA_COLLECTION") s.actionResult = null;
  if (to === "CLOSING") s.intentFresh = false;
  s.state = to;
  s.turnsInState = 0;
  s.trace.push({ state: to, atTurn: s.totalTurns, ts: Date.now(), via });
}

/** Deterministic transitions enforced by code. */
export function autoAdvance(s: Session, intents: IntentSpec[]): CallState[] {
  const moved: CallState[] = [];
  for (let i = 0; i < 3; i++) {
    const sp = specOf(s, intents);
    let next: CallState | null = null;
    if (s.state === "GREETING" && sp) {
      next = "DATA_COLLECTION";
    } else if (
      s.state === "DATA_COLLECTION" &&
      sp &&
      getMissingRequiredSlots(s, sp).length === 0 &&
      getAwaitingConfirmSlots(s, sp).length === 0
    ) {
      next = "ACTION";
    } else if (s.state === "ACTION" && s.actionResult?.ok) {
      next = "CLOSING";
    }
    if (!next) break;
    go(s, next, "auto");
    moved.push(next);
  }
  return moved;
}

export const MANUAL: Record<CallState, CallState[]> = {
  GREETING: ["CLOSING"],
  DATA_COLLECTION: ["CLOSING"],
  ACTION: ["DATA_COLLECTION", "CLOSING"],
  CLOSING: ["DATA_COLLECTION"],
  ENDED: []
};

export function markHandoff(s: Session, reason: string): void {
  s.handoff = { reason, sent: false };
  go(s, "ENDED", "model");
}

export function markEnd(s: Session, reason: string): void {
  s.endRequest = { reason };
  go(s, "ENDED", "model");
}

function setIntent(s: Session, ctx: CallContext, intents: IntentSpec[], id: string): string | null {
  const sp = intents.find((i) => i.id === id);
  if (!sp) return `Unknown intent "${id}". Valid: ${intents.map((i) => i.id).join(", ")}.`;
  if (s.intent === id && s.state !== "CLOSING") return null;

  const keep = new Set(sp.slots.filter((x) => x.carryOver).map((x) => x.name));
  for (const k of Object.keys(s.slots)) {
    if (!keep.has(k)) delete s.slots[k];
  }
  s.slotFailures = {};
  s.intent = id;
  s.intentFresh = true;
  s.actionResult = null;

  for (const slot of sp.slots) {
    if (s.slots[slot.name] || !slot.prefill) continue;
    const raw =
      slot.prefill === "caller_id"
        ? ctx.callerPhone
        : slot.prefill === "crm_name"
          ? ctx.caller.firstName
          : slot.prefill === "crm_email"
            ? ctx.caller.email ?? null
            : null;
    const val = raw ? validateSlot(slot.validator, raw, ctx.clock.todayIso, slot.name) : null;
    if (val) {
      s.slots[slot.name] = {
        value: val,
        confirmed: !slot.needsConfirm,
        source: slot.prefill === "caller_id" ? "caller_id" : "crm",
        setAtTurn: s.totalTurns
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// <live_state> — re-rendered every turn so the model knows its exact objective
// ---------------------------------------------------------------------------
const OBJECTIVE: Record<CallState, string> = {
  GREETING:
    "Open warmly and find out why they called. Collect no personal data yet. As soon as the reason is clear → update_slots(intent=…).",
  DATA_COLLECTION:
    "Collect ONLY the missing items, one per turn. Read back flagged items once. Never re-ask known items.",
  ACTION:
    "Execute the request: acknowledge briefly → perform_action → explain the real outcome with details needed by the caller.",
  CLOSING:
    "Recap the verified result naturally. If the caller is done or declines, thank them and end_call without asking another question.",
  ENDED: "The call is over. Say nothing more."
};

const SOFT_LIMIT: Record<CallState, number> = {
  GREETING: 3,
  DATA_COLLECTION: 12,
  ACTION: 4,
  CLOSING: 4,
  ENDED: 0
};

export function renderLiveState(s: Session, ctx: CallContext, intents: IntentSpec[] = DEFAULT_INTENTS): string {
  const sp = specOf(s, intents);
  const openInquiry = Boolean(sp && !sp.action && s.state !== "ENDED");
  const L: string[] = [
    "<live_state>",
    `TODAY: ${ctx.clock.todayIso} (${ctx.clock.weekday}) · LOCAL_TIME: ${ctx.clock.localTime} ${ctx.clock.timezone}`,
    `CURRENT_STATE: ${s.state}`,
    `OBJECTIVE: ${openInquiry ? "Answer the caller's current question using business knowledge. Continue explanations and examples naturally; do not collect contact details or close unless the caller is done." : OBJECTIVE[s.state]}`
  ];

  if (s.emergencyDetected) {
    L.push(
      "EMERGENCY_ALERT: Critical medical emergency detected. Immediately instruct the caller to dial emergency ambulance 123 (or escalate) and DO NOT ask for booking data."
    );
  }

  if (s.state === "GREETING") {
    L.push("KNOWN_INTENTS: " + intents.map((i) => `${i.id} (${i.label})`).join("; "));
  }

  if (sp) {
    L.push(`INTENT: ${sp.id}`);
    const known = sp.slots.filter((x) => s.slots[x.name]);
    if (known.length) {
      L.push(
        "KNOWN (never ask again): " +
          known
            .map((x) => `${x.name}="${s.slots[x.name].value}"${s.slots[x.name].confirmed ? " ✓" : ""}`)
            .join(", ")
      );
    }
    const missing = getMissingRequiredSlots(s, sp);
    if (s.state === "DATA_COLLECTION") {
      L.push("MISSING (ask in this order): " + (missing.map((x) => `${x.name} — ${x.label}`).join("; ") || "none"));
      if (s.pendingPhoneDigits) {
        L.push(
          `PARTIAL_PHONE_DIGITS_COLLECTED: "${s.pendingPhoneDigits}" (${s.pendingPhoneDigits.length}/11 digits — ask caller for the remaining ${11 - s.pendingPhoneDigits.length} digits only)`
        );
      }
      const aw = getAwaitingConfirmSlots(s, sp);
      if (aw.length) {
        L.push(
          "AWAITING_CONFIRMATION: " +
            aw
              .map(
                (x) =>
                  `${x.name}="${s.slots[x.name].value}" (${
                    s.slots[x.name].source === "caller_id"
                      ? "from caller ID — ask whether to use it"
                      : "read back once"
                  })`
              )
              .join("; ")
        );
      }
      const failed = Object.entries(s.slotFailures).map(
        ([k, n]) => `${k} (${n}×${n >= 2 ? " → CHANGE STRATEGY" : ""})`
      );
      if (failed.length) L.push("FAILED_VALIDATION: " + failed.join(", "));
    }
    if (s.state === "ACTION") {
      L.push(
        sp.action
          ? `ACTION: ${sp.action} (call perform_action)`
          : "ACTION: none — answer from <business_knowledge>; keep the conversation open for follow-up questions"
      );
    }
  }

  if (s.actionResult) {
    L.push(`LAST_ACTION_RESULT: ${s.actionResult.ok ? "OK" : "FAILED"} — ${s.actionResult.detail}`);
    if (s.intent === "book_appointment") L.push(`BOOKING_CONFIRMED: ${s.actionResult.bookingConfirmed === true ? "YES" : "NO — request only, pending confirmation"}`);
  }
  L.push(`TURNS_IN_STATE: ${s.turnsInState}${openInquiry ? " (open inquiry; no collection deadline)" : ` (soft limit ${SOFT_LIMIT[s.state]})`}`);
  if (!openInquiry && s.turnsInState > SOFT_LIMIT[s.state] && s.state !== "ENDED") {
    L.push(
      "STALLED: too long in this state. Change approach NOW — name the blocker, offer a human callback (intent callback_request) or transfer_to_human."
    );
  }
  L.push("</live_state>");
  return L.join("\n");
}

// ---------------------------------------------------------------------------
// Tool definitions & execution
// ---------------------------------------------------------------------------
export function buildTools(intents: IntentSpec[] = DEFAULT_INTENTS) {
  const actions = intents.map((i) => i.action).filter((a): a is string => !!a);
  return [
    {
      name: "update_slots",
      description:
        "Record what the caller said. Call in the SAME response as your spoken reply when the caller states why they called (intent), gives or corrects a detail (slots), or agrees to a read-back (confirmed_slots). Formats: phone digits only; date YYYY-MM-DD (resolve relative dates from TODAY); time HH:MM 24h; email lowercase with @ and dots. confirmed_slots only for items you read back in an EARLIER turn that the caller then agreed to.",
      input_schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: intents.map((i) => i.id) },
          slots: { type: "object", additionalProperties: { type: "string" } },
          confirmed_slots: { type: "array", items: { type: "string" } }
        }
      }
    },
    {
      name: "advance_state",
      description:
        "Manual transitions only: any→CLOSING, ACTION→DATA_COLLECTION (action failed because of the data), CLOSING→DATA_COLLECTION (after update_slots with the new intent). Normal progress is automatic.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", enum: ["DATA_COLLECTION", "CLOSING"] },
          reason: { type: "string" }
        },
        required: ["to"]
      }
    },
    {
      name: "perform_action",
      description:
        "Run the business action for the current intent using the confirmed data. Only valid in ACTION. You cannot pass parameters. Say a short filler line first.",
      input_schema: {
        type: "object",
        properties: { action: { type: "string", enum: actions } },
        required: ["action"]
      }
    },
    {
      name: "transfer_to_human",
      description: "Hand the call to a human. Say the short handoff line first.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"]
      }
    },
    {
      name: "end_call",
      description: "End the call. Only from CLOSING, with your goodbye written in the same response.",
      input_schema: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"]
      }
    }
  ];
}

export interface ActionRunResult {
  ok: boolean; // Whether the request was durably recorded.
  detail: string;
  bookingConfirmed?: boolean; // Only true after explicit provider confirmation; NOT merely a local request.
}

export interface ToolDeps {
  secureContact?: boolean;
  ctx: CallContext;
  intents: IntentSpec[];
  runAction(action: string, slots: Record<string, string>, idempotencyKey: string): Promise<ActionRunResult>;
  canTransfer(): boolean;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
  rejected?: number;
}

const ok = (o: Record<string, unknown>, rejected = 0): ToolOutcome => ({
  content: JSON.stringify({ ok: true, ...o }),
  isError: false,
  rejected
});

const fail = (error: string, extra: Record<string, unknown> = {}): ToolOutcome => ({
  content: JSON.stringify({ ok: false, error, ...extra }),
  isError: true
});

export function snapshotSession(s: Session, intents: IntentSpec[] = DEFAULT_INTENTS) {
  const sp = specOf(s, intents);
  const missing = sp ? getMissingRequiredSlots(s, sp) : [];
  const awaiting = sp ? getAwaitingConfirmSlots(s, sp) : [];
  const hint =
    s.state === "DATA_COLLECTION" && sp
      ? missing[0]
        ? `Ask next for: ${missing[0].label}`
        : awaiting.length
          ? `Read back for confirmation: ${awaiting.map((x) => x.name).join(", ")}`
          : ""
      : s.state === "ACTION"
        ? sp?.action
          ? "All data ready. Say a short filler line, then call perform_action."
          : "Answer from business knowledge and continue follow-up questions naturally; close only when the caller is done."
        : s.state === "CLOSING"
          ? "If the caller is finished or said no, thank them and end_call without a question. Otherwise recap any verified next step."
          : "";
  return {
    state: s.state,
    intent: s.intent,
    known: Object.fromEntries(
      Object.entries(s.slots).map(([k, v]) => [k, { value: v.value, confirmed: v.confirmed }])
    ),
    missing: missing.map((x) => x.name),
    awaiting_confirmation: awaiting.map((x) => x.name),
    hint
  };
}

const fnv = (str: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
};

export async function executeTool(
  d: ToolDeps,
  s: Session,
  name: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  if (s.state === "ENDED") return fail("The call has ended.");

  switch (name) {
    case "update_slots": {
      if (typeof input.intent === "string") {
        const err = setIntent(s, d.ctx, d.intents, input.intent);
        if (err) return fail(err);
        if (s.state === "ACTION") go(s, "DATA_COLLECTION", "model");
      }
      const sp = specOf(s, d.intents);
      const rejected: Record<string, string> = {};
      const accepted: string[] = [];
      const slots = (input.slots ?? {}) as Record<string, unknown>;
      const confirmed = Array.isArray(input.confirmed_slots)
        ? (input.confirmed_slots as unknown[]).map(String)
        : [];

      if (!sp) {
        if (Object.keys(slots).length || confirmed.length) {
          return fail("Set the intent first: update_slots(intent=…).");
        }
      } else {
        for (const [k, raw] of Object.entries(slots)) {
          if (d.secureContact && ["name","phone","email"].includes(k)) { rejected[k]="Use the private on-screen contact form"; continue; }
          const spec = sp.slots.find((x) => x.name === k);
          if (!spec) {
            rejected[k] = "not a field for this intent";
            continue;
          }
          const val = validateSlot(spec.validator, String(raw), d.ctx.clock.todayIso, spec.name);
          if (!val) {
            s.slotFailures[k] = (s.slotFailures[k] ?? 0) + 1;
            rejected[k] = `invalid ${spec.validator} (attempt ${s.slotFailures[k]})`;
            continue;
          }
          const prev = s.slots[k];
          const same = prev?.value === val;
          s.slots[k] = {
            value: val,
            confirmed: same ? prev.confirmed : !spec.needsConfirm,
            source: "caller",
            setAtTurn: same ? prev.setAtTurn : s.totalTurns
          };
          delete s.slotFailures[k];
          accepted.push(k);
        }

        for (const k of confirmed) {
          if (d.secureContact && ["name","phone","email"].includes(k)) { rejected[k]="Confirm contact data in the private form"; continue; }
          const cur = s.slots[k];
          if (!cur) {
            rejected[k] = "no value recorded yet";
            continue;
          }
          // Anti-hallucination guard: a slot can only be confirmed on a LATER caller turn
          // than the turn that set it (after the agent read it back and the caller agreed).
          if (cur.setAtTurn >= s.totalTurns) {
            rejected[k] = "read it back first and wait for the caller to answer in their next turn";
            continue;
          }
          cur.confirmed = true;
          accepted.push(k);
        }
      }
      const moved = autoAdvance(s, d.intents);
      return ok(
        { accepted, rejected, moved, ...snapshotSession(s, d.intents) },
        Object.keys(rejected).length
      );
    }

    case "advance_state": {
      const to = String(input.to) as CallState;
      if (!MANUAL[s.state].includes(to)) {
        return fail(
          `${s.state} → ${to} is not allowed. Manual moves from ${s.state}: ${
            MANUAL[s.state].join(", ") || "none"
          }. Normal progress is automatic.`
        );
      }
      if (s.state === "CLOSING" && to === "DATA_COLLECTION" && !s.intentFresh) {
        return fail("Set the new request first: update_slots(intent=…), then advance_state.");
      }
      go(s, to, "model");
      const moved = autoAdvance(s, d.intents);
      return ok({ moved, ...snapshotSession(s, d.intents) });
    }

    case "perform_action": {
      const sp = specOf(s, d.intents);
      if (s.state !== "ACTION" || !sp) {
        return fail(`perform_action is only valid in ACTION (current: ${s.state}).`);
      }
      if (!sp.action) {
        return fail("This intent has no action. Answer from business knowledge, then advance_state(CLOSING).");
      }
      if (input.action !== sp.action) {
        return fail(`The action for this intent is "${sp.action}".`);
      }
      const slots = Object.fromEntries(Object.entries(s.slots).map(([k, v]) => [k, v.value]));
      const key = `${d.ctx.callId}:${sp.action}:${fnv(JSON.stringify(slots))}`;
      const res = s.actionCache[key] ?? (await d.runAction(sp.action, slots, key));
      if (res.ok) s.actionCache[key] = res;
      s.actionResult = res;
      const moved = res.ok ? autoAdvance(s, d.intents) : [];
      return res.ok
        ? ok({ detail: res.detail, moved, ...snapshotSession(s, d.intents) })
        : fail("Action failed.", {
            detail: res.detail,
            next: "Explain the problem clearly, offer at most two relevant alternatives or a human callback."
          });
    }

    case "transfer_to_human": {
      if (!d.canTransfer()) {
        return fail("No human is available right now.", {
          next: "Offer to register a callback request (intent callback_request)."
        });
      }
      markHandoff(s, String(input.reason ?? "unspecified").slice(0, 200));
      return ok({ note: "Handoff started. Your short transfer line must already be in this response." });
    }

    case "end_call": {
      if (s.state !== "CLOSING") {
        return fail(`end_call is only valid from CLOSING (current: ${s.state}). Use advance_state(CLOSING) first.`);
      }
      markEnd(s, String(input.reason ?? "done").slice(0, 200));
      return ok({ note: "Call will end after your goodbye finishes playing." });
    }

    default:
      return fail(`Unknown tool "${name}".`);
  }
}

// ---------------------------------------------------------------------------
// Deterministic caller utterance ingestion for Workers AI voice sessions
// ---------------------------------------------------------------------------
// In Mizan Voice Gateway v2, Workers AI models (`@cf/daily-co/phonellm-mini-alpha-2`)
// produce direct spoken responses and may not emit Anthropic-style tool_use blocks.
// This helper extracts unambiguous caller intents, slot values, and confirmations
// and runs them through the exact same `executeTool` guards on each caller turn.
// ---------------------------------------------------------------------------

const EMERGENCY_RX =
  /(?:ألم\s+في\s+الصدر|وجع\s+في\s+الصدر|ضيق\s+تنفس|مش\s+قادر[ةه]?\s+[أا]تنفس|نزيف\s+شديد|فقدان\s+وعي|أغمى\s+عليه|حالة\s+طوارئ\s+حرجة|اسعاف|إسعاف|أزمة\s+قلبية|جلطة)/u;

const AFFIRMATIVE_CONFIRM_RX =
  /(?:^|\s)(?:أيوه|ايوه|أيوة|ايوة|آه|اه|صح|مظبوط|مضبوط|تمام|أكيد|اكيد|موافق|موافقة|نعم|بالظبط|صح\s+كده|تمام\s+كده|yes|correct|right|sure|exactly)(?=$|\s|[،,.!؟?])/iu;

const NEGATIVE_REJECT_RX =
  /(?:^|\s)(?:لأ|لا|غلط|مش\s+صح|مش\s+مظبوط|تعديل|غير|عدّل|عدل|no|wrong|incorrect)(?=$|\s|[،,.!؟?])/iu;

export function resolveRelativeDateFromSpeech(utterance: string, todayIso: string): string | null {
  const normalized = normalizeDigits(stripMarks(utterance));
  const isoMatch = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/u);
  if (isoMatch) {
    return validateSlot("date_iso", isoMatch[1], todayIso);
  }

  const base = new Date(`${todayIso}T00:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;

  const addDays = (days: number): string => {
    const d = new Date(base.getTime() + days * 86400_000);
    return d.toISOString().slice(0, 10);
  };

  if (/(?:النهارده|النهاردة|اليوم)/u.test(normalized)) return addDays(0);
  if (/(?:بعد\s+بكرة|بعد\s+بكره)/u.test(normalized)) return addDays(2);
  if (/(?:بكرة|بكره|غدا|غداً)/u.test(normalized)) return addDays(1);

  const weekdays: Array<[RegExp, number]> = [
    [/(?:الأحد|الاحد|أحد|احد)/u, 0],
    [/(?:الإثنين|الاثنين|الاتنين|اتنين)/u, 1],
    [/(?:الثلاثاء|التلات|ثلاثاء)/u, 2],
    [/(?:الأربعاء|الاربعاء|الأربع|الاربع)/u, 3],
    [/(?:الخميس|خميس)/u, 4],
    [/(?:الجمعة|الجمعه|جمعة)/u, 5],
    [/(?:السبت|سبت)/u, 6]
  ];
  for (const [rx, targetDay] of weekdays) {
    if (rx.test(normalized)) {
      const currentDay = base.getUTCDay();
      let delta = (targetDay - currentDay + 7) % 7;
      if (delta === 0) delta = 7;
      return addDays(delta);
    }
  }
  return null;
}

export function resolveSpokenTimeFromSpeech(utterance: string): string | null {
  const normalized = normalizeSpokenAndIndicDigits(utterance);
  const hhmm = normalized.match(/\b(\d{1,2}):(\d{2})\b/u);
  if (hhmm) {
    let h = Number(hhmm[1]);
    const m = hhmm[2];
    if (/(?:مساء|بالليل|العصر|المغرب|بعد\s+الضهر)/u.test(normalized) && h >= 1 && h <= 11) {
      h += 12;
    }
    return validateSlot("time_hhmm", `${h}:${m}`, "");
  }

  const hourMatch = normalized.match(/الساعة\s*(\d{1,2})(?:\s*ونص)?/u);
  if (hourMatch) {
    let h = Number(hourMatch[1]);
    const half = /ونص/u.test(hourMatch[0]);
    if (/(?:مساء|بالليل|العصر|المغرب|بعد\s+الضهر)/u.test(normalized) && h >= 1 && h <= 11) {
      h += 12;
    } else if (!/(?:الصبح|صباحا|صباحاً|الفجر)/u.test(normalized) && h >= 1 && h <= 7) {
      // Afternoon/evening business hours default for 1..7 when unspecified
      h += 12;
    }
    return validateSlot("time_hhmm", `${h}:${half ? "30" : "00"}`, "");
  }
  return null;
}

export function isInformationalRequest(utterance: string): boolean {
  return /(?:مثال|أمثلة|امثلة|سيناريو|اشرح|شرح|إزاي|ازاي|كيف|عايز\s+أعرف|عايز\s+اعرف|عايزة\s+أعرف|عايزة\s+اعرف|how\s+(?:does|do|can)|example|explain)/iu.test(stripMarks(utterance));
}

export function detectCallerIntentFromSpeech(utterance: string, currentIntent: string | null): string | null {
  const text = stripMarks(utterance);
  // Discussing a capability is not permission to perform it. In particular, a
  // sales/demo example about appointments must not start patient data collection.
  if (isInformationalRequest(text)) {
    return currentIntent && currentIntent !== "inquiry" ? null : "inquiry";
  }
  if (/(?:أحجز|احجز|حجز|ميعاد\s+كشف|عايز\s+أكشف|عايزة\s+أكشف|موعد|كشف\s+مع|استشارة\s+مع|\bbook\b|\bappointment\b)/iu.test(text)) {
    return "book_appointment";
  }
  if (/(?:حد\s+يكلمني|يتصل\s+بيا|اتصلوا\s+بيا|كلموني|ترجعولي|callback|call\s+me\s+back)/iu.test(text)) {
    return "callback_request";
  }
  if (/(?:شكوى|عندي\s+مشكلة|مشكلة\s+في|زعلان|بشتكي|complaint)/iu.test(text)) {
    return "complaint";
  }
  if (!currentIntent && /(?:سعر|أسعار|بكام|عنوان|فرع|مواعيد\s+العمل|فاتحين|بتقفلوا|تأمين|خدمات|بتعملوا|ميزان)/u.test(text)) {
    return "inquiry";
  }
  if (!currentIntent && !isProceduralPhrase(text) && /(?:استفس|بتعمل|بتقدم|تقدر|فكرة|فكره|إيه|ايه|مين|what|how|tell)/iu.test(text)) {
    return "inquiry";
  }
  return null;
}

export async function ingestCallerUtterance(
  deps: ToolDeps,
  session: Session,
  utterance: string,
  extractedCallerName?: string | null
): Promise<{ outcomes: ToolOutcome[]; autoExecutedAction?: ToolOutcome }> {
  const outcomes: ToolOutcome[] = [];
  if (session.state === "ENDED") return { outcomes };

  session.totalTurns++;
  session.turnsInState++;

  // 1. Check for critical medical emergency (REG-06)
  if (EMERGENCY_RX.test(stripMarks(utterance))) {
    session.emergencyDetected = true;
    return { outcomes };
  }

  // 2. Check for explicit human handoff request
  if (/(?:حولني\s+لبشري|أكلم\s+حد\s+من\s+الفريق|موظف\s+خدمة\s+عملاء|أكلم\s+بني\s+آدم|talk\s+to\s+a\s+human)/iu.test(utterance)) {
    if (deps.canTransfer()) {
      const res = await executeTool(deps, session, "transfer_to_human", { reason: "caller_requested_human" });
      outcomes.push(res);
      return { outcomes };
    }
  }

  // 3. Detect intent and slots from caller speech
  const detectedIntent = detectCallerIntentFromSpeech(utterance, session.intent);
  const targetIntentId = detectedIntent ?? session.intent;
  const explanationOnly = isInformationalRequest(utterance);
  const slotsToUpdate: Record<string, string> = {};

  if (!deps.secureContact && extractedCallerName && !isProceduralPhrase(extractedCallerName)) {
    slotsToUpdate.name = extractedCallerName;
  }

  // Numbers and dates mentioned inside a requested example are not live slots.
  if (!explanationOnly) {
    const accumulatedPhone = deps.secureContact ? null : accumulatePhoneDigits(session, utterance);
    if (accumulatedPhone && !deps.secureContact) {
      slotsToUpdate.phone = accumulatedPhone;
    }

    const resolvedDate = resolveRelativeDateFromSpeech(utterance, deps.ctx.clock.todayIso);
    if (resolvedDate) {
      slotsToUpdate.date = resolvedDate;
    }

    const resolvedTime = resolveSpokenTimeFromSpeech(utterance);
    if (resolvedTime) {
      slotsToUpdate.time = resolvedTime;
    }

    const emailMatch = utterance.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu);
    if (emailMatch && !deps.secureContact) {
      slotsToUpdate.email = emailMatch[0].toLowerCase();
    }

    const doctorMatch = stripMarks(utterance).match(/(?:دكتور|دكتورة|دكتوره)\s+([\u0621-\u064A]{2,18})/u);
    if (doctorMatch && targetIntentId === "book_appointment") {
      slotsToUpdate.doctor = `د. ${doctorMatch[1]}`;
    }

    if (targetIntentId === "callback_request" && !session.slots.topic && utterance.trim().length >= 4) {
      slotsToUpdate.topic = utterance.trim().slice(0, 120);
    }
    if (targetIntentId === "complaint" && !session.slots.issue && utterance.trim().length >= 4) {
      slotsToUpdate.issue = utterance.trim().slice(0, 140);
    }
  }

  // 4. Check if caller is confirming previously set slots (anti-hallucination: only slots set on an EARLIER turn)
  const sp = deps.intents.find((i) => i.id === targetIntentId) ?? null;
  const confirmedSlots: string[] = [];
  if (
    sp && !explanationOnly &&
    session.state === "DATA_COLLECTION" &&
    AFFIRMATIVE_CONFIRM_RX.test(utterance) &&
    !NEGATIVE_REJECT_RX.test(utterance)
  ) {
    for (const slotSpec of getAwaitingConfirmSlots(session, sp)) {
      const existing = session.slots[slotSpec.name];
      // Only confirm if set on an earlier turn AND not being overwritten in this same turn
      if (existing && existing.setAtTurn < session.totalTurns && !slotsToUpdate[slotSpec.name]) {
        confirmedSlots.push(slotSpec.name);
      }
    }
  }

  // 5. Execute update_slots if we have an intent, new slots, or confirmations
  if (detectedIntent || Object.keys(slotsToUpdate).length > 0 || confirmedSlots.length > 0) {
    const updatePayload: Record<string, unknown> = {};
    if (detectedIntent) updatePayload.intent = detectedIntent;
    if (Object.keys(slotsToUpdate).length > 0) updatePayload.slots = slotsToUpdate;
    if (confirmedSlots.length > 0) updatePayload.confirmed_slots = confirmedSlots;

    if (session.intent || updatePayload.intent) {
      const outcome = await executeTool(deps, session, "update_slots", updatePayload);
      outcomes.push(outcome);
    }
  }

  // End an inquiry only on an unambiguous goodbye. "شكرا بس اديني مثال"
  // remains an open conversation; thanking the assistant is not itself consent.
  const callerDone = /^(?:(?:لأ|لا)\s*)?(?:شكرا(?:\s+جزيلا)?(?:\s+مع\s+السلامة)?|مع\s+السلامة|كده\s+تمام|مش\s*محتاج\s*حاجة|خلاص\s+شكرا)[\s،,.!؟]*$/u.test(stripMarks(utterance).trim());
  if (callerDone && session.intent === "inquiry" && session.state !== "CLOSING") {
    outcomes.push(await executeTool(deps, session, "advance_state", { to: "CLOSING" }));
  }
  if (
    session.state === "CLOSING" &&
    callerDone &&
    !detectedIntent
  ) {
    const endOutcome = await executeTool(deps, session, "end_call", { reason: "caller_confirmed_done" });
    outcomes.push(endOutcome);
  }

  // 7. If state auto-advanced to ACTION and the intent has a business action, run perform_action automatically
  // so side effects (D1 booking persistence + optional webhook) are deterministically executed before the LLM replies!
  let autoExecutedAction: ToolOutcome | undefined;
  const activeSpec = specOf(session, deps.intents);
  if (!explanationOnly && session.state === "ACTION" && activeSpec?.action) {
    autoExecutedAction = await executeTool(deps, session, "perform_action", { action: activeSpec.action });
    outcomes.push(autoExecutedAction);
  }

  return { outcomes, autoExecutedAction };
}
