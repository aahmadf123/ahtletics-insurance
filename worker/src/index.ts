import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  hashPassword, verifyPassword, signJWT, getUser, setAuthCookie, clearAuthCookie,
} from './lib/auth';
import {
  notifyPendingSportAdmin, notifyPendingCFO, notifyExecuted, notifyVoided, notifyReminder,
} from './lib/email';
import {
  validateRocketNumber, isBeforeDeadline, getPremiumForTerm, newUUID,
} from './lib/validation';

// ── Env bindings ──────────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  CFO_EMAIL: string;
  FROM_EMAIL: string;
  APP_BASE_URL: string;
  RESEND_API_KEY?: string;
  DEV_MODE?: string;
  ASSETS: Fetcher;
}

const app = new Hono<{ Bindings: Env }>();

// ── CORS ──────────────────────────────────────────────────────────────────────

app.use('*', cors({
  origin: origin =>
    !origin ||
    origin.startsWith('http://localhost') ||
    origin === 'https://ahtletics-insurance.firas-azfar.workers.dev'
      ? origin : null,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Auth helpers ──────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

const isSecure = (req: Request) =>
  new URL(req.url).protocol === 'https:';

// ── Auth routes ───────────────────────────────────────────────────────────────

// GET /auth/status — check if initial setup is needed
app.get('/auth/status', async c => {
  const existing = await c.env.DB.prepare('SELECT id FROM users LIMIT 1').first();
  return json({ setupRequired: !existing });
});

// POST /auth/setup — first-time admin setup (only if zero users exist)
app.post('/auth/setup', async c => {
  const { email, password, name, role, sportId } = await c.req.json<{
    email: string; password: string; name: string; role: string; sportId?: string;
  }>();
  if (!email || !password || !name || !role) return err('Missing fields');
  if (!['coach', 'sport_admin', 'cfo'].includes(role)) return err('Invalid role');
  if (password.length < 8) return err('Password must be at least 8 characters');
  if (role === 'coach' && !sportId) return err('Coaches must select a sport');
  const existing = await c.env.DB.prepare('SELECT id FROM users LIMIT 1').first();
  if (existing) return err('Setup already complete', 403);
  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, sport_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, sportId ?? null).run();
  const token = await signJWT(
    { sub: id, email: email.toLowerCase(), name, role: role as 'cfo', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
    c.env.JWT_SECRET
  );
  return new Response(JSON.stringify({ id, email: email.toLowerCase(), name, role }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setAuthCookie(token, isSecure(c.req.raw)),
    },
  });
});

// POST /auth/login
app.post('/auth/login', async c => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return err('Email and password required');
  const user = await c.env.DB.prepare(
    'SELECT id, email, password_hash, name, role, sport_id, must_change_password FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first<{ id: string; email: string; password_hash: string; name: string; role: string; sport_id: string | null; must_change_password: number }>();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return err('Invalid email or password', 401);
  }
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role as 'coach' | 'sport_admin' | 'cfo',
    sportId: user.sport_id ?? undefined,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };
  const token = await signJWT(payload, c.env.JWT_SECRET);
  return new Response(JSON.stringify({
    id: user.id, email: user.email, name: user.name, role: user.role,
    sportId: user.sport_id, mustChangePassword: user.must_change_password,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setAuthCookie(token, isSecure(c.req.raw)),
    },
  });
});

// POST /auth/logout
app.post('/auth/logout', c => {
  return new Response('{}', {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearAuthCookie(),
    },
  });
});

// PUT /auth/password — change own password
app.put('/auth/password', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  const { currentPassword, newPassword } = await c.req.json<{ currentPassword: string; newPassword: string }>();
  if (!currentPassword || !newPassword) return err('Missing fields');
  if (newPassword.length < 8) return err('Password must be at least 8 characters');
  const dbUser = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ?'
  ).bind(user.sub).first<{ password_hash: string }>();
  if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
    return err('Current password is incorrect', 401);
  }
  const newHash = await hashPassword(newPassword);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
  ).bind(newHash, user.sub).run();
  return json({ ok: true });
});

// GET /auth/me
app.get('/auth/me', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  return json({ id: user.sub, email: user.email, name: user.name, role: user.role, sportId: user.sportId });
});

// ── Sports ────────────────────────────────────────────────────────────────────

