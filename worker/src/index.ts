import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  hashPassword, verifyPassword, signJWT, getUser, setAuthCookie, clearAuthCookie,
} from './lib/auth';
import {
  notifyPendingSportAdmin, notifyPendingCFO, notifyExecuted, notifyVoided, notifyReminder,
  notifyCoachSubmitted, notifyStudentSubmitted, type EmailData,
} from './lib/email';
import {
  validateRocketNumber, isBeforeDeadline, getPremiumForTerm, getSubmissionDeadline, newUUID,
} from './lib/validation';
import { buildInsuranceFormPdf, type PdfFormData } from './lib/pdf';

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

const TOKEN_EXPIRATION_SECONDS = 60 * 60; // 1 hour

const CREATE_RESET_TOKENS_TABLE = `
  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  )
`;

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

// ── Approval helpers (parallel approval model) ───────────────────────────────

const FUNDING_SOURCES = ['operating_budget', 'foundation_account'] as const;

// Softball's sport administrator IS the CFO (Melissa DeAngelo), so a single CFO
// approval is sufficient; every other sport needs both Sport Admin and CFO.
const isSoftball = (sport: string) => sport === 'womens_softball';

/** True once all required approvals (Sport Admin + CFO, or just CFO for softball) exist. */
async function hasAllApprovals(env: Env, id: string, sport: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT signatory_role FROM signatures WHERE request_id = ? AND signatory_role IN ('SPORT_ADMIN', 'CFO')`
  ).bind(id).all<{ signatory_role: string }>();
  const roles = new Set(results.map(r => r.signatory_role));
  if (isSoftball(sport)) return roles.has('CFO');
  return roles.has('SPORT_ADMIN') && roles.has('CFO');
}

/** Build the notification payload (incl. sport admin email) for a request. */
async function loadRequestEmailData(
  env: Env,
  id: string,
): Promise<(EmailData & { sportAdminEmail?: string }) | null> {
  const r = await env.DB.prepare(`
    SELECT ir.student_name, ir.rocket_number, ir.student_email, ir.sport, sp.name as sportName,
           ir.term, ir.premium_cost, ir.funding_source, ir.coach_name, ir.coach_email,
           sa.email as sportAdminEmail, sa.name as sportAdminName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!r) return null;
  return {
    studentName: r.student_name as string,
    rocketNumber: r.rocket_number as string,
    studentEmail: (r.student_email as string) || undefined,
    sport: r.sport as string,
    sportName: (r.sportName as string) ?? (r.sport as string),
    term: r.term as string,
    premiumCost: r.premium_cost as number,
    fundingSource: (r.funding_source as string) || 'operating_budget',
    coachName: r.coach_name as string,
    coachEmail: (r.coach_email as string) || '',
    requestId: id,
    status: '',
    sportAdminName: (r.sportAdminName as string) ?? undefined,
    sportAdminEmail: (r.sportAdminEmail as string) ?? undefined,
  };
}

/** On coach submission: confirm to coach + student, and ask both approvers to act. */
async function notifySubmission(env: Env, d: EmailData & { sportAdminEmail?: string }): Promise<void> {
  await notifyCoachSubmitted(env, d);
  await notifyStudentSubmitted(env, d);
  if (!isSoftball(d.sport) && d.sportAdminEmail) {
    await notifyPendingSportAdmin(env, d, d.sportAdminEmail);
  }
  await notifyPendingCFO(env, d);
}

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
  if (!['coach', 'sport_admin', 'cfo', 'super_admin'].includes(role)) return err('Invalid role');
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
    { sub: id, email: email.toLowerCase(), name, role: role as 'coach' | 'sport_admin' | 'cfo' | 'super_admin', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7 },
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
    'SELECT id, email, password_hash, name, role, sport_id, must_change_password, status FROM users WHERE email = ?'
  ).bind(email.toLowerCase()).first<{ id: string; email: string; password_hash: string; name: string; role: string; sport_id: string | null; must_change_password: number; status: string | null }>();
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return err('Invalid email or password', 401);
  }
  // Check account status
  const userStatus = user.status ?? 'active';
  if (userStatus === 'pending') {
    return err('Your account is pending approval. A Super Admin will review it shortly.', 403);
  }
  if (userStatus === 'rejected') {
    return err('Your account request has been rejected.', 403);
  }
  const payload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role as 'coach' | 'sport_admin' | 'cfo' | 'super_admin',
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

