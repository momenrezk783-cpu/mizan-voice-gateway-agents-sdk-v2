# Evidence register — Mizan Voice Gateway v2

Evidence recorded 2026-11-10 18:33 UTC. Never conflate local/remote GitHub checkouts or mocked/live tests.

## E-001 — Archived starting source

- Artifact filename: `mizan-voice-gateway-v2-six-sprints.zip` (uploaded in this ChatGPT project).
- SHA-256: `d026f62a56be584271ca36a2ff2ff93502f4cc0c5c3f575714f0dfd504741f1a`.
- Source files: 39. All extracted file contents matched source in new independent Sprint 7–12 worktree.
- Git commit of source snapshot before adding this documentation: `8074bf671ef80ccb786fb499c192a566f10069fd`.
- Frozen per-file checksums: `docs/SNAPSHOT_SPRINT6.sha256`.

## E-002 — Local regression of exact E-001 source

- Command: `npm test`.
- Exit code: `0` (PASS).
- Preserved output: `docs/evidence/baseline-local-2026-11-10.log`.
- Included suites: Deepgram transport and reconnection mocks; conversation manager (18 passed / 0 failed); security/product checks; UI acceptance; SQL integration and `assets:check`.
- TypeScript test harness uses transpilation, **not** full static type-check or Workers runtime validation.

## E-003 — Remote developer environment / source mismatch

- Remote Desktop Commander device: `localhost` (online at check).
- Remote tools: Node.js v24.22.1; npm 11.12.1; Git 2.54.0; Python 3.14.10.
- Public repository URL (user-supplied): `https://github.com/momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2.git`.
- `git ls-remote ... HEAD` and an independent isolated remote clone reported commit `671ebcc0c78b34b35470931c06244905e287c71c`.
- Remote checkout includes both root and nested `mizan-voice-gateway-v2/` projects and its root test script runs only two test files. Therefore **remote npm test on that checkout cannot prove E-001 code passes**.
- Nothing from E-001 has been deployed, pushed or written into a production repo by this check.

## Outstanding gates

| Gate | Evidence needed | Status |
|---|---|---|
| Complete dependency install and lock | `npm ci`, lockfile, tool versions | NOT VERIFIED |
| Full TypeScript check | `tsc --noEmit` with proper tsconfig/dependencies | NOT VERIFIED |
| Wrangler bundle validation | `wrangler deploy --dry-run` pointing at isolated configuration | NOT VERIFIED |
| Staging and D1 migrations | Isolated resource IDs, migration inventory, smoke tests | NOT VERIFIED |
| Live end-to-end voice | Provider-approved call traces and latency metrics | NOT VERIFIED |
| SIP/PBX integration | Authorized lab PBX, RTP bridge tests, BYON routing | NOT IMPLEMENTED |
| Production release | Explicit separate approval and rollback procedure | NOT AUTHORIZED |

## E-004 — Sprint 7 continuation / lab-only results

- `npm test`: exit 0, full stdout/stderr in `docs/evidence/sprint7-local.log`. Adds PCMU/PCM audio bridge tests, bounded payload / replay / tenant routing lifecycle tests, and fail-closed Staging config checks.
- `npm run staging:check`: intentionally exits 2 because isolated `wrangler.staging.toml` does not yet exist. Source config is a template only.
- `npm run build`: intentionally exits 2 because Wrangler dependencies are absent (npm registry returned EAI_AGAIN in this environment). No full Worker bundling was performed.
- Tests simulate media frames; **not evidence of real SIP signalling, RTP, live latency or carrier interoperability**.

## E-005 — Sprint 8 local correctness and truthful UI

- `npm test`: exit 0; evidence file `docs/evidence/sprint8-local.log`.
- Added sampled latency p50/p95 helper tests and UI tests for fixed fake numbers; moved login throttle into dedicated module while preserving its call sites.
- The new latency fields are **sample-based estimates**, not network uptime or voice quality certification.
- Full Worker build, cloud load and browser/device E2E remain NOT VERIFIED.

## E-006 — Sprint 9 tenant follow-up workflow

- `npm test` exit 0, `docs/evidence/sprint9-local.log`.
- SQLite test proves tenant A cannot mutate tenant B's request through the production UPDATE statement and validates allowed status values.
- Real authenticated Cloudflare/D1 API/browser integration still unverified (dependency/staging blocker).

## E-007 — Sprint 10 read-only usage report

- `npm test`: exit 0, `docs/evidence/sprint10-local.log`. SQLite exercised actual SQL with multiple tenants and adjacent UTC months.
- No invoices are issued; usage is estimated from completed `call_sessions` durations only and is not tariff- or carrier-verified metering.
- No payment gateway or webhook is connected (not verified).

## E-008 — Sprint 11 SIP routing and SEO

- `npm test`: exit 0 from detached process, stored in `docs/evidence/sprint11-exit.txt`; log `docs/evidence/sprint11-local.log`.
- Trusted-PBX route tests reject unknown peers, invalid numbers and duplicate/ambiguous mapping. The test assumes an upstream trusted identity; it does **not** establish authentication or SIP interoperability.
- SEO test verifies canonical tags and non-public paths omitted from sitemap. No search-engine indexing measurement.
