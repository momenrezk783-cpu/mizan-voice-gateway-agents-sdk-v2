> **Profile and private-contact upgrade (2026-11-12):** Apply additive migration 005 after 001–004 **before merging/deploying this version**. Production CI checks the required tables without reading customer rows and refuses deployment if they are missing. See [implementation and rollout notes](docs/PROFILE_AND_CONTACT_UPGRADE.md). This change has not run production migrations or deployed production.

> Upgrade note: this version adds signed call admission and encrypted CRM storage.
> Apply migration 004 before deploying; see [the upgrade cheat sheet](docs/HARDENING_UPGRADE.md)
> for legacy-contact migration, limits, validation and rollback steps. No live deployment
> or production migration was performed with this source update.

> **CURRENT REVIEW HANDOFF (2026-11-11):** For the current GitHub branches, latest voice fixes, verified test results, and safe deployment boundaries, begin with [`docs/START_HERE_MIZAN.md`](docs/START_HERE_MIZAN.md). Older architectural tables below describe v2 proposals and may not match the deployed source.

> **CURRENT STATE — 2026-11-10:** This README includes historical v2 architecture claims about WorkersAIFluxSTT/WorkersAITTS. The audited Sprint 6+ code actually uses **Deepgram streaming STT**, **Workers AI for LLM**, and **ElevenLabs TTS**, and needs both voice provider credentials. See `PROJECT_STATE.md`, `DECISIONS.md`, `SPRINT_LOG.md`, `docs/SIP_LAB_GUIDE.md` and `docs/TEST_EVIDENCE.md` for verified facts. **Do not use `npm run deploy`, `npm run db:migrate` or GitHub main push as a test; those may affect production.** The BYON SIP code is laboratory-only.

# Mizan Voice Gateway v2 — Agents SDK Architecture

## What Changed From v1

| Area | v1 (Manual) | v2 (Agents SDK) |
|---|---|---|
| **Voice pipeline** | Manual WebSocket + STT + TTS (450 lines) | `withVoice(Agent)` mixin — SDK handles everything |
| **STT** | External Deepgram API (needs API key) | `WorkersAIFluxSTT` — Deepgram Flux on Workers AI (no key) |
| **TTS** | External ElevenLabs API (needs API key) | `WorkersAITTS` — Workers AI TTS (no key) |
| **WebSocket** | Manual `addEventListener` | WebSocket Hibernation API (DOs sleep when idle, cost savings) |
| **Conversation state** | Manual tracking in DO variables | SQLite-backed DO (automatic persistence) |
| **Turn detection** | Client must signal end-of-speech | Model-driven (Deepgram Flux detects automatically) |
| **LLM** | Manual `env.AI.run()` calls | `generateText()` via AI SDK with PhoneLLM Mini |
| **D1 writes** | Blocking in request path | Queues (non-blocking, retriable) |
| **Worker count** | Two workers (gateway + voice agent) | **Single unified worker** |
| **Pilot lifecycle** | Manual | Scheduled cron auto-expires 14-day pilots |
| **External API keys** | ELEVENLABS_API_KEY, DEEPGRAM_API_KEY | **None needed** — all on Workers AI |

## Architecture

```
                     ┌────────────────────────────────────────┐
  www.mizanconsult.com │     mizan-voice-gateway (single worker)   │
  voice.mizanconsult.com │                                          │
  ──────────────────► │  ┌─────────┐  ┌──────────┐  ┌───────────┐  │
                     │  │ Gateway │  │ Portal   │  │ Admin     │  │
                     │  │ Router  │  │ API      │  │ API       │  │
                     │  └────┬────┘  └──────────┘  └───────────┘  │
                     │       │                                    │
                     │       ▼                                    │
                     │  ┌────────────────────────────────────┐   │
                     │  │  MizanVoiceAgent (withVoice)        │   │
                     │  │  ┌─────────┐  ┌────────┐  ┌──────┐ │   │
                     │  │  │ STT     │  │ onTurn │  │ TTS  │ │   │
                     │  │  │ (Flux)  │→ │ (LLM)  │→ │(Aura)│ │   │
                     │  │  └─────────┘  └────────┘  └──────┘ │   │
                     │  │  SQLite-backed conversation state   │   │
                     │  │  WebSocket Hibernation (cost-save)  │   │
                     │  └────────────────────────────────────┘   │
                     │       │                                    │
                     │       ▼                                    │
                     │  ┌──────────┐ ┌─────┐ ┌────┐ ┌─────────┐  │
                     │  │ D1       │ │ KV  │ │ R2 │ │ Queue   │  │
                     │  │ (tenant  │ │(cfg)│ │(rec)│ │(D1 write│  │
                     │  │  scoped) │ │     │ │    │ │ async)  │  │
                     │  └──────────┘ └─────┘ └────┘ └─────────┘  │
                     │       │                                    │
                     │       ▼                                    │
                     │  ┌──────────────────┐                     │
                     │  │ Analytics Engine  │                     │
                     │  │ (per-tenant latency)│                    │
                     │  └──────────────────┘                     │
                     └────────────────────────────────────────┘
```

