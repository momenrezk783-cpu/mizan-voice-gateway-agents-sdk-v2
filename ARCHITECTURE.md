# Mizan Conversation Manager — Architecture & Deployment Guide

## System Overview

```
Caller ──► Telephony Bridge ──► Cloudflare Worker (src/index.ts)
                                       │
                           ┌───────────┼───────────────────────────┐
                           │           │                           │
                    POST /telephony   WS /call/:id/ws         Queue consumer
                    (start call)    (live stream)           (post-call eval)
                           │           │                           │
                           └───────────▼───────────────────────────┘
                                  CallSession DO
                                (one per active call)
                                       │
                      ┌────────────────┼─────────────────────┐
                      │                │                     │
                  Anthropic API      D1 Database       Action Webhook
                (claude-sonnet-4-6)  (learnings,       (tenant system)
                                     CRM, calls)
```

---

## Component Map

| File | Responsibility |
|------|---------------|
| `src/index.ts` | Worker entry: routing, webhook verification, context assembly, A/B arm, queue consumer |
| `src/call-session.ts` | Durable Object: WebSocket hub, conversation loop, action dispatch, teardown |
| `src/manager.ts` | Pure state machine, slot validation, tool schemas + executor |
| `src/prompt.ts` | System prompt assembly: static + per-call + live-state blocks |
| `src/prompts/master.ar.md` | Master system prompt (cached at the LLM level) |
| `src/guard.ts` | Output guard: honorific sanitizer, MSA detector, speech chunker |
| `src/llm.ts` | Anthropic API adapter: streaming + forced-tool |
| `src/db.ts` | All D1 queries (learnings, CRM, call records, transcripts) |
| `src/evaluator.ts` | Post-call LLM evaluation → learnings upsert, CRM update |
| `src/types.ts` | Shared TypeScript types |
| `migrations/0001_initial.sql` | D1 schema (tenants, crm_contacts, calls, transcripts, learnings) |

---

## A) Master System Prompt Design

The prompt is split into three `system` blocks sent with every LLM request:

```
┌─────────────────────────────────────────────────────────┐
│ Block 1 — STATIC (cache_control: ephemeral)             │
│ • Persona rules, language constraints, examples         │
│ • Security & honesty rules                              │
│ • State machine description                             │
│ • Tool schemas (documented in prose)                    │
│ NEVER changes between calls → cached by provider        │
│ ≈ 4,500 tokens                                          │
├─────────────────────────────────────────────────────────┤
│ Block 2 — PER-CALL (cache_control: ephemeral)           │
│ • <call_context>: business name, agent, caller CRM data │
│ • <learned_adaptations>: injected from D1               │
│ Frozen at call start → cached from turn 2 onward        │
│ ≈ 400–1,200 tokens                                      │
├─────────────────────────────────────────────────────────┤
│ Block 3 — LIVE (no cache)                               │
│ • <live_state>: current state, missing slots, failures  │
│ Recomputed every turn — 50–150 tokens                   │
└─────────────────────────────────────────────────────────┘
```

**Cache economics**: with Anthropic prompt caching, Blocks 1+2 are billed at ~10% of normal input
token cost from turn 2 onward. A 15-turn call saves ~85% of Block 1 cost, ~80% of Block 2 cost.

---

## B) State Machine

```
                    ┌─────────────────────────────────────────────┐
                    │  TRIGGERS                                   │
         call_connected ──► GREETING                             │
                    │       │                                     │
           intent set ──► DATA_COLLECTION                        │
       (auto on update_slots)                                     │
                    │       │                                     │
     all slots filled ──► ACTION                                 │
      + confirmed                                                 │
       (auto advance)        │                                   │
                    │       │                                     │
       action ok ──► CLOSING                                     │
        (auto advance)       │                                   │
                    │       │                                     │
     end_call called ──► ENDED                                   │
                    │                                             │
         MANUAL moves (advance_state tool, any state):           │
           any ──► CLOSING                                        │
           ACTION ──► DATA_COLLECTION  (re-collect on failure)   │
           CLOSING ──► DATA_COLLECTION (new intent in same call) │
                    └─────────────────────────────────────────────┘
```

**Key invariants the code enforces (not just the prompt):**
- A slot can only be `confirmed: true` after the LLM read it back on a *previous* caller turn.
- `perform_action` is only executable in `ACTION` state; it cannot receive params (uses validated slots).
- `end_call` is only executable from `CLOSING`.
- `advance_state` only allows the transitions in `MANUAL[]`; all others are rejected.
- If `CLOSING → DATA_COLLECTION` is requested, an intent must have been set first (intentFresh guard).

---

## C) Self-Improvement Feedback Loop

