# Mizan Voice Gateway — Release decision

Decision (2026-11-10): **NO-GO** for production, **local development/PoC only**.

## Evidence

| Gate | Status | Proof or blocker |
|---|---|---|
| Local regressions | PASS | `docs/evidence/sprint12-local.log`, `sprint12-exit.txt` = 0, 18/18 conversation tests |
| Lab PCMU and PBX routing | PASS (mock only) | `tests/telephony-lab.test.mjs`, `tests/telephony-route.test.mjs` |
| Tenant-scoped CRM + reporting SQL | PASS (SQLite only) | `tests/crm-workflow.test.mjs`, `tests/billing-usage.test.mjs` |
| Cloudflare TypeScript / bundle | BLOCKED | No dependency install or lock; `build-check-exit.txt` = 2 |
| Isolated Cloudflare staging | BLOCKED | `wrangler.staging.toml` not provisioned; `staging-check-exit.txt` = 2 |
| Live Deepgram + ElevenLabs end-to-end | UNVERIFIED | No authorized live-call tracing |
| SIP PBX / legal carrier route | UNVERIFIED | No SIP server, gateway, carrier permission or RTP interoperability test |
| Billing sandbox + invoicing | UNVERIFIED | No selected licensed provider, sandbox or tax/pricing policy |
| Full security review + load test | UNVERIFIED | Synthetic SQLite tests are not a penetration or cloud stress test |

## Operator-safe next steps

1. In a dedicated staging Cloudflare account or isolated resources, provision Worker/D1/KV/Queue and credentials; **do not reuse** production IDs or domains.
2. Copy `wrangler.staging.example.toml` to ignored `wrangler.staging.toml`, set real staging-only IDs and hostname, then run `npm run staging:check`.
3. Review/pin dependencies and commit a lock file; run `npm ci`, `tsc --noEmit`, `npm run build` (Wrangler dry-run only) and full regressions in CI.
4. Apply database schema and migration 001-003 to **STAGING ONLY**, and test backup/restore. Avoid `npm run db:migrate*` because current scripts target production.
5. Test 2+ real browser voice calls in a controlled staging environment, log time to first speech, interruptions and end states (no caller PII).
6. Build a separate authenticated SIP gateway and run a lab PBX transfer/hangup test; verify provider rules and telecom permissions before any real business number.
7. Decide and test billing provider, tax, usage rounding, reconciliation and invoice semantics in sandbox, with NO charges until explicit authorization.
8. Run independent security/privacy review and measurable concurrent call load test before changing this release decision.

## Rollback principle

No release was performed here, so no rollback is required today. Before a future release, record the deployed Worker version, D1 backup strategy, queue compatibility and tested restore procedure. Never make destructive migration changes without an approved recovery plan.
