# Mizan Voice Gateway

A multi-tenant voice agent for **Egyptian Arabic** phone-style conversations, running entirely on
Cloudflare Workers and Durable Objects. Each call is a stateful agent that listens, understands,
books or escalates, and speaks back — with tenant isolation enforced from a signed session, not
from a URL parameter.

Live deployment: [mizanconsult.com](https://mizanconsult.com)

> The agent speaks **Egyptian colloquial Arabic**, not Modern Standard Arabic. That constraint is
> enforced in code (dialect guards, honorific stripping, MSA detection), not just in the prompt.

---

## What it actually is

This is a **production application**, not a general-purpose SDK. It runs one business
(Mizan Consult) and onboards additional tenants through its own admin API. There is no
plugin system, no npm package, and no drop-in library.

If you are looking for a reusable voice-agent toolkit, this repo is a worked example of one
approach — read it, borrow from it, but expect to change the Arabic-specific layers.

---

## Architecture

```
Browser (AudioWorklet, 16 kHz mono linear16 PCM)
   │  WebSocket  /agents/mizan-voice-agent/:slug?session_id=…
   ▼
Worker (src/index.ts)  ── validates single-use signed call ticket
   │
   ▼
MizanVoiceAgent  (Durable Object, one instance per call: "<slug>:<sessionId>")
   │
   ├─ Deepgram nova-3 streaming STT   (ar, endpointing 300 ms, utterance end 1000 ms)
   ├─ Conversation Manager            (state machine, slot filling, confirmation guards)
   ├─ Workers AI LLM                  (primary + fallback, non-streaming generateText)
   └─ ElevenLabs TTS                  (eleven_v4_turbo, text-to-dialogue WebSocket → MP3)
   │
   ▼
D1 (tenants, sessions, turns, CRM)  ·  KV (tenant config cache)
Queue (non-blocking turn writes)    ·  Analytics Engine (per-tenant latency)
```

**Turn lifecycle:** audio → Deepgram final transcript → conversation manager ingestion →
LLM reply → output guard (dialect, honorifics, false-claim blocking) → TTS → MP3 to client.

---

## Requirements

| Resource | Purpose |
|---|---|
| D1 `mizan-portal-db` | tenants, call sessions, turns, CRM, usage |
| KV `TENANT_CONFIG` | tenant configuration cache |
| Durable Object `MizanVoiceAgent` (SQLite) | one instance per call |
| Queue `mizan-background` | async turn recording, session finalisation |
| Analytics Engine `mizan_voice_latency` | per-tenant latency metrics |
| Workers AI binding `AI` | LLM inference |

### Secrets

| Secret | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | ✅ | HMAC-SHA256 session tokens + signed call tickets |
| `CONTACT_ENC_KEY` | ✅ | AES-GCM encryption for caller PII |
| `ADMIN_PASSKEY_HASH` | ✅ | Super-admin passkey (PBKDF2) |
| `DEEPGRAM_API_KEY` | ✅ | Streaming speech recognition |
| `ELEVENLABS_TTS_KEY` | ✅ | Speech synthesis |
| `LANGFUSE_PUBLIC_KEY` / `_SECRET_KEY` / `_BASE_URL` | optional | Turn tracing (disabled until all three are set) |

**Two external provider keys are required.** Earlier revisions of this README claimed the whole
pipeline ran on Workers AI with no external keys. That was never true of the shipped source —
Deepgram handles recognition and ElevenLabs handles synthesis. The `DECISIONS.md` entry about
this contradiction is now resolved by this file.

---

## Setup

```bash
npm ci
npx wrangler types

# create resources (names in wrangler.toml must match)
npx wrangler d1 create mizan-portal-db
npx wrangler kv namespace create TENANT_CONFIG
npx wrangler queues create mizan-background

# schema + additive migrations, in order
npx wrangler d1 execute mizan-portal-db --remote --file=./schema.sql
for f in migration-00{1,2,3,4,5,6,7}.sql; do
  npx wrangler d1 execute mizan-portal-db --remote --file=./$f
done

# secrets
npx wrangler secret put SESSION_SECRET
npx wrangler secret put CONTACT_ENC_KEY
npx wrangler secret put ADMIN_PASSKEY_HASH
npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put ELEVENLABS_TTS_KEY
```

`wrangler.toml` in this repo contains the **live production bindings**. Treat it as the deployed
configuration, not as a template. For a separate environment, copy
`wrangler.staging.example.toml` → `wrangler.staging.toml` (git-ignored) and fill in isolated
resource IDs.

---

## Local development

```bash
npm run dev          # wrangler dev
npm run typecheck    # tsc --noEmit
npm test             # 22 local test suites
npm run bundle:check # Wrangler dry-run against an isolated fixture config
```

`npm run build` is **not** a production bundle — it validates a real, isolated staging config and
exits non-zero when that config is absent. Use `npm run bundle:check` for a dependency-and-bundle
check without staging.

### What the tests do and do not prove

The suites run with **mocked providers**: Deepgram, ElevenLabs, Workers AI and `routeAgentRequest`
are stubbed (`tests/helpers/runtime.mjs`), and live model calls are explicitly forbidden
(`Live AI forbidden in local tests`). They cover the conversation manager, output guards, slot
filling, confirmation logic, SQL isolation, asset sync and browser behaviour via Playwright.

**Passing tests do not prove that a real call sounds good, responds quickly, or completes.**
Only a real call with real provider credentials does that.

---

## Security posture

- **Tenant scoping from the session.** `/api/client/*` derives the tenant from the signed session
  cookie. No tenant identifier is ever read from a query string.
- **Single-use signed call tickets.** A voice WebSocket requires a ticket minted by
  `POST /api/voice/token`, bound to slug + session + origin, claimed once before the upgrade.
- **CSRF defence.** Cookie-authenticated writes must carry `Origin` equal to the request origin.
- **Sessions.** `__Host-` cookie, HttpOnly, Secure, SameSite=Strict, HMAC-SHA256, claim validation
  (issued-at, expiry, role, tenant).
- **Passwords.** PBKDF2-SHA256, 100 000 iterations.
- **Caller PII.** AES-GCM encrypted at rest; redacted before queue writes; masked before any
  provider request.
- **Abuse limits.** Login throttling, per-IP voice reservation keys, `max_concurrent_sessions`,
  and monthly usage reservations per tenant.

Known gaps, stated plainly: no independent penetration test, no measured concurrent-call load
test, and no per-tenant rate limit on the LLM path.

---

## Not included

- **Telephony / SIP.** `src/lib/telephony/` is a lab-only BYON adapter. It is not a working SIP
  trunk, and `release.config.json` keeps `sip: false`.
- **Payments and invoicing.** `/api/client/billing/usage` reports estimated consumption only.
  `release.config.json` keeps `billing: false`; no charge is ever created.
- **Streaming audio to the client.** TTS audio is delivered as one complete MP3 per turn. This is
  the main contributor to perceived response latency and is the next planned change.

---

## Repository layout

```
src/
  index.ts                     Worker entry: routing, portal API, admin API, queue, cron
  agent.ts                     MizanVoiceAgent — STT → manager → LLM → TTS
  lib/
    conversation-manager/      state machine, guards, prompt, evaluator, DB writes
    deepgram-stt.ts            streaming recognition
    elevenlabs-tts.ts          speech synthesis
    tenant.ts  auth.ts  crypto.ts  private-contact.ts  voice-access.ts
public/                        static pages, portal UI, voice page assets
docs/                          internal engineering notes and history
tests/                         local suites (mocked providers) + Playwright
```

`docs/` holds historical sprint logs, audit handoffs and upgrade notes written during
development. They are **not** a description of the current system — this README is. Several of
them describe states that have since been superseded; read them as a development diary, not as
documentation.

---

## License

MIT — see [LICENSE](LICENSE).
