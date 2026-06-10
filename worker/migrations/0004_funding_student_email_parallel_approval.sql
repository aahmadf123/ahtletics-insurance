-- Funding source (Operating Budget vs Foundation Account) per request
ALTER TABLE insurance_requests ADD COLUMN funding_source TEXT NOT NULL DEFAULT 'operating_budget';

-- Optional student-athlete email, captured per request for confirmation notifications
ALTER TABLE insurance_requests ADD COLUMN student_email TEXT;

-- Parallel approval model: collapse the sequential PENDING_SPORT_ADMIN -> PENDING_CFO
-- chain into a single PENDING_APPROVAL state. Which approvals are still outstanding is
-- derived from the signatures table, so any already-recorded signatures remain valid.
UPDATE insurance_requests
SET status = 'PENDING_APPROVAL'
WHERE status IN ('PENDING_SPORT_ADMIN', 'PENDING_CFO');
