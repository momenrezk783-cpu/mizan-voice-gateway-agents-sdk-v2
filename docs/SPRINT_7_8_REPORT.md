# Mizan — Delivery review after Sprints 7 and 8

Date: 2026-11-10. Source baseline: `155eeaf`. Implemented locally only; **no production or staging deployment**.

| Sprint | Commit | What was implemented | Files | Verified tests | Before → after | Risks left |
|---|---|---|---|---|---|---|
| 7 | `e417a1e` | Vendor-neutral, **lab-only** G.711 PCMU/PCM audio adapter and bounded packet sequencing; staging-only config template + fail-closed guard; build script no longer masquerades as an STT test | `src/lib/telephony/adapter.ts`, `wrangler.staging.example.toml`, `scripts/check-staging-config.mjs`, `scripts/verify-build.mjs`, `package.json`, tests | `npm test` exit 0, `docs/evidence/sprint7-local.log` | No telephony audio boundary or staging safety guard → tested synthetic frames and production/staging separation checks | No SIP signalling, RTP gateway, actual PBX, credentials, cloud build, provisioned staging |
| 8 | `0317b9c` | Extracted login throttling; recent-sample latency P50/P95; removed fabricated stats/charts/rating from client dashboard, with real latest-100-sessions caveat | `src/lib/login-throttle.ts`, `src/lib/operational-metrics.ts`, `src/index.ts`, `public/client.html`, `src/lib/ui-assets.ts`, tests | `npm test` exit 0, `docs/evidence/sprint8-local.log` | Fake weekly numbers and unsupported survey scores → data-derived recent counts or unmeasured state | Full type-check, live UI device testing, load benchmark and telemetry dashboard remain unverified |

## Failure/limit evidence

- `npm run staging:check` exits 2 by design until staging resources are separately provisioned.
- `npm run build` exits 2 because deps are not installed. npm registry access failed with `EAI_AGAIN` locally.
- Test mocks and local SQLite cannot establish telephone interoperability or Cloudflare service quality.

## Decision

**Local implementation accepted for further development; release remains blocked.**
