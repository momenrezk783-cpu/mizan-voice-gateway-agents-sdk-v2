# Voice conversation policy — traceability

## 2026-11-11: Remove word caps and obligatory questions

**Change reason:** The Mizan HQ test call repeated descriptions instead of providing distinct examples and routinely finished answers with a question. The owner explicitly asked to remove fixed 25-word-style limits and routine follow-up questions.

**Historical provenance:** `git blame` on `origin/main` maps the `aim <= 20 words, max 35 words` line and the mandatory closing-question instructions to baseline commit `7c06517` (2026-11-10 17:13:26 UTC), author metadata `Mizan Implementation <review@local.invalid>`. This is a git author label, **not** proof of which individual or agent originally wrote the policy. The same prompt line also existed in the older `671ebcc` repository snapshot, where Git can only attribute it to the original imported/root commit, not identify the person or agent who created the wording.

**Scope:** `src/lib/conversation-manager/prompt.ts` and `manager.ts`; new regression test `tests/voice-response-policy.test.mjs` and npm test integration. Clarifying questions required for missing fields still work; only artificial word counts and forced closing questions are removed.

**Runtime caveat:** A stored `global_voice_config.system_prompt`, tenant customization, or learned rule in Cloudflare D1/KV might contain additional restrictions not visible in git. The assembled prompt now ends with an explicit overriding response policy. Production D1 and Cloudflare settings were not accessed or modified.

**Test compatibility:** The installed TypeScript `7.0.2` caused existing tests to fail (`ScriptTarget` undefined). The project now pins `typescript` to tested `5.9.3` rather than `latest`; this is unrelated to runtime behavior, and makes the new regression test and legacy suite runnable in CI.

**Deployment:** Not deployed, not pushed. The work is isolated in a local Git branch until explicitly approved for publication.
