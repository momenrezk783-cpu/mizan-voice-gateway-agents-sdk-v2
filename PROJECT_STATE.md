# Mizan — Project Source of Truth

_Last verified: 2026-11-10 18:33 UTC. Status: **development snapshot only**._

> Read this file, `DECISIONS.md`, `SPRINT_LOG.md` and `docs/TEST_EVIDENCE.md` before starting a sprint. The code and test logs, **not conversational claims**, determine completion.

## Authoritative working copy

- Current working tree: the isolated copy delivered as `mizan-voice-gateway-v2-six-sprints.zip`, plus this documentation/checkpoint.
- Source ZIP SHA-256: `d026f62a56be584271ca36a2ff2ff93502f4cc0c5c3f575714f0dfd504741f1a`.
- Before adding documentation, **all 39 file contents** in this working tree matched the ZIP byte-for-byte.
- Git history restored from the independently verified local Sprint 1–6 working repository (no remote configured). Pre-documentation HEAD: `8074bf671ef80ccb786fb499c192a566f10069fd`.
- The working tree must not be described as "same as GitHub main". The remotely cloned GitHub public repository reported HEAD `671ebcc` on 2026-11-10, and its source/test structure differs from the six-sprint ZIP.
- Never push to `main` without independent approval: `.github/workflows/deploy.yml` automatically deploys on pushes to `main`.

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
