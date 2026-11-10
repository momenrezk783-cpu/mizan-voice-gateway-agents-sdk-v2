-- Run on staging before deploying Sprint 2 API changes. Do not run on production without release approval.

-- Login brute-force throttling (hashed keys; no raw email or IP stored)
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  attempt_key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_reset ON auth_login_attempts(reset_at);
