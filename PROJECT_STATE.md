> **LATEST VERIFIED STATUS (2026-11-11):** The authoritative GitHub baseline is `main` at `22e09c6`; the GitHub feature branch `feat/mizan-sprints-7-12` at `be78671` has unrelated Git history but identical root application code. The new review branch `work/mizan-unified-review-20261111` starts from `main` and includes voice prompt fix `6669fdf`. **START HERE:** `docs/START_HERE_MIZAN.md`. The historical notes below describe the earlier isolated ZIP workflow and should not be interpreted as the current GitHub state. No production deployment is authorized by this record.

# Mizan — Project Source of Truth

_Last reviewed: 2026-11-10, after isolated local Sprints 7–12. Status: **development / laboratory snapshot only — NO-GO for production**._

> Read this file, `DECISIONS.md`, `SPRINT_LOG.md` and `docs/TEST_EVIDENCE.md` before starting a sprint. The code and test logs, **not conversational claims**, determine completion.

## Authoritative working copy

- Current working tree: independent Git continuation of the six-sprint ZIP, now containing local development implementation for Sprints 7–12. The ZIP remains the frozen parent baseline, not the current source.
- Source ZIP SHA-256: `d026f62a56be584271ca36a2ff2ff93502f4cc0c5c3f575714f0dfd504741f1a`.
- Before adding documentation, **all 39 file contents** in this working tree matched the ZIP byte-for-byte.
- Git history restored from the independently verified local Sprint 1–6 working repository (no remote configured). Pre-documentation HEAD: `8074bf671ef80ccb786fb499c192a566f10069fd`.
- The working tree must not be described as "same as GitHub main". The remotely cloned GitHub public repository reported HEAD `671ebcc` on 2026-11-10, and its source/test structure differs from the six-sprint ZIP.
- Never push to `main` without independent approval: `.github/workflows/deploy.yml` automatically deploys on pushes to `main`.

## Current continuation — Sprints 7–12

- Development work has progressed locally through six continuation commits, starting with `e417a1e` (Sprint 7) and ending at the latest commit shown by `git log` (Sprint 12). See `SPRINT_LOG.md` and paired deliverables `docs/SPRINT_7_8_REPORT.md`, `docs/SPRINT_9_10_REPORT.md`, and `docs/SPRINT_11_12_REPORT.md`.
- Last verified `npm test` **passed**: `docs/evidence/sprint12-exit.txt` = `0`; includes 18/18 conversation tests, audio lab, safe SIP mapping, CRM SQL isolation, usage reports, and static UI tests.
- The local test success does **not** override `docs/RELEASE_GO_NO_GO.md`: **NO-GO**. `npm run release:gate`, `npm run build`, and `npm run staging:check` all returned exit `2` for documented blockers.
- Files in `docs/SNAPSHOT_SPRINT6.sha256` intentionally refer to the original frozen Sprint 6 snapshot; comparisons against the now-modified Sprint 7–12 source should fail. Never edit those source checksums retroactively.
- Public GitHub repository was **not pushed or reconciled**. No deployment to Cloudflare occurred.

## What is verified

- `npm test` **passed locally** on this exact 39-file snapshot on 2026-11-10 (exit status 0).
- Conversation-manager suite: **18/18** passed.
- Mocked Deepgram streaming/recovery tests, security/product checks, browser JS parsing, SQL checks, embedded UI asset check: passed per raw log `docs/evidence/baseline-local-2026-11-10.log`.
- These tests contain mocks/static checks and SQLite; they are **not** evidence of cloud deployment, live PSTN/SIP interoperability or live voice quality.

## Unverified / blocking release gates

1. Full dependency lock + `tsc --noEmit`/Wrangler Worker bundling. Existing `build` script is a test command and not a production bundle.
2. Cloudflare Staging with distinct Worker/D1/KV/Queue resources and complete migration inventory. **Never run `db:migrate` against production**.
3. Real end-to-end voice calls with approved credentials; measured audio latency and interruption behavior.
4. Signed short-lived per-call authorization, anti-abuse controls and additional security/privacy review.
5. Billing, full CRM and SIP/PBX are **not implemented by the Sprint 1–6 snapshot**.
6. Public GitHub checkout is not proven equal to this working copy. Reconciling repositories is an explicit future task, not an assumed merge.

## Approved upcoming direction — no implementation claim

- Sprints 7–12 approved for implementation in an isolated environment with tests after every sprint, paired delivery reports after 8/10/12, and **no production deploy**.
- SIP architecture: **Bring Your Own Number** (retain company telephone numbers). Prioritize a vendor-neutral telephony adapter and **lab-only SIP/PBX proof of concept**, not number sales or live carrier integration.
- Gate any telephony deployment on telecom provider/authorization, audio bridge testing, and caller privacy/recording requirements.

## Update rule

After each sprint: record exact Git commit, changed files, commands and exit codes, elapsed/live-call metrics if genuinely measured, before/after observations, unmet checks, and open risks in `SPRINT_LOG.md` and `docs/TEST_EVIDENCE.md`. Do not mark a test PASS on the basis of a previous chat message.

## Quick integrity checks

```sh
# Source snapshot compatibility (expected to FAIL once source files are intentionally changed)
sha256sum -c docs/SNAPSHOT_SPRINT6.sha256
# Actual regression suite
npm test
# Inspect local changes and history
git status --short && git log -3 --oneline
```
