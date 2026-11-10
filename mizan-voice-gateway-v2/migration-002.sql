-- ============================================================================
-- Mizan Voice Gateway — Migration 002: Update default ElevenLabs Voice ID
-- Run AFTER migration-001.sql against the intended D1 database.
-- This updates only rows still using the previous default; custom voice IDs remain untouched.
-- ============================================================================

UPDATE global_voice_config
SET voice_id = '6CdZI3ijDBOuX5Giq3NQ',
    updated_at = unixepoch()
WHERE id = 1
  AND voice_id = 'P2DK6Lg0vxyKGYj3QOik';

UPDATE tenant_voice_config
SET voice_id = '6CdZI3ijDBOuX5Giq3NQ',
    updated_at = unixepoch()
WHERE voice_id = 'P2DK6Lg0vxyKGYj3QOik';
