-- ─────────────────────────────────────────────────────────────────────────────
-- Hardening migration: session revocation, login lockout, hashed reset tokens,
-- persisted email delivery log, data-driven single-approval rule.
--
-- Two tables (password_reset_tokens, app_settings) were previously created at
-- runtime with CREATE TABLE IF NOT EXISTS on the request path. They are declared
-- here so the schema is authoritative and the DDL can leave the hot path.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Users: session revocation + login lockout ────────────────────────────────
-- token_version is embedded in every JWT as `tv`. Bumping it on password change,
-- password reset, or account rejection invalidates every cookie already issued
-- for that user, which a stateless JWT otherwise cannot do.
ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

-- Per-account failed-login backoff. The existing IP limiter is per-isolate and
-- in-memory, so it resets whenever the isolate recycles; this survives that.
ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

-- ── Password reset tokens: store a hash, not the token ───────────────────────
-- The previous runtime-created table stored the raw token as the primary key, so
-- a database read disclosed working reset links. Tokens are short-lived and
-- single-use, so dropping the table (invalidating any link in flight) is safe.
DROP TABLE IF EXISTS password_reset_tokens;
CREATE TABLE password_reset_tokens (
  token_hash TEXT PRIMARY KEY,          -- SHA-256 of the token handed to the user
  user_id    TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,          -- unix seconds
  used       INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reset_tokens_user ON password_reset_tokens(user_id);

-- ── App settings (previously created at runtime) ─────────────────────────────
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key   TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Email delivery log ───────────────────────────────────────────────────────
-- Every send is recorded so "did the head coach actually get it" is answerable
-- from inside the app. Delivery to utoledo.edu is unreliable and the provider
-- reporting a 200 only means the receiving MX accepted the message.
CREATE TABLE IF NOT EXISTS email_log (
  id          TEXT PRIMARY KEY,
  request_id  TEXT,                     -- nullable: password resets have no request
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  template    TEXT NOT NULL,            -- notifyPendingHeadCoach, passwordReset, ...
  provider_id TEXT,                     -- Resend message id on success
  status      TEXT NOT NULL,            -- sent | failed | skipped
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_log_request ON email_log(request_id);
CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_email);
CREATE INDEX IF NOT EXISTS idx_email_log_created ON email_log(created_at);

-- ── Single-approval rule as data, not a hardcoded sport id ───────────────────
-- Softball's sport administrator IS the CFO, so one CFO signature finalizes it.
-- This was matched against the literal string 'womens_softball' in code, which
-- broke silently if the sport was renamed or recreated from the admin UI.
ALTER TABLE sports_programs ADD COLUMN single_approval INTEGER NOT NULL DEFAULT 0;

UPDATE sports_programs
SET single_approval = 1
WHERE id = 'womens_softball'
   OR sport_admin_id IN (SELECT id FROM sport_administrators WHERE is_cfo = 1);

-- ── Reminder throttling counter ──────────────────────────────────────────────
-- Reminders previously repeated every 24 hours forever with no escalation.
ALTER TABLE insurance_requests ADD COLUMN reminder_count INTEGER NOT NULL DEFAULT 0;

-- ── Resubmission lineage lookup ──────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_requests_parent ON insurance_requests(parent_request_id);
CREATE INDEX IF NOT EXISTS idx_requests_status_created ON insurance_requests(status, created_at);
