# Mizan profile, quotations and private call contacts

This source change has not migrated or deployed production. It keeps the existing
Deepgram STT, Workers AI language model and ElevenLabs TTS configuration.

## Deployment order

1. Back up production D1 using the existing operational procedure. Preserve the
   existing `CONTACT_ENC_KEY` and `SESSION_SECRET`; do not rotate them for this upgrade.
   The AES-256 key may be encoded as base64 (32 decoded bytes) or 64 hex digits;
   both represent the same 32-byte key and require no key rotation.
2. After migrations 001–004, apply only the additive, repeatable migration:
   `npx wrangler d1 execute mizan-portal-db --remote --file=./migration-005.sql`.
   Do not rerun `schema.sql` on production. This step requires an authorized
   production maintenance session; it was not performed during implementation.
3. Merge the reviewed PR. Main triggers production deployment; its read-only
   schema check refuses deployment if the new tables/columns are absent.
4. Verify the published public pages, submit a test quotation, review and close it
   as superadmin, then test a real call and its private form. Check voice quality
   with the configured providers; mocked automated tests cannot establish it.

Migration 005 adds `call_contact_details`, `quote_requests`, and
`quote_intake_limits`. It does not rewrite existing contacts. Call detail reads
retain legacy encrypted name/phone fallback. For rollback, deploy the previous
Worker and leave the additive tables and encrypted data intact; do not drop them.

## Public content and administration

- Edit approved identity/services/packages in `src/lib/mizan-profile.ts` and page
  content in `src/lib/public-pages.ts`, then run `npm run assets:sync` and commit
  generated HTML and UI assets. No public numeric prices, minutes or discounts.
- Quotations are free and reviewed manually under the superadmin dashboard's
  quotation section. The form stores an encrypted request, not an email delivery.
  Email links open the visitor's mail client. No automatic notifications exist.
- Request lifecycle: new → contacting → closed, editable by superadmin only.
  Intake is bounded and rate limited. The rate key is an HMAC, not a stored IP.
- Voice Private describes a custom project available by quotation. No automated
  customer infrastructure provisioning or isolation guarantee is introduced.

## Call privacy behavior and boundaries

- The caller acknowledges the warning before microphone permission. When contact
  details are needed, a structured form pauses browser audio capture forwarding
  and server STT. Only that call's active connection and current request ID can
  submit. Confirmed fields are encrypted together with tenant/session scope.
- Resume requires the matching handshake and a fresh STT connection. Manual mute
  remains in force. Failure to reconnect leaves the microphone paused; end and
  retry. Cancellation does not execute a pending business action. Closing the
  call clears form inputs. No form data is stored in browser storage.
- Model tools cannot set/confirm personal contact slots. The business action may
  use confirmed data server-side; LLM, TTS and evaluation receive masked context.
  A phone number typed by a caller does not authenticate CRM history access.
- This is data minimization, not a promise that no personal data reaches voice
  providers: speech before the form can contain personal data and heuristic
  redaction is incomplete. Provider processing, retention, contracts and legal
  obligations require their own review. Cloudflare storage does not imply Egypt
  residency. No claim of full statutory compliance or certification is made.
- Embedded calls use the same form inside an iframe. Register the exact HTTPS
  tenant domain; only that origin and the service origin may frame the call.
  The host page must delegate microphone permission to the iframe. Its own
  Permissions-Policy can block microphone access; test the actual host page.

## Verification

`npm ci`, `npm run release:gate`, `npx playwright install chromium`, and
`npm run test:browser`. Browser tests run with mocked WebSocket/providers and real
Chromium microphone/worklet processing. They cover mobile/desktop public pages,
quotation error/retry/success, admin review, warning, zero audio forwarding during
the form, resume, manual mute and embedded lifecycle. Server tests cover access
control, encryption, concurrent rate limiting, stale submissions, tenant scope
and exclusion of confirmed private values from provider/evaluation payloads.

CI runs both the release gate and browser tests before deployment. Test-generated
screenshots are local artifacts, not application assets.
