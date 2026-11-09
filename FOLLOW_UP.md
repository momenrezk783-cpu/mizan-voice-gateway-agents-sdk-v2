# FOLLOW_UP

On branch `feat/hq-elevenlabs-conversation-engine`, the HQ `_portal_assets.elevenlabs_config` voice was changed from `JTMaHm6sHVI3NZgPaWDz` to `P2DK6Lg0vxyKGYj3QOik` and read back successfully. The unwanted public/global voice ID `SAz9YHcvj6GT2YYXdXww` was then replaced with `P2DK6Lg0vxyKGYj3QOik` in the Gateway's global fallback, tenant-creation fallback, migration, and schema so it no longer remains in these repository files.

No deployment, PR, or merge to `main` was performed; runtime D1 defaults for existing global/tenant rows may still need migration/update separately. Whisper's repeated hallucinated transcript remains unresolved and was not changed.