## Service Playbooks

### 1. Onboarding Playbook
1. Super admin creates tenant via `POST /api/admin/tenants`
2. Tenant gets instant `/c/:slug` link (no DNS, no SSL, no IT)
3. 14-day pilot timer starts automatically
4. Cron auto-suspends expired pilots

### 2. Patient Call Playbook
1. Patient opens `/c/:slug` → modern glassmorphic voice page
2. Clicks orb → WebSocket to `wss://voice.mizanconsult.com/agents/mizan-voice-agent/:slug?session_id=<uuid>`
3. `routeAgentRequest` creates per-call Agent instance (`slug:sessionId`)
4. Agent loads tenant config from KV → builds system prompt with FAQ
5. Patient speaks → Deepgram Flux STT (Workers AI) → `onTurn()` fires
6. LLM generates reply (PhoneLLM Mini, optimized for voice)
7. Medical advice guard applies if `allow_medical_advice = 0`
8. Workers AI TTS speaks reply back
9. Turns recorded to D1 via Queue (non-blocking)
10. Latency reported to Analytics Engine

### 3. Portal Playbook
1. Clinic admin logs in → session cookie (`__Host-mizan_session`)
2. Views call history (tenant-scoped from session)
3. Updates FAQ/knowledge → KV cache invalidated
4. Adjusts voice config (prompt, voice, policy)

### 4. Admin Playbook
1. Super admin views all tenants + cross-tenant metrics
2. Creates/edits/suspends tenants
3. Per-tenant branding (theme_color, logo_url)

### 5. Lifecycle Playbook
1. Pilot (14 days, path-based `/c/:slug`)
2. Auto-expire via cron → status = 'suspended'
3. Upgrade to `production_pbx` → custom domain, API keys for SIP

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create resources
npx wrangler kv namespace create TENANT_CONFIG
npx wrangler r2 bucket create mizan-call-records
npx wrangler queues create mizan-background

# 3. Apply D1 schema
npx wrangler d1 execute mizan-db --file=./schema.sql

# 4. Set secrets
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CONTACT_ENC_KEY
npx wrangler secret put ADMIN_PASSKEY_HASH

# 5. Generate types
npx wrangler types

# 6. Deploy
npx wrangler deploy
```

## File Structure

```
mizan-voice-gateway-v2/
├── wrangler.toml              # Single unified worker config
├── package.json              # agents + ai SDK dependencies
├── schema.sql                # Multi-tenant D1 schema
├── src/
│   ├── index.ts              # Worker entry: routing, portal API, admin API, queue, scheduled
│   ├── agent.ts              # Voice Agent (withVoice mixin) — the core difference
│   └── lib/
│       ├── tenant.ts         # Tenant resolution (KV cache + D1)
│       ├── auth.ts           # Session management (HMAC-SHA256, PBKDF2)
│       └── crypto.ts         # AES-GCM PII encryption
└── public/
    └── css/
        └── voice.css         # Modern glassmorphic voice page
