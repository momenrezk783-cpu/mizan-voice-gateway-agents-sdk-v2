# FOLLOW_UP

On branch `feat/hq-elevenlabs-conversation-engine`, the HQ `_portal_assets.elevenlabs_config` voice was switched to the alternate Mizan ElevenLabs voice ID `P2DK6Lg0vxyKGYj3QOik` and read back successfully. The unwanted former public/global voice ID was replaced with this selected ID in the Gateway's global fallback, tenant-creation fallback, migration, and schema; neither retired ID is retained in the active repository files.

No deployment, PR, or merge to `main` was performed; runtime D1 defaults for existing global/tenant rows may still need migration/update separately. Whisper's repeated hallucinated transcript remains unresolved and was not changed.
