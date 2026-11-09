# FOLLOW_UP

On branch `feat/hq-elevenlabs-conversation-engine`, the HQ `_portal_assets.elevenlabs_config` voice was switched to the alternate Mizan ElevenLabs voice ID `P2DK6Lg0vxyKGYj3QOik` and read back successfully. The unwanted former public/global voice ID was replaced with this selected ID in the Gateway's global fallback, tenant-creation fallback, migration, and schema; neither retired ID is retained in the active repository files.

No deployment, PR, or merge to `main` was performed; runtime D1 defaults for existing global/tenant rows may still need migration/update separately. Whisper's repeated hallucinated transcript remains unresolved and was not changed.

Whisper review on this branch found an Arabic/Egyptian `initial_prompt`, `vad_filter: false`, and a server flush threshold of only 1,600 samples; the browser worklet uses a fixed RMS threshold of 0.012 and closes utterances after 650 ms of silence. These are plausible contributors to hallucinated transcripts, not a confirmed root cause; a separate fix branch removes the prompt and sample sanitization but has no runtime/build verification, so it was not merged or copied.

The selected voice ID changes are already present on this branch and verified in the repository files and prior D1 read-back; no additional source commit, PR, deployment, or merge was made during this review. Next step: capture a consented raw PCM/WAV sample and test it against Whisper with and without VAD/prompt settings before changing the live pipeline.