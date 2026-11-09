# FOLLOW_UP

On branch `fix/remove-whisper-context-prompt`, removed the custom Egyptian-Arabic `initial_prompt` from the Cloudflare Whisper request as requested, while preserving `language: "ar"` so transcription remains Arabic-only.

Verified by rereading the updated source: the custom prompt is absent and `language: "ar"` remains; no runtime test or deployment was performed.

No PR has been opened and `main`/Production were not changed; next step is review and, if approved, open a PR.
