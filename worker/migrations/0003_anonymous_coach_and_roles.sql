-- Add status column to users for pending account approval
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';

-- Make coach_email nullable for anonymous coaches
-- SQLite doesn't support ALTER COLUMN, so we recreate via a workaround:
-- Since the column already exists as NOT NULL, we create a new table, copy data, then swap.
CREATE TABLE insurance_requests_new (
  id TEXT PRIMARY KEY,
  student_name TEXT NOT NULL,
  rocket_number TEXT NOT NULL,
  sport TEXT NOT NULL,
  term TEXT NOT NULL,
  premium_cost REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_SPORT_ADMIN',
  workflow_instance_id TEXT,
  coach_email TEXT, -- now nullable
  coach_name TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO insurance_requests_new SELECT * FROM insurance_requests;
DROP TABLE insurance_requests;
ALTER TABLE insurance_requests_new RENAME TO insurance_requests;

-- Update role CHECK constraint to include super_admin
-- SQLite doesn't support altering CHECK constraints but the column has no CHECK in the current schema migration
-- The role validation is handled at the application level