// POST /auth/forgot-password — send a password reset email
app.post('/auth/forgot-password', async c => {
  const { email } = await c.req.json<{ email: string }>();
  if (!email?.trim()) return err('Email is required');

  const dbUser = await c.env.DB.prepare(
    'SELECT id, name FROM users WHERE email = ? AND status = ?'
  ).bind(email.toLowerCase().trim(), 'active').first<{ id: string; name: string }>();

  if (dbUser) {
    await c.env.DB.prepare(CREATE_RESET_TOKENS_TABLE).run();

    const token = newUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_SECONDS;

    await c.env.DB.prepare(
      'INSERT INTO password_reset_tokens (token, user_id, expires_at, used) VALUES (?, ?, ?, 0)'
    ).bind(token, dbUser.id, expiresAt).run();

    const resetUrl = `${c.env.APP_BASE_URL}/reset-password?token=${token}`;

    if (c.env.RESEND_API_KEY) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${c.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: c.env.FROM_EMAIL,
          to: email.toLowerCase().trim(),
          subject: 'Athletics Insurance Portal — Password Reset',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px"><h2 style="color:#003DA5">Password Reset Request</h2><p>Hi ${dbUser.name},</p><p>We received a request to reset your password for the University of Toledo Athletics Insurance Portal.</p><p><a href="${resetUrl}" style="background:#003DA5;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block;margin:12px 0">Reset My Password</a></p><p style="color:#666;font-size:14px">This link will expire in 1 hour. If you did not request a password reset, please ignore this email.</p><hr style="margin-top:30px;border:none;border-top:1px solid #eee"/><p style="color:#888;font-size:12px">University of Toledo Athletics — Health Insurance Request System</p></div>`,
        }),
      }).catch(() => {/* ignore email send errors */});
    }
  }

  return json({ message: 'If an account with that email exists, a reset link has been sent.' });
});

// POST /auth/reset-password — reset password with token
app.post('/auth/reset-password', async c => {
  const { token, newPassword } = await c.req.json<{ token: string; newPassword: string }>();
  if (!token || !newPassword) return err('Missing required fields');
  if (newPassword.length < 8) return err('Password must be at least 8 characters');

  await c.env.DB.prepare(CREATE_RESET_TOKENS_TABLE).run();

  const resetToken = await c.env.DB.prepare(
    'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token = ?'
  ).bind(token).first<{ user_id: string; expires_at: number; used: number }>();

  if (!resetToken) return err('Invalid or expired reset link', 400);
  if (resetToken.used) return err('This reset link has already been used', 400);
  if (Math.floor(Date.now() / 1000) > resetToken.expires_at) return err('This reset link has expired', 400);

  const newHash = await hashPassword(newPassword);
  await c.env.DB.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?'
  ).bind(newHash, resetToken.user_id).run();

  await c.env.DB.prepare(
    'UPDATE password_reset_tokens SET used = 1 WHERE token = ?'
  ).bind(token).run();

  return json({ ok: true });
});

// GET /auth/me
app.get('/auth/me', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  return json({ id: user.sub, email: user.email, name: user.name, role: user.role, sportId: user.sportId });
});

// GET /auth/identities — list coaches, sport admins, and CFO for identity selection
app.get('/auth/identities', async c => {
  const { results: coaches } = await c.env.DB.prepare(`
    SELECT id as sportId, name as sportName, gender, head_coach as coachName
    FROM sports_programs WHERE head_coach IS NOT NULL ORDER BY name
  `).all();
  const { results: admins } = await c.env.DB.prepare(`
    SELECT id, name, title FROM sport_administrators WHERE is_cfo = 0 ORDER BY name
  `).all();
  const cfo = await c.env.DB.prepare(`
    SELECT id, name, title FROM sport_administrators WHERE is_cfo = 1
  `).first();
  return json({ coaches, admins, cfo });
});

