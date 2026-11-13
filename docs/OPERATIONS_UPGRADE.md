# Operations upgrade — 13 November 2026

## What was preserved and extended

| Capability | Existing behavior retained | Added |
|---|---|---|
| Usage | tenant_usage and concurrency guard | Atomic monthly budget + concurrent reservations, elapsed-second settlement, per-call deadline, integer EGP billing estimates |
| Reports | Five-minute expiry cron | Monday 06:00 UTC summary job, weekly snapshots, tenant/admin retrieval |
| Calendar | Guarded business actions and local booking persistence | Cal.com, Zoho Bookings and HTTPS webhook adapters; encrypted credentials; durable booking-operation record; external confirmation gates local success |
| Handoff | Conversation manager handoff + emergency detection | Persistent pause/resume control; DO enforcement; human-required event; emergency target 123 |
| QA | Existing AI + deterministic post-call evaluator | Join call_operations whole-call assessments onto all turns, including late queue writes; isolated manager simulation endpoint |
| Knowledge | FAQ editing + learnings | Baseline/change history; conservative unanswered-question detection and review status |
| Analytics | Call and booking counters | Tenant-scoped totals, qualified leads, booking confirmations and resolution without handoff |

These additions do not implement the earlier speculative-inference architecture or a full production traffic simulator. Simulation here exercises the existing guarded conversation manager with mocked actions, not STT/TTS, live LLM replies or load testing.

## Deployment

1. Back up deployed D1 privately. Existing migrations 001–006 remain unchanged.
2. Apply the repeatable **migration-007.sql** before deployment: `npm run db:migrate:007`. Never replay old ALTER migrations against production.
3. Monthly limits are **opt-in**: missing plan / monthly_seconds=null means no monthly quota. Existing concurrency, hourly admission and maximum 25-minute call guards remain. Rate defaults to zero; nothing collects payments. Super-admin may configure a monthly allowance and per-call maximum of 30–1500 seconds.
4. Preserve CONTACT_ENC_KEY exactly (existing 32-byte hex/base64 supported). Do not rotate it without re-encrypting stored data.
5. Optional INTEGRATION_ALLOWED_HOSTS enables explicitly allowlisted HTTPS webhook hosts. No calendar is enabled until an authorized tenant configures encrypted credentials.
6. Node >=22.13 and Python 3: run `npm run release:gate` (types, all regression tests, real Wrangler bundle) and `npm run test:browser` (Chromium with synthetic media/socket/provider accounts).
7. Live provider accounts, actual voice quality and real bookings require separate verification; mocks do not establish their readiness.

## API reference

All `/api/client/*` routes use the tenant from the existing authenticated session. Mutations require an Origin matching the requested origin. Include the session cookie; do not put credentials in URLs.

| Method | Path | Body/query |
|---|---|---|
| GET | /api/client/usage | optional `period=YYYY-MM` |
| GET | /api/client/metrics | optional integer Unix-second `start` and `end` |
| GET | /api/client/reports/weekly | latest 52 snapshots |
| PUT | /api/admin/tenants/:slug/billing | `monthly_seconds`, `max_call_seconds` (30–1500), `rate_piasters_per_minute` |
| GET | /api/admin/tenants/:slug/usage | optional period |
| GET | /api/admin/tenants/:slug/metrics | optional start/end |
| GET | /api/admin/tenants/:slug/reports/weekly | snapshots |
| GET/PUT/DELETE | /api/client/integrations/calendar | configuration below |
| POST | /api/client/sessions/:id/handoff | `{}` |
| POST | /api/client/sessions/:id/resume | `{}` |
| POST | /api/client/qa/simulate | `{"utterances":["عايز احجز ميعاد","مش قادر اتنفس"]}`; synthetic data only |
| GET | /api/client/knowledge-gaps | latest 100 candidates |
| PUT | /api/client/knowledge-gaps/:id | `{"status":"open|reviewed|resolved|dismissed"}` |
| GET | /api/client/knowledge/:id/versions | latest 100 versions |

The existing session-detail response exposes normalized whole-call QA on calls and turns. The new endpoints are backend APIs; the existing portal has not been redesigned into a full billing/calendar/report UI.

### Calendar configurations

Cal.com: `{"provider":"calcom","api_key":"<secret>","event_type_id":123}`.
Zoho: `{"provider":"zoho","api_key":"<OAuth access token>","service_id":"123","staff_id":"456","host":"www.zohoapis.com"}`.
Webhook: `{"provider":"webhook","api_key":"<adapter secret>","url":"https://your-allowlisted-host/book"}`.

Cal.com uses /v2/bookings and API version 2026-02-25; attendee email becomes required in the booking intent for configured Cal.com tenants. Configure a standard event type; custom mandatory booking fields are not supported by this adapter. Zoho supports staff appointments, not resource/group appointment variants. Zoho access-token refresh is not automated: rotate the token via PUT or use a webhook adapter that manages OAuth. Regional hosts supported: .com, .eu, .in, .com.au, .jp, .ca.

