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
