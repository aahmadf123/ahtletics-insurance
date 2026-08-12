-- ─────────────────────────────────────────────────────────────────────────────
-- Sport programs.
--
-- People are deliberately absent from this file. Administrators, coaches, and the
-- CFO are configured at runtime by a Super Admin (Users, then Sports & Coaches),
-- because a person seeded by a migration cannot be corrected without another
-- migration and a redeploy — and staff turnover is routine.
--
-- The previous version of this file inserted five real staff members (name, title,
-- email) and twelve real head-coach names into every environment, including local
-- development and every preview build. Those rows had no UPDATE path anywhere in
-- the codebase and used slug ids, so the delete path — keyed on users.id — never
-- matched them. A departed administrator kept receiving student-athlete
-- notifications with no way to stop it from inside the product.
--
-- Sport ids and names stay: they are institutional rather than personal, they are
-- referenced throughout the test suite, and `id` is a stable foreign key for
-- insurance_requests.sport.
-- ─────────────────────────────────────────────────────────────────────────────
INSERT OR IGNORE INTO sports_programs (id, name, gender, head_coach, sport_admin_id) VALUES
  ('mens_baseball',        'Baseball',                  'Mens',   NULL, NULL),
  ('mens_basketball',      'Men''s Basketball',          'Mens',   NULL, NULL),
  ('mens_cross_country',   'Men''s Cross Country',       'Mens',   NULL, NULL),
  ('mens_football',        'Football',                  'Mens',   NULL, NULL),
  ('mens_golf',            'Men''s Golf',                'Mens',   NULL, NULL),
  ('mens_tennis',          'Men''s Tennis',              'Mens',   NULL, NULL),
  ('womens_basketball',    'Women''s Basketball',        'Womens', NULL, NULL),
  ('womens_cross_country', 'Women''s Cross Country',     'Womens', NULL, NULL),
  ('womens_golf',          'Women''s Golf',              'Womens', NULL, NULL),
  ('womens_rowing',        'Women''s Rowing',            'Womens', NULL, NULL),
  ('womens_soccer',        'Women''s Soccer',            'Womens', NULL, NULL),
  ('womens_softball',      'Softball',                  'Womens', NULL, NULL),
  ('womens_swimming',      'Women''s Swimming & Diving', 'Womens', NULL, NULL),
  ('womens_tennis',        'Women''s Tennis',            'Womens', NULL, NULL),
  ('womens_track',         'Women''s Track & Field',     'Womens', NULL, NULL),
  ('womens_volleyball',    'Women''s Volleyball',        'Womens', NULL, NULL);
