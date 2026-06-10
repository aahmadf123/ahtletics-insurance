-- Per-sport head coach email, maintained by the Super Admin so a coach's contact
-- info auto-fills when they pick their sport on a new request.
ALTER TABLE sports_programs ADD COLUMN head_coach_email TEXT;
