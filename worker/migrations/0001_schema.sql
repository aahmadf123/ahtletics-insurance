-- Users table (email+password auth, replaces SAML)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('coach', 'sport_admin', 'cfo')),
  sport_id TEXT REFERENCES sports_programs(id),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Sport administrators lookup
CREATE TABLE IF NOT EXISTS sport_administrators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  title TEXT NOT NULL,
  email TEXT NOT NULL,
  is_cfo INTEGER NOT NULL DEFAULT 0
);

-- Sports programs
CREATE TABLE IF NOT EXISTS sports_programs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  gender TEXT NOT NULL,
  head_coach TEXT,
  sport_admin_id TEXT REFERENCES sport_administrators(id)
);

-- Insurance requests
CREATE TABLE IF NOT EXISTS insurance_requests (
  id TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  rocket_number TEXT NOT NULL,
  sport TEXT NOT NULL,
  term TEXT NOT NULL,
  premium_cost REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_SPORT_ADMIN',
  workflow_instance_id TEXT,
  coach_email TEXT NOT NULL,
  coach_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Signatures audit trail
CREATE TABLE IF NOT EXISTS signatures (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES insurance_requests(id),
  signatory_role TEXT NOT NULL,
  signatory_email TEXT NOT NULL,
  signatory_name TEXT NOT NULL,
  ip_address TEXT NOT NULL,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  request_id TEXT REFERENCES insurance_requests(id),
  action TEXT NOT NULL,
  performed_by TEXT NOT NULL,
  details TEXT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP
);