app.get('/api/sports', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT sp.id, sp.name, sp.gender, sp.head_coach as headCoach,
           sp.sport_admin_id as sportAdminId,
           sa.name as sportAdminName, sa.email as sportAdminEmail
    FROM sports_programs sp
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    ORDER BY sp.name
  `).all();
  return json(results);
});

// ── Requests ──────────────────────────────────────────────────────────────────

// GET /api/requests — list (filtered by role)
app.get('/api/requests', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);

  const { sport, term, status, coach } = c.req.query();

  let query = `
    SELECT ir.*, sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (user.role === 'coach') {
    query += ' AND ir.coach_email = ?'; params.push(user.email);
  } else if (user.role === 'sport_admin') {
    // sport admin sees requests for their sports
    const adminRow = await c.env.DB.prepare(
      'SELECT id FROM sport_administrators WHERE email = ?'
    ).bind(user.email).first<{ id: string }>();
    if (adminRow) {
      query += ' AND sp.sport_admin_id = ?'; params.push(adminRow.id);
    }
  }
  // CFO sees all

  if (sport) { query += ' AND ir.sport = ?'; params.push(sport); }
  if (term) { query += ' AND ir.term LIKE ?'; params.push(`%${term}%`); }
  if (status) { query += ' AND ir.status = ?'; params.push(status); }
  if (coach) { query += ' AND (ir.coach_name LIKE ? OR ir.coach_email LIKE ?)'; params.push(`%${coach}%`, `%${coach}%`); }

  query += ' ORDER BY ir.created_at DESC';

  const stmt = params.reduce((s, p) => s.bind(p), c.env.DB.prepare(query));
  const { results } = await stmt.all();
  return json(results);
});

// POST /api/requests — create (bulk)
app.post('/api/requests', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach') return err('Only coaches can submit requests', 403);

  const body = await c.req.json<{
    athletes: { studentName: string; rocketNumber: string; sport: string }[];
    term: string;
  }>();

  if (!body.athletes?.length || !body.term) return err('Missing athletes or term');

  if (!isBeforeDeadline(body.term)) {
    return err('Submission deadline has passed for this term', 422);
  }

  const premiumCost = getPremiumForTerm(body.term);
  if (!premiumCost) return err('Unknown term', 400);

  const created = [];

  for (const athlete of body.athletes) {
    if (!athlete.studentName?.trim()) return err('Student name is required');
    if (!validateRocketNumber(athlete.rocketNumber)) {
      return err(`Invalid Rocket Number: ${athlete.rocketNumber}`);
    }
    if (!athlete.sport) return err('Sport is required');

    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM insurance_requests WHERE rocket_number = ? AND term = ? AND sport = ?'
    ).bind(athlete.rocketNumber, body.term, athlete.sport).first();
    if (duplicate) {
      return err(`A request already exists for ${athlete.rocketNumber} in ${body.term} for this sport`);
    }

    const id = newUUID();
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
    const isSoftball = athlete.sport === 'womens_softball';
    const initialStatus = isSoftball ? 'PENDING_CFO' : 'PENDING_SPORT_ADMIN';

    await c.env.DB.prepare(`
      INSERT INTO insurance_requests
        (id, student_name, rocket_number, sport, term, premium_cost, status, coach_email, coach_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, athlete.studentName.trim(), athlete.rocketNumber, athlete.sport,
      body.term, premiumCost, initialStatus, user.email, user.name
    ).run();

    // Coach signature
    await c.env.DB.prepare(`
      INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
      VALUES (?, ?, 'COACH', ?, ?, ?)
    `).bind(newUUID(), id, user.email, user.name, ip).run();

    // Audit log
    await c.env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'SUBMITTED', ?, ?)
    `).bind(newUUID(), id, user.email, JSON.stringify({ status: initialStatus })).run();

    // Get sport admin for notification
    const sportRow = await c.env.DB.prepare(`
      SELECT sp.name as sportName, sa.email as adminEmail, sa.name as adminName
      FROM sports_programs sp
      LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
      WHERE sp.id = ?
    `).bind(athlete.sport).first<{ sportName: string; adminEmail: string | null; adminName: string | null }>();

    const emailData = {
      studentName: athlete.studentName.trim(),
      rocketNumber: athlete.rocketNumber,
      sport: athlete.sport,
      sportName: sportRow?.sportName ?? athlete.sport,
      term: body.term,
      premiumCost,
      coachName: user.name,
      coachEmail: user.email,
      requestId: id,
      status: initialStatus,
    };

    if (isSoftball) {
      await notifyPendingCFO(c.env, emailData);
    } else if (sportRow?.adminEmail) {
      await notifyPendingSportAdmin(c.env, emailData, sportRow.adminEmail);
    }

    created.push({ id, studentName: athlete.studentName.trim(), rocketNumber: athlete.rocketNumber, sport: athlete.sport, term: body.term, premiumCost, status: initialStatus, coachEmail: user.email, coachName: user.name });
  }

  return json(created, 201);
});

