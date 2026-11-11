# Hardening upgrade and operator cheat sheet

This change has not been deployed. The original archive is unchanged.

## What changed

- POST `/api/voice/token` accepts `{ "slug": "your-tenant" }` from the same origin.
  It returns a server-generated sessionId and a signed 60-second call ticket.
  The public call page obtains a new ticket for each attempt. WebSocket clients
  must send the matching Origin, session_id and call_token. Tickets are single use.
- Atomic D1 reservations enforce tenant concurrency before agent creation.
  Each tenant gets at most 60 admissions/hour and each hashed IP gets 10/hour
  across tenants. Failed/cancelled admissions count toward budgets; unclaimed
  capacity expires after 60 seconds. These public admission limits reduce abuse;
  they are not caller identity verification or a substitute for edge DDoS protection.
  Adjust constants/SQL in `src/lib/voice-access.ts` to change these limits.
- Calls end after 25 minutes; the agent uses the reservation's actual deadline.
  Capacity is released on close and failed upgrades. Cleanup excludes live leases.
- Tenant business context/customization and additional industry restrictions reach
  new prompts while the code-owned persona and safety rules take precedence.
  Legacy globalPrompt is never forwarded; global persona editing is disabled.
- Saved global/HQ voices take precedence over the environment fallback; explicit
  tenant voices are supported for non-HQ calls.
- CRM contact payloads (including names, phones, email and summaries) use AES-GCM.
  Phone lookups use tenant-bound HMAC keys. No new plaintext CRM writes are made.
- Redaction normalizes Arabic/Persian digits and covers formatted phones, emails
  and 14-digit IDs. It is heuristic: names and arbitrary free-text identifiers are
  not guaranteed to be anonymized. Stored transcripts are not fully anonymous.
- Queue writes deduplicate transactionally; retries preserve the original call end.
- Update APIs validate payloads and missing rows; streamed bodies are limited to 64 KiB.
- Disabled guards display correctly. CI validates PRs, then gates main deployment
  with release evidence and a separate production environment.

## Before deploying (staging first)

1. Back up D1. On a fresh database apply `schema.sql`, then migration 001, 002, 003,
   and 004 in order. On an existing installation apply only missing migrations;
   001/002 contain ALTER statements and must not be blindly rerun.
2. Apply `migration-004.sql` to your isolated staging D1 **before** the new Worker.
   Example after provisioning the ignored staging config:
   `npx wrangler d1 execute mizan-portal-db-staging --remote --config wrangler.staging.toml --file migration-004.sql`
   Review account/database IDs first. The existing `db:migrate*` scripts target production.
3. Keep CONTACT_ENC_KEY unchanged: base64 of exactly 32 random bytes. SESSION_SECRET
   must contain at least 32 characters. Configure these as Worker secrets, never in source.
   Changing CONTACT_ENC_KEY requires re-encrypting contacts and recomputing lookup keys.
4. Deploy the reviewed staging Worker. In a maintenance window, as a signed-in
   super_admin, call POST `/api/admin/privacy/migrate-crm` with JSON `{}` on that
   same staging origin. Each request migrates up to 50 legacy rows atomically per row.
   Repeat until `remaining` is zero. Existing secure rows win on conflicts.
   Returning-caller lookup uses only the secure table; complete the migration before
   reopening calls. The operation moves existing personal data; handle backups and
   database history under your retention policy too. Migration does not encrypt old
   call_turns or guarantee historical free-text redaction.
5. Verify a returning caller, two simultaneous admissions at the tenant limit,
   replay rejection, saved business context, chosen voice and a real interrupted call.
   Test duplicate queue delivery and the maximum-call-duration path.
6. Configure GitHub's `production` environment with required reviewers and main-only
   deployment branches. Workflow YAML cannot create those account settings. The
   release gate executes TypeScript, regressions and the isolated bundle check on
   the current checkout. SIP and billing evidence is required only when enabled
   in `release.config.json`. See `docs/RELEASE_GATE.md`; do not create placeholder
   evidence. Browser releases do not depend on an ignored staging config file.
7. Repeat migration/deployment validation for production only after staging review.
   No production migration, credential change, or deployment was performed here.

## Local verification

```sh
npm ci
npm run typecheck
npm test
npm run bundle:check
```

Tests use SQLite, mocked providers and mocked HTTP upgrade routing. The dry-run uses
fixture resources and does not deploy. They do not establish live provider quality,
accent, SIP interoperability, browser microphone behavior, or Cloudflare load limits.

Keep `background_events` for at least the maximum queue retention/replay horizon.
Do not delete deduplication markers while those messages can be replayed.
Admissions are retained for 24 hours; hourly budget keys are HMACs, not raw IPs.

## Rollback

Back up before migrating. The schema addition is non-destructive, but moving legacy
CRM rows changes which app version can read them. An old Worker cannot read secure
contacts; do not blindly downgrade after migration. Retain the key, database backup
and matching Worker version, and test restore in staging before production rollout.
