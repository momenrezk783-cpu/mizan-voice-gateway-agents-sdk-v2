# Mizan — Start Here (verified 2026-11-11)

**One review branch:** `work/mizan-unified-review-20261111` in `momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2`.

This is a review / development consolidation of the current GitHub `main` source and the locally tested voice prompt correction. **It is not a production deployment, not a Cloudflare migration, and not a merge of unrelated Git histories.** Read this file after any interrupted chat or handoff.

## Verified Git references

| Reference | Git ID | Meaning |
| --- | --- | --- |
| `main` | `22e09c6d619c998e4e63fe28599b742b1513edb2` | Production-associated main baseline; last successful GitHub deployment workflow at this SHA as checked 2026-11-11 |
| `feat/mizan-sprints-7-12` | `be786712f7de437dae20d63282f6f9b671c04a23` | **Archived comparison branch** from a separate history (no common Git ancestor). Do NOT merge as-is. |
| local `fix/voice-no-word-cap-no-forced-questions` | `6669fdf94803a4148965ebfa15623a642fb7d8b9` | Voice prompt policy change, parented directly to the `main` baseline |
| `work/mizan-unified-review-20261111` | See HEAD | **Current review branch**; descends from `main` and includes the fix and this document |

Read-only tree comparison: `main` and `feat/mizan-sprints-7-12` had **identical tracked contents** in root `src/`, `public/`, `tests/`, `scripts/`, `docs/`, `package.json`, `schema.sql` and `migration-003.sql`, but different `.github/workflows/deploy.yml`, `wrangler.toml`, `.gitignore` and extra historical/nested files. GitHub could not open a normal PR between those two histories. Do not force-merge them or overwrite production bindings/voice IDs.

## What is implemented and validated on this review branch

- All existing source already on `main` (development history through Sprints 1–12, with staging and SIP lab-only components). No recreation or duplication of the root application was needed.
- Voice prompt policy fix `6669fdf`: removes `aim <= 20 words, max 35 words`, removes required last-question directives, encourages different concrete examples rather than paraphrases, and adds last-position response-policy guidance to counter legacy style restrictions from stored global/tenant prompts.
- Added `tests/voice-response-policy.test.mjs` to the `npm test` chain; pinned TypeScript `5.9.3` after TypeScript 7 broke the existing test transpiler.
- Verified on the isolated local fix worktree: `npm test` exited **0**, including **18/18** Conversation Manager tests, Deepgram tests, voice policy check, security and UI tests. These are local/mock/SQLite tests: **not evidence that real-call latency or conversational loops are fixed.**
- Change audit: `docs/VOICE_PROMPT_CHANGELOG.md`. Git blame traces old wording to imported baseline `7c06517` (`Mizan Implementation <review@local.invalid>`), which **does not identify a particular human or agent**.

## Observation from actual owner test (not a benchmark)

Owner reported voice calls are now possible on `mizanconsult.com`, but perceives delay and assistant repeats itself when asked for new examples, ends too many turns with questions. The text transcript demonstrates generic, repeatedly paraphrased legal-office examples. No measured live end-to-end latency figures were taken in this review.

## Follow-up analysis — NOT implemented here

Current root `wrangler.toml` declares `PRIMARY_LLM=@cf/daily-co/phonellm-mini-alpha-2` and `FALLBACK_LLM=@cf/deepseek-ai/deepseek-v4.1-flash-1017`; verify runtime selection and costs before conclusions. `src/agent.ts` has `maxOutputTokens: 220` for both, `temperature: 0` for primary, last **10 messages** supplied, and nonstreaming `generateText` followed by a full ElevenLabs MP3 `response.arrayBuffer()`. `Deepgram` defaults to `nova-3` in `ar-EG` with endpointing 300ms / utterance-end 1000ms. The manager's `inquiry` path prompts `advance_state(CLOSING)` and can encourage overly early closure. Global/tenant prompts and active `learnings` also come from D1/KV and may disagree with Git text. These are **hypotheses / code findings**, not measured causal attribution.

Before changing models or production: inspect **read-only** current global prompt, tenant customization and active learnings with authorized access; log turn-stage timings (STT end, D1/context, primary or fallback LLM, TTS first byte/full payload, client first audible audio); compare distinct legal-office examples; evaluate model latency/quality/cost offline or in controlled test mode. Changes and live tests require separate approval.

## Safety and deployment boundary

- `main` is the production branch, and `.github/workflows/deploy.yml` triggers on pushes to `main` or `feat/**`. **Do not push to `main`, merge a PR, or dispatch deployment without explicit approval.** This review branch starts with `work/`, outside that automatic trigger.
- `wrangler.toml` retains actual production routes/bindings; it must not be used for speculative dry-runs or replaced with the archived branch version. Do not issue `wrangler deploy`, cloud DB migrations, changes to R2/D1/KV/Durable Objects or live Workers AI calls just to validate this archive.
- Staging config template has placeholders; lab SIP is not proof of live telephony. See `docs/RELEASE_GO_NO_GO.md`, `docs/TEST_EVIDENCE.md`, `PROJECT_STATE.md` and `DECISIONS.md` for history and outstanding gates.
- Preserve `feat/mizan-sprints-7-12` as a historical reference until an explicit separate decision about deletion. Its differing workflow/config may affect deployment if merged.

## How to compare and continue

- Canonical review compare URL: `https://github.com/momenrezk783-cpu/mizan-voice-gateway-agents-sdk-v2/compare/main...work/mizan-unified-review-20261111`
- When resuming: check `git branch --show-current`, `git status --short`, `git log -3 --oneline`, read this document, then inspect `docs/VOICE_PROMPT_CHANGELOG.md` and recent test evidence.
- A GitHub PR from this review branch should show only the new prompt policy change, regression test, dependency pin, and documentation. **It is intentionally not an archive-to-main merge.**