// GET /api/requests/:id
app.get('/api/requests/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  const { id } = c.req.param();

  const req = await c.env.DB.prepare(`
    SELECT ir.*, sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!req) return err('Not found', 404);

  // RBAC check
  if (user.role === 'coach' && req.coach_email !== user.email) return err('Forbidden', 403);
  if (user.role === 'sport_admin') {
    const adminRow = await c.env.DB.prepare(
      'SELECT id FROM sport_administrators WHERE email = ?'
    ).bind(user.email).first<{ id: string }>();
    const sportRow = await c.env.DB.prepare(
      'SELECT sport_admin_id FROM sports_programs WHERE id = ?'
    ).bind(req.sport).first<{ sport_admin_id: string | null }>();
    if (!adminRow || !sportRow || sportRow.sport_admin_id !== adminRow.id) {
      return err('Forbidden', 403);
    }
  }

  const { results: sigs } = await c.env.DB.prepare(`
    SELECT id, request_id as requestId, signatory_role as signatoryRole,
           signatory_email as signatoryEmail, signatory_name as signatoryName, timestamp
    FROM signatures WHERE request_id = ? ORDER BY timestamp ASC
  `).bind(id).all();

  return json({ ...req, signatures: sigs });
});

// POST /api/requests/:id/sign
app.post('/api/requests/:id/sign', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role === 'coach') return err('Coaches cannot sign at this stage', 403);

  const { id } = c.req.param();
  const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';

  const req = await c.env.DB.prepare(`
    SELECT ir.*, sp.name as sportName, sa.email as sportAdminEmail, sa.name as sportAdminName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown> & { status: string; sport: string; sportName: string; sportAdminEmail: string | null; sportAdminName: string | null; coach_email: string; coach_name: string; rocket_number: string; student_name: string; term: string; premium_cost: number }>();

  if (!req) return err('Not found', 404);

  let sigRole: 'SPORT_ADMIN' | 'CFO';
  let newStatus: string;

  if (user.role === 'sport_admin') {
    if (req.status !== 'PENDING_SPORT_ADMIN') return err('Not pending sport admin signature', 409);
    // Verify this admin is assigned to the request's sport
    const adminRow = await c.env.DB.prepare(
      'SELECT id FROM sport_administrators WHERE email = ?'
    ).bind(user.email).first<{ id: string }>();
    const sportRow = await c.env.DB.prepare(
      'SELECT sport_admin_id FROM sports_programs WHERE id = ?'
    ).bind(req.sport).first<{ sport_admin_id: string | null }>();
    if (!adminRow || !sportRow || sportRow.sport_admin_id !== adminRow.id) {
      return err('Not authorized to sign requests for this sport', 403);
    }
    sigRole = 'SPORT_ADMIN';
    newStatus = 'PENDING_CFO';
  } else if (user.role === 'cfo') {
    if (req.status !== 'PENDING_CFO' && !(req.status === 'PENDING_SPORT_ADMIN' && req.sport === 'womens_softball')) {
      return err('Not pending CFO signature', 409);
    }
    sigRole = 'CFO';
    newStatus = 'EXECUTED';
  } else {
    return err('Forbidden', 403);
  }

  await c.env.DB.prepare(`
    INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(newUUID(), id, sigRole, user.email, user.name, ip).run();

  await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
    .bind(newStatus, id).run();

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, request_id, action, performed_by, details)
    VALUES (?, ?, 'SIGNED', ?, ?)
  `).bind(newUUID(), id, user.email, JSON.stringify({ role: sigRole, newStatus })).run();

  const emailData = {
    studentName: req.student_name as string,
    rocketNumber: req.rocket_number as string,
    sport: req.sport as string,
    sportName: req.sportName as string,
    term: req.term as string,
    premiumCost: req.premium_cost as number,
    coachName: req.coach_name as string,
    coachEmail: req.coach_email as string,
    requestId: id,
    status: newStatus,
    sportAdminName: req.sportAdminName as string ?? undefined,
  };

  if (newStatus === 'PENDING_CFO') {
    await notifyPendingCFO(c.env, emailData);
  } else if (newStatus === 'EXECUTED') {
    await notifyExecuted(c.env, emailData, req.sportAdminEmail as string ?? undefined);
  }

  return json({ id, status: newStatus });
});