// POST /auth/select — select identity (no password required)
app.post('/auth/select', async c => {
  const { role } = await c.req.json<{
    role: string;
  }>();

  // Only coach uses the select flow now (anonymous, instant access)
  if (role !== 'coach') return err('Only coach role uses identity selection');

  const email = 'anonymous@coaches.utoledo.edu';
  const name = 'Coach';

  const sub = `coach_anonymous_${newUUID()}`;
  const payload = {
    sub,
    email,
    name,
    role: 'coach' as const,
    sportId: undefined,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7,
  };

  const token = await signJWT(payload, c.env.JWT_SECRET);
  return new Response(JSON.stringify({
    id: sub, email, name, role: 'coach', sportId: undefined,
  }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setAuthCookie(token, isSecure(c.req.raw)),
    },
  });
});

// POST /auth/register — self-service registration for Sport Admin and CFO
app.post('/auth/register', async c => {
  const { email, password, name, role } = await c.req.json<{
    email: string; password: string; name: string; role: string;
  }>();

  if (!email || !password || !name || !role) return err('Missing required fields');
  if (!['sport_admin', 'cfo'].includes(role)) return err('Only Sport Admin and CFO roles can self-register');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase()).first();
  if (exists) return err('Email already in use', 409);

  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, 'pending').run();

  return json({ message: 'Your account request has been submitted. A Super Admin will review and approve it.' }, 201);
});

// ── Sports ────────────────────────────────────────────────────────────────────

app.get('/api/sports', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT sp.id, sp.name, sp.gender, sp.head_coach as headCoach,
           sp.head_coach_email as headCoachEmail,
           sp.sport_admin_id as sportAdminId,
           sa.name as sportAdminName, sa.email as sportAdminEmail
    FROM sports_programs sp
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    ORDER BY sp.name
  `).all();
  return json(results);
});

// GET /api/admin/sport-admins — list selectable sport administrators (admin only)
app.get('/api/admin/sport-admins', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, title, email, is_cfo as isCfo FROM sport_administrators ORDER BY name'
  ).all();
  return json(results);
});

// ── Requests ──────────────────────────────────────────────────────────────────

// GET /api/requests — list (filtered by role)
app.get('/api/requests', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);

  const { sport, term, status, coach } = c.req.query();

  let query = `
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, ir.term, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  // Coaches now see ALL requests (anonymous coach model).
  // Sport admins see only their assigned sport's requests.
  if (user.role === 'sport_admin' && user.sportId) {
    query += ' AND ir.sport = ?'; params.push(user.sportId);
  }
  // cfo and super_admin see all requests

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
    athletes: { studentName: string; rocketNumber: string; email?: string }[];
    term: string;
    sport: string;
    fundingSource?: string;
    coachEmail?: string;
  }>();

  if (!body.athletes?.length || !body.term) return err('Missing athletes or term');
  if (!body.sport) return err('Sport is required');

  const fundingSource = body.fundingSource ?? 'operating_budget';
  if (!FUNDING_SOURCES.includes(fundingSource as typeof FUNDING_SOURCES[number])) {
    return err('Invalid funding source');
  }

  if (!isBeforeDeadline(body.term)) {
    return err('Submission deadline has passed for this term', 422);
  }

  const premiumCost = getPremiumForTerm(body.term);
  if (!premiumCost) return err('Unknown term', 400);

  const sport = body.sport;

  // Pull the head coach name/email the Super Admin maintains for this sport, so the
  // coach's info is pre-populated on the request and at signing time.
  const sportRow = await c.env.DB.prepare(
    'SELECT head_coach, head_coach_email FROM sports_programs WHERE id = ?'
  ).bind(sport).first<{ head_coach: string | null; head_coach_email: string | null }>();
  if (!sportRow) return err('Unknown sport', 400);

  // Coach-provided email wins; otherwise fall back to the sport's head coach email.
  const coachEmail = (body.coachEmail?.trim() || sportRow.head_coach_email || '') || null;
  if (coachEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coachEmail)) {
    return err('Invalid coach email');
  }
  const coachName = sportRow.head_coach?.trim() || '';

  const created = [];

  for (const athlete of body.athletes) {
    if (!athlete.studentName?.trim()) return err('Student name is required');
    if (!validateRocketNumber(athlete.rocketNumber)) {
      return err(`Invalid Rocket Number: ${athlete.rocketNumber}`);
    }
    const studentEmail = athlete.email?.trim() || null;
    if (studentEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(studentEmail)) {
      return err(`Invalid email for ${athlete.studentName.trim()}`);
    }

    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM insurance_requests WHERE rocket_number = ? AND term = ? AND sport = ?'
    ).bind(athlete.rocketNumber, body.term, sport).first();
    if (duplicate) {
      return err(`A request already exists for ${athlete.rocketNumber} in ${body.term} for this sport`);
    }

    const id = newUUID();
    const initialStatus = 'PENDING_COACH';

    await c.env.DB.prepare(`
      INSERT INTO insurance_requests
        (id, student_name, rocket_number, student_email, sport, term, premium_cost, funding_source, status, coach_email, coach_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, athlete.studentName.trim(), athlete.rocketNumber, studentEmail, sport,
      body.term, premiumCost, fundingSource, initialStatus, coachEmail, coachName
    ).run();

    // Audit log
    await c.env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'SUBMITTED', ?, ?)
    `).bind(newUUID(), id, user.name ?? 'Coach', JSON.stringify({ status: initialStatus, fundingSource })).run();

    created.push({ id, studentName: athlete.studentName.trim(), rocketNumber: athlete.rocketNumber, studentEmail, sport, term: body.term, premiumCost, fundingSource, status: initialStatus, coachEmail, coachName });
  }

  return json(created, 201);
});

