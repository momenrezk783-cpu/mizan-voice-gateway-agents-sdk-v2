# Mizan — Delivery review after Sprints 9 and 10

Date: 2026-11-10. Isolated development copy; no remote production changes.

| Sprint | Commit | What was implemented | Files | Verified tests | Before → after | Risks left |
|---|---|---|---|---|---|---|
| 9 | `525c798` | Tenant-isolated status workflow for existing `client_queries`, with client portal follow-up list and status selector | `src/lib/crm.ts`, `src/index.ts`, `public/client.html`, `src/lib/ui-assets.ts`, `tests/crm-workflow.test.mjs` | `npm test` exit 0, `docs/evidence/sprint9-local.log`; actual SQL tested with SQLite cross-tenant attempt | Calls produced tickets without a working follow-up workflow → authenticated, scoped list and status updates | Still not full CRM: no assignment, audit trail, deduplication, data retention or live integrated auth testing |
| 10 | `45a92f4` | Read-only monthly per-tenant usage, explicit no-invoice/no-payment state, removed unapproved fixed prices | `src/lib/billing.ts`, `src/index.ts`, `public/client.html`, `src/lib/ui-assets.ts`, `tests/billing-usage.test.mjs` | `npm test` exit 0, `docs/evidence/sprint10-local.log`; real SQL uses UTC month bounds and tenant filter | No verifiable usage panel and prototype prices looked official → recorded call counts/durations with clear estimate labeling | Not an accounting meter, no price policy, external payment or webhook sandbox, tax handling or approved invoices |

## Data safety

- New CRM endpoint does not write any new raw caller phone numbers; it works with existing query records.
- Existing CRM tables already contain plaintext fields; privacy review and retention still required.
- Date aggregation is UTC and excludes active sessions from elapsed duration until ended; it is not a carrier bill.

## Decision

**Local workflows tested, not production ready.**