// POST /api/requests/:id/void — CFO only
app.post('/api/requests/:id/void', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo') return err('Only CFO can void requests', 403);

  const { id } = c.req.param();
  const { reason } = await c.req.json<{ reason: string }>();
  if (!reason?.trim()) return err('Void reason is required');

  const req = await c.env.DB.prepare(`
    SELECT ir.*, sp.name as sportName, sa.email as sportAdminEmail, sa.name as sportAdminName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!req) return err('Not found', 404);
  if (!['PENDING_SPORT_ADMIN', 'PENDING_CFO'].includes(req.status as string)) {
    return err('Only active requests can be voided', 409);
  }

  await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
    .bind('VOIDED', id).run();

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, request_id, action, performed_by, details)
    VALUES (?, ?, 'VOIDED', ?, ?)
  `).bind(newUUID(), id, user.email, JSON.stringify({ reason })).run();

  const emailData = {
    studentName: req.student_name as string,
    rocketNumber: req.rocket_number as string,
    sport: req.sport as string,
    sportName: req.sportName as string ?? req.sport,
    term: req.term as string,
    premiumCost: req.premium_cost as number,
    coachName: req.coach_name as string,
    coachEmail: req.coach_email as string,
    requestId: id,
    status: 'VOIDED',
    voidReason: reason.trim(),
  };

  await notifyVoided(c.env, emailData, req.sportAdminEmail as string ?? undefined);

  return json({ id, status: 'VOIDED' });
});

// ── Reports (CFO only) ────────────────────────────────────────────────────────

app.get('/api/reports', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo') return err('Forbidden', 403);

  const { sport, term, status, coach } = c.req.query();
  let query = `
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, sp.name as sportName, ir.term, ir.coach_name as coachName,
           ir.coach_email as coachEmail, ir.premium_cost as premiumCost,
           ir.status, ir.created_at as createdAt
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (sport) { query += ' AND ir.sport = ?'; params.push(sport); }
  if (term) { query += ' AND ir.term LIKE ?'; params.push(`%${term}%`); }
  if (status) { query += ' AND ir.status = ?'; params.push(status); }
  if (coach) { query += ' AND (ir.coach_name LIKE ? OR ir.coach_email LIKE ?)'; params.push(`%${coach}%`, `%${coach}%`); }

  query += ' ORDER BY ir.created_at DESC';

  const stmt = params.reduce((s, p) => s.bind(p), c.env.DB.prepare(query));
  const { results } = await stmt.all();
  return json(results);
});

// GET /api/reports/csv — CFO only, CSV download
app.get('/api/reports/csv', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo') return err('Forbidden', 403);

  const { sport, term, status, coach } = c.req.query();
  let query = `
    SELECT ir.student_name, ir.rocket_number, ir.sport,
           sp.name as sport_name, ir.term, ir.coach_name, ir.coach_email,
           ir.premium_cost, ir.status, ir.created_at
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (sport) { query += ' AND ir.sport = ?'; params.push(sport); }
  if (term) { query += ' AND ir.term LIKE ?'; params.push(`%${term}%`); }
  if (status) { query += ' AND ir.status = ?'; params.push(status); }
  if (coach) { query += ' AND (ir.coach_name LIKE ? OR ir.coach_email LIKE ?)'; params.push(`%${coach}%`, `%${coach}%`); }

  query += ' ORDER BY ir.created_at DESC';

  const stmt = params.reduce((s, p) => s.bind(p), c.env.DB.prepare(query));
  const { results } = await stmt.all<Record<string, unknown>>();

  const headers = ['Student Name', 'Rocket Number', 'Sport', 'Term', 'Coach', 'Coach Email', 'Premium ($)', 'Status', 'Submitted'];
  const csvRows = [
    headers.join(','),
    ...results.map(r => [
      csvEscape(String(r.student_name ?? '')),
      csvEscape(String(r.rocket_number ?? '')),
      csvEscape(String(r.sport_name ?? r.sport ?? '')),
      csvEscape(String(r.term ?? '')),
      csvEscape(String(r.coach_name ?? '')),
      csvEscape(String(r.coach_email ?? '')),
      String(r.premium_cost ?? '0'),
      csvEscape(String(r.status ?? '')),
      csvEscape(String(r.created_at ?? '')),
    ].join(','))
  ];

  return new Response(csvRows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="athletics-insurance-report.csv"',
    },
  });
});