// GET /api/requests/:id
app.get('/api/requests/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  const { id } = c.req.param();

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.student_email as studentEmail,
           ir.sport, ir.term, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!req) return err('Not found', 404);

  // RBAC check — coaches can now view all requests (anonymous model)

  const { results: sigs } = await c.env.DB.prepare(`
    SELECT id, request_id as requestId, signatory_role as signatoryRole,
           signatory_email as signatoryEmail, signatory_name as signatoryName, timestamp
    FROM signatures WHERE request_id = ? ORDER BY timestamp ASC
  `).bind(id).all();

  return json({ ...req, signatures: sigs });
});

// POST /api/requests/:id/sign — in-app signing for sport admin, CFO, and super_admin
app.post('/api/requests/:id/sign', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach' && user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only authorized roles can sign in-app', 403);
  }

  const { id } = c.req.param();
  const { coachName } = await c.req.json<{ coachName?: string }>().catch(() => ({ coachName: undefined }));
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.status, ir.sport, ir.coach_email as coachEmail
    FROM insurance_requests ir
    WHERE ir.id = ?
  `).bind(id).first<{ id: string; status: string; sport: string; coachEmail: string }>();

  if (!req) return err('Not found', 404);

  // Existing approver signatures (parallel approval: either may go first)
  const { results: existingSigs } = await c.env.DB.prepare(
    'SELECT signatory_role FROM signatures WHERE request_id = ?'
  ).bind(id).all<{ signatory_role: string }>();
  const signedRoles = new Set(existingSigs.map(s => s.signatory_role));

  // Determine which role this user signs as
  let sigRole: 'COACH' | 'SPORT_ADMIN' | 'CFO';
  if (user.role === 'coach') {
    sigRole = 'COACH';
  } else if (user.role === 'cfo') {
    sigRole = 'CFO';
  } else if (user.role === 'sport_admin') {
    sigRole = 'SPORT_ADMIN';
  } else {
    // super_admin fills whichever required approval is still outstanding
    if (req.status !== 'PENDING_APPROVAL') return err('This request is not awaiting approval', 409);
    if (!signedRoles.has('CFO')) sigRole = 'CFO';
    else if (!signedRoles.has('SPORT_ADMIN') && !isSoftball(req.sport)) sigRole = 'SPORT_ADMIN';
    else return err('All required approvals are already recorded', 409);
  }

  // Validate status matches the expected signer
  if (sigRole === 'COACH' && req.status !== 'PENDING_COACH') {
    return err('This request is not awaiting coach signature', 409);
  }
  if (sigRole !== 'COACH' && req.status !== 'PENDING_APPROVAL') {
    return err('This request is not awaiting approval', 409);
  }
  if (signedRoles.has(sigRole)) return err('Already signed', 409);

  const signatoryName = sigRole === 'COACH' ? (coachName?.trim() || 'Unknown Coach') : user.name;

  // Record signature + audit
  await c.env.DB.prepare(`
    INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(newUUID(), id, sigRole, user.email || '', signatoryName, ip).run();

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, request_id, action, performed_by, details)
    VALUES (?, ?, 'SIGNED', ?, ?)
  `).bind(newUUID(), id, user.email || signatoryName, JSON.stringify({ role: sigRole })).run();

  // Advance status + notify
  let newStatus: string;
  if (sigRole === 'COACH') {
    newStatus = 'PENDING_APPROVAL';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, coach_name = ? WHERE id = ?')
      .bind(newStatus, signatoryName, id).run();
    const d = await loadRequestEmailData(c.env, id);
    if (d) { d.status = newStatus; await notifySubmission(c.env, d); }
  } else {
    // Sport Admin or CFO approval — executed once all required approvals exist
    const allApproved = await hasAllApprovals(c.env, id, req.sport);
    newStatus = allApproved ? 'EXECUTED' : 'PENDING_APPROVAL';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind(newStatus, id).run();
    if (allApproved) {
      const d = await loadRequestEmailData(c.env, id);
      if (d) { d.status = newStatus; await notifyExecuted(c.env, d); }
    }
  }

  return json({ id, status: newStatus });
});

// GET /api/requests/:id/pdf — download completed authorization PDF
app.get('/api/requests/:id/pdf', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);

  const { id } = c.req.param();

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, ir.term, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           sp.name as sportName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE ir.id = ?
  `).bind(id).first<{
    id: string; studentName: string; rocketNumber: string; sport: string;
    term: string; premiumCost: number; fundingSource: string; status: string;
    coachEmail: string; coachName: string; sportName: string | null;
  }>();

  if (!req) return err('Not found', 404);

  // RBAC — coaches can view all in anonymous model

  const { results: sigs } = await c.env.DB.prepare(`
    SELECT signatory_role as role, signatory_name as name, timestamp
    FROM signatures WHERE request_id = ? ORDER BY timestamp ASC
  `).bind(id).all<{ role: string; name: string; timestamp: string }>();

  const pdfData: PdfFormData = {
    studentName: req.studentName,
    rocketNumber: req.rocketNumber,
    sport: req.sportName ?? req.sport,
    term: req.term,
    premiumCost: `$${req.premiumCost.toFixed(2)}`,
    fundingSource: req.fundingSource,
    coachName: req.coachName,
    coachEmail: req.coachEmail,
    submissionDeadline: getSubmissionDeadline(req.term),
    signatures: sigs.map(s => ({
      role: s.role as 'COACH' | 'SPORT_ADMIN' | 'CFO',
      name: s.name,
      date: new Date(s.timestamp).toLocaleDateString('en-US'),
    })),
  };

  const pdfBytes = await buildInsuranceFormPdf(pdfData);

  const filename = `insurance-auth-${req.rocketNumber}-${req.term.replace(/\s+/g, '-')}.pdf`;
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
    },
  });
});

