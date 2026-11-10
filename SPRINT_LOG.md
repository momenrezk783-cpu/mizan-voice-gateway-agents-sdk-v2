# Mizan — Sprint Execution Ledger

This is a verification ledger, not an optimistic project plan. For historical details see `docs/SPRINT_IMPLEMENTATION_REPORT.md`; treat claims without independent logs as unverified where noted.

| Sprint | State | Main changes | Verified evidence | Git reference |
|---|---|---|---|---|
| 1 | Local implementation reported; baseline regression rechecked | Session TTL, XSS escapes, honest empty states, portable test harness | Current `npm test` succeeds; not separately re-run at exact sprint checkpoint in this session | `0c6b3d4` |
| 2 | Local implementation reported; baseline regression rechecked | Login throttling, Origin checks, STT reconnect status | Current `npm test` succeeds; migration-003 not deployed | `57ef005` |
| 3 | Local implementation reported; baseline regression rechecked | Tenant-scoped search, DOM rendering | Current `npm test` succeeds; no live tenant test | `97a03af` |
| 4 | Local implementation reported; baseline regression rechecked | Truthful booking, validation, batched tenant create | Current `npm test` succeeds; no booking provider tested | `8fb2424` |
| 5 | Local implementation reported; baseline regression rechecked | Realistic KPIs, browser hardening, CSV improvements | Current `npm test` succeeds; no network performance measurement | `954b8b4` |
| 6 | **Validated local baseline** | Audio replay, WebSocket origin/ID, final acceptance regression | Exit 0; 18/18 conversation tests; mock Deepgram; other checks — `docs/evidence/baseline-local-2026-11-10.log` | `8074bf6` |
| 7 | **Not started** | Staging/build readiness + initial SIP adapter PoC (scope to be verified) | None | — |
| 8 | **Not started** | Modularization, monitoring, load baseline | None | — |
| 9 | **Not started** | Basic CRM follow-up | None | — |
| 10 | **Not started** | Billing/usage; sandbox payments | None | — |
| 11 | **Not started** | Integrations/knowledge/SEO; telephony PoC expansion | None | — |
| 12 | **Not started** | Final end-to-end gates and launch decision | None | — |

## Baseline verification event — 2026-11-10 18:33 UTC

- Compared current working tree to delivered Sprint 6 ZIP: **39/39 files identical**.
- Ran `npm test` in that working tree: exit code **0**. Conversation manager: **18/18**. Deepgram simulated STT, security/product, acceptance and `assets:check`: passed.
- Inspected remote developer machine via Remote Desktop Commander: reachable, Node.js v24.22.1, npm 11.12.1, Git 2.54.0, Python 3.14.10. Its public GitHub checkout reports HEAD `671ebcc`, **not proven to match** this baseline.
- **No staging deployment, live voice call, full TypeScript/Wrangler build, or production change** has been performed as part of this checkpoint.

## Future sprint entry template

`Date | Sprint | Starting commit | Ending commit | Changed files | Tests (commands, exit codes, logs) | Before/after | Outstanding blockers | Release decision`.

## Sprint 7 continuation — 2026-11-10 (local)

- Starting commit: `155eeaf`. Deliverables: `src/lib/telephony/adapter.ts` (lab-only vendor-neutral PCMU/PCM interface), Staging template, fail-closed Staging config guard, genuine build preflight that refuses to claim a build without Wrangler/dependencies.
- `npm test`: PASS (exit 0), full output `docs/evidence/sprint7-local.log`; lab audio/packet tests and staging guard both PASS.
- `npm run staging:check`: BLOCKED (exit 2), because live Staging bindings/config are not provisioned.
- `npm run build`: BLOCKED (exit 2), because npm dependency install is unavailable. **Do not call this Sprint production ready.**
- No SIP server, live telephony, Cloudflare staging deployment, migrations or production changes occurred.

## Sprint 8 continuation — 2026-11-10 (local)

- Starting commit `e417a1e`. Extracted login throttle functions into `src/lib/login-throttle.ts`; added bounded, PII-free p50/p95 aggregation over the latest 500 turn latencies to assistant-status; replaced fabricated client dashboard counts, monthly comparisons, satisfaction rating, and weekly graph with non-fabricated placeholders / data derived from the latest 100 sessions.
- Corrected semantics: completed call != resolved call; 'weekly' covers only latest 100 records, not all-time dataset.
- Tests: `npm test` PASS exit 0; see `docs/evidence/sprint8-local.log`, includes 18/18 conversation, static UI acceptance and latency percentile checks.
- Remaining sprint-8 scopes: complete TypeScript compile / Wrangler dry run, staging telemetry and live load baseline (blocked by remote dependency/config availability). No production resources were touched.

## Sprint 9 continuation — 2026-11-10 (local)

- Starting commit `0317b9c`; integrated tenant-scoped `client_queries` read/status-update APIs and safe browser follow-up table, supporting open/in_progress/closed/cancelled.
- `npm test`: PASS exit 0, `docs/evidence/sprint9-local.log`; includes SQLite cross-tenant mutation isolation and status validation.
- Scope explicitly **basic CRM follow-up**, not contact merging, assignment, end-to-end production CRM or privacy certification; no new raw phone/email storage introduced.
- No migrations or remote changes; existing `client_queries` requires migration-002 applied in target environment.
