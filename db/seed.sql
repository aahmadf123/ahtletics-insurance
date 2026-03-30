-- ─── Sport Administrators ────────────────────────────────────────────────────
INSERT INTO sport_administrators (id, name, title, email, is_cfo) VALUES
  ('nicole_harris',    'Nicole Harris',    'Deputy AD / COO / Senior Woman Administrator',      'nicole.harris@utoledo.edu',    0),
  ('connor_whelan',    'Connor Whelan',    'Deputy AD / Chief Revenue Officer',                 'connor.whelan@utoledo.edu',    0),
  ('brian_lutz',       'Brian Lutz',       'Senior Associate AD of Compliance and Integrity',   'brian.lutz@utoledo.edu',       0),
  ('tim_warga',        'Tim Warga',        'Associate AD of Operations/Events',                 'tim.warga@utoledo.edu',        0),
  ('melissa_deangelo', 'Melissa DeAngelo', 'Senior Associate AD for Business Strategy / CFO',  'melissa.deangelo@utoledo.edu', 1);

-- ─── Sports Programs ─────────────────────────────────────────────────────────
INSERT INTO sports_programs (id, name, gender, head_coach, sport_admin_id) VALUES
  ('mens_baseball',        'Baseball',                  'Mens',   'Rob Reinstetle',                      'tim_warga'),
  ('mens_basketball',      'Men''s Basketball',          'Mens',   'Tod Kowalczyk',                       'connor_whelan'),
  ('mens_cross_country',   'Men''s Cross Country',       'Mens',   'Linh Nguyen / Andrea Grove-McDonough','brian_lutz'),
  ('mens_football',        'Football',                  'Mens',   'Mike Jacobs',                         'nicole_harris'),
  ('mens_golf',            'Men''s Golf',                'Mens',   'Jeff Roope',                          NULL),
  ('mens_tennis',          'Men''s Tennis',              'Mens',   NULL,                                  NULL),
  ('womens_basketball',    'Women''s Basketball',        'Womens', 'Ginny Boggess',                       'nicole_harris'),
  ('womens_cross_country', 'Women''s Cross Country',     'Womens', 'Linh Nguyen / Andrea Grove-McDonough','brian_lutz'),
  ('womens_golf',          'Women''s Golf',              'Womens', 'Ali Green',                           NULL),
  ('womens_rowing',        'Women''s Rowing',            'Womens', 'Chris Bailey-Greene',                 'nicole_harris'),
  ('womens_soccer',        'Women''s Soccer',            'Womens', 'Mark Batman',                         'brian_lutz'),
  ('womens_softball',      'Softball',                  'Womens', 'Jessica Bracamonte',                  'melissa_deangelo'),
  ('womens_swimming',      'Women''s Swimming & Diving', 'Womens', 'Jacy Dyer',                           'nicole_harris'),
  ('womens_tennis',        'Women''s Tennis',            'Womens', NULL,                                  NULL),
  ('womens_track',         'Women''s Track & Field',     'Womens', 'Linh Nguyen / Andrea Grove-McDonough','brian_lutz'),
  ('womens_volleyball',    'Women''s Volleyball',        'Womens', NULL,                                  'connor_whelan');

-- ─── Default Users (password: "changeme123") ──────────────────────────────────
-- NOTE: You must update these passwords after first login.
-- Passwords are hashed with PBKDF2-SHA256, 100k iterations.
-- The hash below corresponds to "changeme123" — generate new hashes via the /auth/register endpoint.