// POST /api/requests/:id/void — CFO or super_admin
app.post('/api/requests/:id/void', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') return err('Only CFO or Super Admin can void requests', 403);

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
  if (req.status !== 'PENDING_APPROVAL') {
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
    studentEmail: (req.student_email as string) || undefined,
    sport: req.sport as string,
    sportName: req.sportName as string ?? req.sport,
    term: req.term as string,
    premiumCost: req.premium_cost as number,
    fundingSource: (req.funding_source as string) || 'operating_budget',
    coachName: req.coach_name as string,
    coachEmail: req.coach_email as string,
    requestId: id,
    status: 'VOIDED',
    voidReason: reason.trim(),
  };

  await notifyVoided(c.env, emailData, req.sportAdminEmail as string ?? undefined);

  return json({ id, status: 'VOIDED' });
});

// DELETE /api/requests/:id — super_admin only (permanent delete)
app.delete('/api/requests/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'super_admin') return err('Only Super Admin can delete requests', 403);

  const { id } = c.req.param();

  const req = await c.env.DB.prepare('SELECT id FROM insurance_requests WHERE id = ?').bind(id).first();
  if (!req) return err('Not found', 404);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM signatures WHERE request_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM insurance_requests WHERE id = ?').bind(id),
  ]);

  return json({ ok: true });
});