Cairo times are resolved with IANA timezone rules; ambiguous/nonexistent DST times are rejected. An HTTP success alone is insufficient: the provider must return a confirmed/accepted booking identifier. Pending confirmation/payment is not represented as booked. No automatic cancellation/rescheduling or inbound provider webhook synchronization is included.

Custom adapter: accept POST with Bearer authentication, Idempotency-Key, tenant_slug, session_id, action, slots, time_zone and UTC start. Return `{"confirmed":true,"booking_id":"..."}` only after real confirmation. Redirects are forbidden; requests time out at eight seconds.

`booking_operations` persists pending/confirmed state across retries. Ambiguous timeouts are **not automatically retried**, avoiding double booking. Inspect pending records, check the provider, and reconcile with a human. A provider success followed by a local-write failure remains recoverable using its stored external_id. Provider quotas and account credentials still require live staging verification.

Provider API references (account behavior still requires live verification):
- https://cal.com/docs/api-reference/v2/bookings/create-a-booking
- https://www.zoho.com/bookings/help/api/v1/book-appointment.html

### Billing semantics

UTC calendar months; session start determines the billing period, including midnight-crossing calls. Reserve the full maximum call duration before admission; insufficient remaining allowance rejects the call even if a shorter call might fit. No automatic overage. Actual wall-clock seconds settle at close, capped at the reservation; crashed sessions conservatively settle to reserved duration. A closed session ID cannot be reused. Charges sum `ceil(seconds × rate_piasters / 60)` per settled call using the rate snapshotted at admission. Reservations include handoff waiting time. Zero rate is free. This is metering/amount calculation, not payment collection, tax invoicing or historical backbilling.

### Handoff and emergency semantics

The Durable Object checks persisted controls every two seconds and before action execution/output; a separate deadline timer stops the session at its reserved expiry. Pause blocks new audio processing and AI output. Already-sent audio or an already-started external request cannot be recalled. Human handoff attribution remains set after resume. A human operator may explicitly resume the conversation.

Emergency detection retains the existing 123 spoken instruction and emits `{"type":"handoff","status":"human_required","target":"123","auto_dial":false}`. There is no SIP/PBX bridge in this package: no telephone transfer or human audio channel is claimed. The public voice page displays the handoff notice; other clients must handle the event. No email/SMS/WhatsApp notification is automatically sent.

### Reports, definitions and QA

Weekly periods: Monday 00:00 UTC to the next Monday; generation Monday 06:00 UTC. Reports are stored for portal retrieval, not emailed. Running runOperationsCron again updates the latest completed week idempotently; previous snapshots are otherwise retained. Delayed evaluations after the scheduled snapshot require an explicit regeneration. Generation is paginated but remains one scheduled invocation; very large tenant counts should move report work to per-tenant queue jobs.

- total_calls: sessions started in the half-open reporting interval.
- qualified_leads: encrypted contact phone present and intent book_appointment/callback_request (a defined proxy, not inferred lead quality).
- confirmed_bookings: booking_confirmed=1. Historical local bookings retain their original semantics.
- resolution_rate_percent: ended sessions with intent_resolved=1 and handed_off=0 / all ended sessions; null when denominator is zero.
- call_turns evaluation fields contain the **whole-call** assessment, not independently scored individual turns; tenant-scoped joins cover both write orders.
- Knowledge gaps use uncertainty-phrase heuristics, with no automated publication of suggested facts. Phone/email/national-ID masking is limited, not a complete PII anonymizer. Apply the project's data retention/access policies to stored questions. Names already known to the call privacy guard are also masked.

## Verification

`npm test`: existing Deepgram suite, all 18 conversation-manager tests, and 9 operations test groups pass. New coverage includes real SQLite migrations/queries/triggers, quota accounting, cross-tenant isolation, CSRF, crypto write-only configuration, mocked provider success/timeout/replay, Cairo DST, handoff state, and synthetic-manager execution. Production latency, live telephony, real provider authentication and live bookings were not tested.

## Browser audio and language regression

Raw STT SpeechStarted events no longer stop playback: loudspeaker echo can trigger them and cut the first word. The browser withholds outgoing PCM during audio decoding/playback and for a 250ms echo tail. Natural playback completion restores forwarding without overriding mute, the private-contact form or human pause. A visible “مقاطعة المساعد” button deliberately stops playback; automatic spoken interruption is disabled in this browser mode. A real WAV browser test covers completion, echo and deliberate interruption. Unclear Arabic receives an Egyptian Arabic clarification; mixed English sentence drift is blocked before TTS. This does not prove the selected voice asset's accent.