function csvEscape(value: string): string {
  // Prefix formula-triggering characters to prevent Excel injection
  const sanitized = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (sanitized.includes(',') || sanitized.includes('"') || sanitized.includes('\n')) {
    return `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

// ── Admin — users ─────────────────────────────────────────────────────────────

app.get('/api/admin/users', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'cfo') return err('Forbidden', 403);
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, role, sport_id as sportId, must_change_password as mustChangePassword, created_at as createdAt FROM users ORDER BY created_at DESC'
  ).all();
  return json(results);
});

app.post('/api/admin/users', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'cfo') return err('Forbidden', 403);

  const { email, password, name, role, sportId } = await c.req.json<{
    email: string; password: string; name: string; role: string; sportId?: string;
  }>();

  if (!email || !password || !name || !role) return err('Missing required fields');
  if (!['coach', 'sport_admin', 'cfo'].includes(role)) return err('Invalid role');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase()).first();
  if (exists) return err('Email already in use', 409);

  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, sport_id, must_change_password) VALUES (?, ?, ?, ?, ?, ?, 1)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, sportId ?? null).run();

  return json({ id, email: email.toLowerCase(), name, role, sportId: sportId ?? null, mustChangePassword: 1, createdAt: new Date().toISOString() }, 201);
});

app.delete('/api/admin/users/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'cfo') return err('Forbidden', 403);
  const { id } = c.req.param();
  if (id === user.sub) return err('Cannot delete your own account', 400);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

// PUT /api/admin/sports/:id — update sport admin assignment
app.put('/api/admin/sports/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'cfo') return err('Forbidden', 403);
  const { id } = c.req.param();
  const { adminId } = await c.req.json<{ adminId: string | null }>();
  await c.env.DB.prepare('UPDATE sports_programs SET sport_admin_id = ? WHERE id = ?')
    .bind(adminId ?? null, id).run();
  return json({ ok: true });
});

// ── Static assets / SPA fallback ─────────────────────────────────────────────

app.all('*', async c => {
  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status === 404) {
    // SPA fallback: serve index.html for client-side routing
    const origin = new URL(c.req.url).origin;
    return c.env.ASSETS.fetch(new Request(`${origin}/index.html`));
  }
  return assetResponse;
});

// ── Scheduled: 48h reminder emails ───────────────────────────────────────────

async function runReminders(env: Env): Promise<void> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

  const { results } = await env.DB.prepare(`
    SELECT ir.id, ir.student_name, ir.rocket_number, ir.sport, sp.name as sportName,
           ir.term, ir.premium_cost, ir.status, ir.coach_email, ir.coach_name,
           sa.email as adminEmail, sa.name as adminName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.status IN ('PENDING_SPORT_ADMIN', 'PENDING_CFO')
      AND ir.created_at < ?
  `).bind(cutoff).all<{
    id: string; student_name: string; rocket_number: string; sport: string; sportName: string;
    term: string; premium_cost: number; status: string; coach_email: string; coach_name: string;
    adminEmail: string | null; adminName: string | null;
  }>();

  for (const r of results) {
    // Check if reminder already sent in last 24h
    const recentReminder = await env.DB.prepare(`
      SELECT id FROM audit_log
      WHERE request_id = ? AND action = 'REMINDER_SENT'
        AND timestamp > datetime('now', '-24 hours')
      LIMIT 1
    `).bind(r.id).first();
    if (recentReminder) continue;

    const emailData = {
      studentName: r.student_name,
      rocketNumber: r.rocket_number,
      sport: r.sport,
      sportName: r.sportName,
      term: r.term,
      premiumCost: r.premium_cost,
      coachName: r.coach_name,
      coachEmail: r.coach_email,
      requestId: r.id,
      status: r.status,
    };

    if (r.status === 'PENDING_SPORT_ADMIN' && r.adminEmail) {
      await notifyReminder(env, emailData, r.adminEmail, 'Sport Administrator');
    } else if (r.status === 'PENDING_CFO') {
      await notifyReminder(env, emailData, env.CFO_EMAIL, 'CFO');
    }

    await env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'REMINDER_SENT', 'system', ?)
    `).bind(newUUID(), r.id, JSON.stringify({ status: r.status })).run();
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    await runReminders(env);
  },
};

