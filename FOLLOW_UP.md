# FOLLOW_UP

On branch `feat/hq-elevenlabs-conversation-engine`, the Gateway now reads ElevenLabs voice settings only from HQ's `_portal_assets.elevenlabs_config` record (voice `JTMaHm6sHVI3NZgPaWDz`, model `eleven_v4_turbo`, speed 0.9, stability 0.4, similarity 0.9), sends MP3 audio through ElevenLabs, and integrates the active caller guard, tenant-scoped learning, and post-call evaluation modules.

Whisper Arabic transcription (`language: ar` with the Egyptian context prompt), the existing LLM primary/fallback flow, WebSocket protocol, and browser MP3 playback remain unchanged; learning persistence uses the existing Gateway D1 schema, and the evaluator redacts phone, national-ID, and email patterns before model review.

Static source checks confirmed these wiring and compatibility invariants, but `wrangler types`, a live ElevenLabs request, and a real browser/device call were not run; no PR, deployment, secret, or runtime setting was changed, and live TTS requires explicit approval to add the `ELEVENLABS_TTS_KEY` Worker secret.