// ── Reports (CFO and super_admin) ────────────────────────────────────────────

app.get('/api/reports', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') return err('Forbidden', 403);

  const { sport, term, status, coach } = c.req.query();
  let query = `
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, sp.name as sportName, ir.term, ir.coach_name as coachName,
           ir.coach_email as coachEmail, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status, ir.created_at as createdAt
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

// GET /api/reports/csv — CFO and super_admin, CSV download
app.get('/api/reports/csv', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') return err('Forbidden', 403);

  const { sport, term, status, coach } = c.req.query();
  let query = `
    SELECT ir.student_name, ir.rocket_number, ir.sport,
           sp.name as sport_name, ir.term, ir.funding_source, ir.coach_name, ir.coach_email,
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

  const fundingLabel = (s: unknown) => (s === 'foundation_account' ? 'Foundation Account' : 'Operating Budget');
  const headers = ['Student Name', 'Rocket Number', 'Sport', 'Term', 'Funding Source', 'Coach', 'Coach Email', 'Premium ($)', 'Status', 'Submitted'];
  const csvRows = [
    headers.join(','),
    ...results.map(r => [
      csvEscape(String(r.student_name ?? '')),
      csvEscape(String(r.rocket_number ?? '')),
      csvEscape(String(r.sport_name ?? r.sport ?? '')),
      csvEscape(String(r.term ?? '')),
      csvEscape(fundingLabel(r.funding_source)),
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

const isAdmin = (role: string) => role === 'cfo' || role === 'super_admin';

app.get('/api/admin/users', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, role, sport_id as sportId, must_change_password as mustChangePassword, status, created_at as createdAt FROM users ORDER BY created_at DESC'
  ).all();
  return json(results);
});

app.post('/api/admin/users', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);

  const { email, password, name, role, sportId } = await c.req.json<{
    email: string; password: string; name: string; role: string; sportId?: string;
  }>();

  if (!email || !password || !name || !role) return err('Missing required fields');
  if (!['coach', 'sport_admin', 'cfo', 'super_admin'].includes(role)) return err('Invalid role');
  if (password.length < 8) return err('Password must be at least 8 characters');

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase()).first();
  if (exists) return err('Email already in use', 409);

  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, sport_id, must_change_password, status) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, sportId ?? null, 'active').run();

  return json({ id, email: email.toLowerCase(), name, role, sportId: sportId ?? null, mustChangePassword: 1, status: 'active', createdAt: new Date().toISOString() }, 201);
});

app.delete('/api/admin/users/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  if (id === user.sub) return err('Cannot delete your own account', 400);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return json({ ok: true });
});

// PUT /api/admin/users/:id/approve — approve pending user
app.put('/api/admin/users/:id/approve', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can approve users', 403);
  const { id } = c.req.param();
  await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ? AND status = ?')
    .bind('active', id, 'pending').run();
  return json({ ok: true });
});

