-- ─────────────────────────────────────────────────────────────────────────────
-- Improvements migration: multi-staff coaches, sport-admin scoping, denial &
-- resubmission lineage, budget caps, audit-log IP capture, duplicate guard.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Coaches: every coaching staff member per sport (multi-staff model) ───────
-- A sport has exactly one head coach (is_head_coach = 1) plus any number of
-- assistant/volunteer staff. `sports_programs.head_coach` / `head_coach_email`
-- are kept in sync from the row WHERE is_head_coach = 1 for backward compat.
CREATE TABLE IF NOT EXISTS coaches (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT NOT NULL,
  sport_id TEXT NOT NULL REFERENCES sports_programs(id),
  title TEXT,                               -- "Head Coach" | "Assistant Coach" | "Volunteer Coach" | "Other"
  is_head_coach INTEGER NOT NULL DEFAULT 0,
  delegated_approver_email TEXT,            -- out-of-office delegate (1.8)
  delegation_expires_at TEXT,               -- ISO timestamp; delegation ignored once past
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_coaches_sport ON coaches(sport_id);
CREATE INDEX IF NOT EXISTS idx_coaches_email ON coaches(email);

-- ── Sport Administrator ↔ Sport assignments (many-to-many) ───────────────────
-- Replaces the implicit single users.sport_id for sport_admin accounts. Scoping
-- falls back to users.sport_id when an admin has no rows here (backward compat).
CREATE TABLE IF NOT EXISTS sport_admin_assignments (
  id TEXT PRIMARY KEY,
  admin_user_id TEXT NOT NULL REFERENCES users(id),
  sport_id TEXT NOT NULL REFERENCES sports_programs(id),
  UNIQUE(admin_user_id, sport_id)
);
CREATE INDEX IF NOT EXISTS idx_saa_admin ON sport_admin_assignments(admin_user_id);

-- ── Sports programs: per-sport budget cap (CFO budget dashboard, 2.3) ────────
ALTER TABLE sports_programs ADD COLUMN budget_cap REAL;

-- ── Insurance requests: denial reason + resubmission lineage ─────────────────
ALTER TABLE insurance_requests ADD COLUMN denial_reason TEXT;       -- 1.4
ALTER TABLE insurance_requests ADD COLUMN parent_request_id TEXT;   -- 1.5

-- ── Audit log: capture acting IP for compliance viewer (3.3) ─────────────────
ALTER TABLE audit_log ADD COLUMN ip_address TEXT;

-- ── Duplicate guard: at most one active request per student per term (2.1) ───
CREATE UNIQUE INDEX IF NOT EXISTS uq_request_student_term
  ON insurance_requests(rocket_number, term)
  WHERE status NOT IN ('VOIDED', 'DENIED', 'EXPIRED');

-- ── Backfill: seed the coaches table from the existing per-sport head coach ──
-- so head-coach routing and the new Sports & Coaches UI have data on day one.
INSERT INTO coaches (id, display_name, email, sport_id, title, is_head_coach)
SELECT
  'coach_' || sp.id,
  sp.head_coach,
  COALESCE(sp.head_coach_email, ''),
  sp.id,
  'Head Coach',
  1
FROM sports_programs sp
WHERE sp.head_coach IS NOT NULL
  AND TRIM(sp.head_coach) <> ''
  AND NOT EXISTS (SELECT 1 FROM coaches c WHERE c.sport_id = sp.id AND c.is_head_coach = 1);
