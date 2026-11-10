# FOLLOW_UP

On branch `fix/remove-response-language-and-raw-audio-checks`, removed the custom Whisper `initial_prompt` and the extra LLM response-language instructions, while preserving Whisper's `language: "ar"` and the existing TTS language configuration.
Removed the added per-sample clamp/invalid-value sanitization from raw Float32 audio conversion; the PCM worklet's existing speech detection and chunking were left unchanged, and no raw-audio logging was present in the inspected files.
Source changes were reread for verification, but no build, runtime test, PR, merge, or deployment was performed; `main` and Production remain unchanged.

Rollback preparation: PR #18 UI refresh is reverted on branch `revert/pr-18-preline-ui-refresh` by restoring the seven affected source files to the pre-PR base and removing the two added UI assets. No merge or production deployment has been performed; run build and voice regression checks before merging.