// PUT /api/admin/users/:id/reject — reject pending user
app.put('/api/admin/users/:id/reject', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can reject users', 403);
  const { id } = c.req.param();
  await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ? AND status = ?')
    .bind('rejected', id, 'pending').run();
  return json({ ok: true });
});

// POST /api/requests/bulk-sign — bulk approve for sport admin, CFO, and super_admin
app.post('/api/requests/bulk-sign', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach' && user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only authorized roles can bulk sign', 403);
  }

  const { ids, coachName } = await c.req.json<{ ids: string[]; coachName?: string }>();
  if (!ids?.length) return err('No request IDs provided');

  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  const results: { id: string; status: string }[] = [];

  for (const id of ids) {
    const req = await c.env.DB.prepare(`
      SELECT ir.id, ir.status, ir.sport
      FROM insurance_requests ir
      WHERE ir.id = ?
    `).bind(id).first<{ id: string; status: string; sport: string }>();

    if (!req) continue;

    const { results: existingSigs } = await c.env.DB.prepare(
      'SELECT signatory_role FROM signatures WHERE request_id = ?'
    ).bind(id).all<{ signatory_role: string }>();
    const signedRoles = new Set(existingSigs.map(s => s.signatory_role));

    let sigRole: 'COACH' | 'SPORT_ADMIN' | 'CFO';
    if (user.role === 'coach') {
      sigRole = 'COACH';
    } else if (user.role === 'cfo') {
      sigRole = 'CFO';
    } else if (user.role === 'sport_admin') {
      sigRole = 'SPORT_ADMIN';
    } else {
      // super_admin fills whichever required approval is still outstanding
      if (req.status !== 'PENDING_APPROVAL') continue;
      if (!signedRoles.has('CFO')) sigRole = 'CFO';
      else if (!signedRoles.has('SPORT_ADMIN') && !isSoftball(req.sport)) sigRole = 'SPORT_ADMIN';
      else continue;
    }

    if (sigRole === 'COACH' && req.status !== 'PENDING_COACH') continue;
    if (sigRole !== 'COACH' && req.status !== 'PENDING_APPROVAL') continue;
    if (signedRoles.has(sigRole)) continue;

    const signatoryName = sigRole === 'COACH' ? (coachName?.trim() || 'Unknown Coach') : user.name;

    await c.env.DB.prepare(`
      INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(newUUID(), id, sigRole, user.email || '', signatoryName, ip).run();

    await c.env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'SIGNED', ?, ?)
    `).bind(newUUID(), id, user.email || signatoryName, JSON.stringify({ role: sigRole, bulk: true })).run();

    let newStatus: string;
    if (sigRole === 'COACH') {
      newStatus = 'PENDING_APPROVAL';
      await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, coach_name = ? WHERE id = ?')
        .bind(newStatus, signatoryName, id).run();
      const d = await loadRequestEmailData(c.env, id);
      if (d) { d.status = newStatus; await notifySubmission(c.env, d); }
    } else {
      const allApproved = await hasAllApprovals(c.env, id, req.sport);
      newStatus = allApproved ? 'EXECUTED' : 'PENDING_APPROVAL';
      await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
        .bind(newStatus, id).run();
      if (allApproved) {
        const d = await loadRequestEmailData(c.env, id);
        if (d) { d.status = newStatus; await notifyExecuted(c.env, d); }
      }
    }

    results.push({ id, status: newStatus });
  }

  return json({ signed: results.length, results });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// POST /api/admin/sports — create a new sport/program (Super Admin)