```

## Langfuse tracing

The voice agent exports one trace per accepted voice turn and a separate post-call
quality evaluation trace. The call session ID groups them in Langfuse Sessions;
tenant ID and environment are attached to every observation. Primary and fallback
model attempts, conversation tools, retrieval and speech synthesis are nested
under the turn. Model names and available AI SDK token usage are recorded.
Workers AI post-call evaluation does not expose token usage through this path.
Custom Workers AI models may need pricing configured in Langfuse for cost estimates.

Configure `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` and `LANGFUSE_BASE_URL`.
For local development, copy `.dev.vars.example` to `.dev.vars`. For production,
use `npx wrangler secret put LANGFUSE_PUBLIC_KEY` and
`npx wrangler secret put LANGFUSE_SECRET_KEY`; set `LANGFUSE_BASE_URL` to your
project's regional HTTPS origin in Worker variables (or another Wrangler secret).
Tracing stays disabled until all three are supplied. Never commit real keys.

Trace content intentionally excludes transcripts, prompts, names, phone numbers,
tool arguments, audio and raw exception messages because these calls may contain
patient information. Inputs/outputs show structural summaries and quality scores.
This limits content-based debugging and Langfuse judge evaluations; those require
an explicit privacy-reviewed content capture policy. The existing call evaluator
continues to operate normally. No caller identity is sent as a Langfuse user ID.

Tracing uses `@langfuse/otel` 6.1.1 with a provider scoped to each turn, explicit
parent contexts and awaited shutdown in the Durable Object handler. This avoids
shared exporter I/O across WebSocket events and global tracer registration.
Manual generation spans support both AI SDK calls and direct Workers AI calls
without registering a process-wide framework integration. Export errors do not
change model fallback or call results. A bounded export happens after audio is
sent and can delay readiness for the next turn. Use Node 22.18+ (or Node 24.11+)
for current dependencies and local checks.

After configuring credentials, make a voice call, then inspect `process-voice-turn`
and `evaluate-call` in Langfuse. Confirm session grouping, tenant/environment,
parent-child relationships, fallback errors, token usage and absence of sensitive
content. Local tracing tests validate the exported spans without credentials.

## Voice deployment configuration

Arabic speech recognition uses Deepgram `nova-3` with `language=ar`, 16 kHz mono
linear PCM, 300 ms endpointing and a 1 second utterance-end window. Without a
Deepgram key, the existing Workers AI Whisper fallback handles recognition.
Speech synthesis uses the HQ-selected voice (default `MX8opBj7bbi4G2cE9j2w`)
and `eleven_v4_turbo` over ElevenLabs Text to Dialogue WebSocket, returning MP3.
Only the stability setting is sent according to the dialogue API schema; saved
legacy speed, similarity boost and speaker boost settings are not forwarded.
The voice connection holds an Agents SDK keep-alive reference until disconnect.

Before deploying, authenticate Wrangler and check that the existing Worker has
`ELEVENLABS_TTS_KEY` (or `ELEVENLABS_API_KEY`), `DEEPGRAM_API_KEY`, and the three
`LANGFUSE_*` settings. Local `.env` and `.dev.vars` files do not upload production
secrets. Review the effective HQ voice in the admin console; its saved voice ID
is read from D1 and overrides the default for HQ calls.

## TTSForFree audio evaluation (opt-in; admin only)

This does **not** replace ElevenLabs in live patient calls. TTSForFree's documented
`CreateBy` is asynchronous; a live-voice migration requires audio latency and
interruption tests before promotion. Mizan owns its turn timing, so `CreateBy`,
not `CreateMulti` or `CreateSrt`, is the applicable workflow.

1. Obtain an API key from https://ttsforfree.com/en/profile/.
2. For local dev put `TTSFORFREE_API_KEY=...` in your untracked `.dev.vars`.
   For Cloudflare set `npx wrangler secret put TTSFORFREE_API_KEY` on the
   correct target; **never** put the real key in wrangler.toml, source, logs,
   URLs, browser storage or this README.
3. Run `npm run dev`, sign in as **super_admin**, then open `/tts-studio`.
   The authenticated `/api/admin/ttsforfree/*` proxy loads languages, limits,
   favorites, personal voices and per-language catalog from TTSForFree.
4. Select `ar-EG` if offered, choose an exact voice token, review the voice
   detail and `BaseCreditsPerCharacter`, then create a short synthetic sample.
   The page preserves the returned job id in localStorage and only exposes
   a final MP3 on SUCCESS. Provider 429/network/5xx status errors retry with
   bounded backoff; status failures do not resubmit paid generation jobs.
5. Run `npm run typecheck` and `npm run test:ttsforfree`.

Known deployment gates: an authenticated provider account/key is required to
validate the real response envelopes, catalog, Egyptian accent, credit usage,
resumability and speech latency. Swagger may block unauthenticated automated
access; review https://api.ttsforfree.com/swagger/index.html on launch.
The preview studio deliberately has no patient call recording/transcription
upload; **do not put patient-identifying content into samples**. TTSForFree
notes free-tier content may be used to improve its service. Its paid plan
commercial terms and Egyptian data processing commitments need review before
any production patient use. The admin studio is not an SLA-backed live TTS path.
