# FOLLOW_UP

On branch `fix/remove-response-language-and-raw-audio-checks`, removed the custom Whisper `initial_prompt` and the extra LLM response-language instructions, while preserving Whisper's `language: "ar"` and the existing TTS language configuration.
Removed the added per-sample clamp/invalid-value sanitization from raw Float32 audio conversion; the PCM worklet's existing speech detection and chunking were left unchanged, and no raw-audio logging was present in the inspected files.
Source changes were reread for verification, but no build, runtime test, PR, merge, or deployment was performed; `main` and Production remain unchanged.

On branch `feat/hq-elevenlabs-conversation-engine`, updated `.github/workflows/deploy.yml` to install dependencies compatibly with the updated package manifest, limit push deployments to the gateway project subtree, and serialize Production deploy jobs. The ZIP source has not yet been committed and no deployment was triggered; next step is to sync the archive into `mizan-voice-gateway-v2/` and verify the resulting GitHub Actions run.