app.post('/api/admin/sports', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can add sports', 403);
  const { name, gender, headCoach, headCoachEmail, sportAdminId } = await c.req.json<{
    name: string; gender: string; headCoach?: string; headCoachEmail?: string; sportAdminId?: string;
  }>();
  if (!name?.trim() || !gender?.trim()) return err('Name and gender are required');
  const email = headCoachEmail?.trim() || null;
  if (email && !EMAIL_RE.test(email)) return err('Invalid head coach email');

  let id = slugify(name);
  if (!id) return err('Invalid sport name');
  const clash = await c.env.DB.prepare('SELECT id FROM sports_programs WHERE id = ?').bind(id).first();
  if (clash) id = `${id}_${newUUID().slice(0, 6)}`;

  await c.env.DB.prepare(
    'INSERT INTO sports_programs (id, name, gender, head_coach, head_coach_email, sport_admin_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, name.trim(), gender.trim(), headCoach?.trim() || null, email, sportAdminId || null).run();

  return json({ id, name: name.trim(), gender: gender.trim(), headCoach: headCoach?.trim() || null, headCoachEmail: email, sportAdminId: sportAdminId || null }, 201);
});

// PUT /api/admin/sports/:id — update sport details + admin assignment (Super Admin)
app.put('/api/admin/sports/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  const body = await c.req.json<{
    name?: string; gender?: string; headCoach?: string | null;
    headCoachEmail?: string | null; sportAdminId?: string | null; adminId?: string | null;
  }>();

  const sport = await c.env.DB.prepare('SELECT * FROM sports_programs WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!sport) return err('Not found', 404);

  const email = body.headCoachEmail?.trim() || null;
  if (email && !EMAIL_RE.test(email)) return err('Invalid head coach email');

  // `adminId` kept for backward compatibility with the old assign-only call.
  const sportAdminId = body.sportAdminId !== undefined ? body.sportAdminId
    : body.adminId !== undefined ? body.adminId
    : (sport.sport_admin_id as string | null);

  await c.env.DB.prepare(`
    UPDATE sports_programs
    SET name = ?, gender = ?, head_coach = ?, head_coach_email = ?, sport_admin_id = ?
    WHERE id = ?
  `).bind(
    body.name?.trim() || (sport.name as string),
    body.gender?.trim() || (sport.gender as string),
    body.headCoach !== undefined ? (body.headCoach?.trim() || null) : (sport.head_coach as string | null),
    body.headCoachEmail !== undefined ? email : (sport.head_coach_email as string | null),
    sportAdminId || null,
    id,
  ).run();

  return json({ ok: true });
});

// DELETE /api/admin/sports/:id — remove a sport with no requests (Super Admin)
app.delete('/api/admin/sports/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can delete sports', 403);
  const { id } = c.req.param();
  const inUse = await c.env.DB.prepare('SELECT id FROM insurance_requests WHERE sport = ? LIMIT 1').bind(id).first();
  if (inUse) return err('Cannot delete a sport that already has insurance requests', 409);
  await c.env.DB.prepare('DELETE FROM sports_programs WHERE id = ?').bind(id).run();
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
    SELECT ir.id, ir.student_name, ir.rocket_number, ir.student_email, ir.sport, sp.name as sportName,
           ir.term, ir.premium_cost, ir.funding_source, ir.status, ir.coach_email, ir.coach_name,
           sa.email as adminEmail, sa.name as adminName,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.status = 'PENDING_APPROVAL'
      AND ir.created_at < ?
  `).bind(cutoff).all<{
    id: string; student_name: string; rocket_number: string; student_email: string | null;
    sport: string; sportName: string; term: string; premium_cost: number; funding_source: string;
    status: string; coach_email: string; coach_name: string;
    adminEmail: string | null; adminName: string | null;
    sportAdminSigned: number; cfoSigned: number;
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
      studentEmail: r.student_email || undefined,
      sport: r.sport,
      sportName: r.sportName,
      term: r.term,
      premiumCost: r.premium_cost,
      fundingSource: r.funding_source || 'operating_budget',
      coachName: r.coach_name,
      coachEmail: r.coach_email,
      requestId: r.id,
      status: r.status,
    };

    // Remind each approver who still owes a signature
    if (!isSoftball(r.sport) && !r.sportAdminSigned && r.adminEmail) {
      await notifyReminder(env, emailData, r.adminEmail, 'Sport Administrator');
    }
    if (!r.cfoSigned) {
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