```
  CALL ENDS
      │
      ▼
  Queue: EvalJob { callId, tenantId }         (async, non-blocking)
      │
      ▼
  Queue consumer (src/index.ts queue handler)
      │
      ├─► Load transcript from D1
      │
      ├─► runEvaluation() (src/evaluator.ts)
      │      │
      │      ├─► callForcedTool() — LLM evaluates the transcript
      │      │   Force-calls submit_call_evaluation tool
      │      │   → structured JSON: scores + learnings[] + CRM inferences
      │      │
      │      ├─► validateLearning() — HARD safety checks:
      │      │   • Rejects learnings with confidence < 0.5
      │      │   • Rejects learnings containing banned address forms
      │      │   • Rejects learnings with forbidden patterns
      │      │   • Rejects invalid state/caller-type values
      │      │
      │      └─► upsertLearning() — INSERT OR CONFLICT UPDATE:
      │            support_count++, confidence = MAX(old, new)
      │            instruction updated only if new confidence > old
      │
      └─► upsertCrmContact() — write back inferred name/gender/email
  
  NEXT CALL TO SAME TENANT
      │
      ▼
  loadLearnings() — SELECT from D1
      │   • confidence >= 0.6 (threshold)
      │   • scope: global + tenant-specific
      │   • applies_caller filter
      │   • de-dup by key (tenant wins over global)
      │   • max 24 items
      ▼
  Injected into Block 2 as <learned_adaptations>
```

**A/B measurement:** `HOLDOUT_RATE=0.1` (default 10%) skips learnings injection.
Compare `intent_resolved` rates between `arm='treated'` and `arm='holdout'` in the calls table.

---

## Deployment Steps

```bash
# 1. Install
npm install

# 2. Create D1 database
wrangler d1 create mizan-db
# Copy the database_id into wrangler.jsonc

# 3. Create the eval queue
wrangler queues create mizan-eval-queue
wrangler queues create mizan-eval-dlq   # dead-letter

# 4. Run migrations
npm run db:migrate:local   # local dev
npm run db:migrate:remote  # production

# 5. Set secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put WEBHOOK_SECRET        # shared with telephony bridge
wrangler secret put STREAM_TOKEN_SECRET   # signs WebSocket tokens

# 6. Dev
npm run dev

# 7. Deploy
npm run deploy
```

---

## Telephony Bridge Integration

### Starting a call

```
POST /telephony/inbound
Headers:
  x-mizan-signature: <HMAC-SHA256 of raw body with WEBHOOK_SECRET>
  content-type: application/json
Body:
{
  "callId": "call_abc123",        ← telephony UUID
  "tenantId": "demo-tenant",
  "callerPhone": "+201012345678"  ← E.164, omit if withheld
}

Response 200:
{ "callId": "call_abc123", "arm": "treated" }
```

### Real-time stream

```
GET /call/call_abc123/ws?token=<STREAM_TOKEN>&callId=call_abc123
Upgrade: websocket

Telephony → DO (inbound messages):
  { "type": "event",     "name": "call_connected" }
  { "type": "utterance", "text": "...", "final": true, "interrupted": false }
  { "type": "event",     "name": "caller_silent_1" }

DO → Telephony (outbound messages):
  { "type": "speech",  "text": "أهلاً بيك، أنا نور...", "final": false }
  { "type": "speech",  "text": "",                        "final": true  }
  { "type": "control", "command": "end_call"  }
  { "type": "control", "command": "transfer", "params": { "reason": "..." } }
```

### Action webhook (tenant side)

```
POST https://your-webhook.com/mizan/actions
Headers:
  x-mizan-signature: <HMAC-SHA256>
  x-idempotency-key: <callId:action:hash>
  content-type: application/json
Body:
{
  "callId": "call_abc123",
  "action": "book_appointment",
  "slots": {
    "name": "أحمد",
    "phone": "01012345678",
    "date": "2025-06-12",
    "time": "16:00"
  },
  "idempotencyKey": "call_abc123:book_appointment:3f9a..."
}

Success response (200):  { "message": "اتحجزلك الميعاد." }
Failure response (4xx/5xx): { "error": "الميعاد ده مش فاضي." }
```

---

## Security Notes

1. **Webhook verification**: every telephony request is HMAC-SHA256 verified before any D1 access.
2. **Action webhook SSRF**: URL is validated to be HTTPS at call start; relative paths are rejected.
3. **Prompt injection**: all CRM and transcript text is sanitized (`<>` stripped, length-capped) before entering the prompt.
4. **Learning safety**: `validateLearning()` applies hard regex guards before any learning is written to D1. Even a compromised evaluator response cannot inject honorifics or persona changes.
5. **WebSocket authentication**: short-lived per-call token, constant-time comparison.
6. **Tool parameter lock**: `perform_action` takes no parameters — the model cannot pass different slot values to the action webhook than what was validated and confirmed.
7. **Idempotency**: action calls are keyed by `callId:action:slotHash` and cached in the session, preventing duplicate bookings if the model retries.
