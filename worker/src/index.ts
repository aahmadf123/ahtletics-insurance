import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  hashPassword, verifyPassword, signJWT, getUser, setAuthCookie, clearAuthCookie,
} from './lib/auth';
import {
  notifyPendingSportAdmin, notifyPendingCFO, notifyExecuted, notifyVoided, notifyReminder,
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
    await c.env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        used INTEGER NOT NULL DEFAULT 0
      )
    `).run();

    const token = newUUID();
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60; // 1 hour

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

  await c.env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    )
  `).run();

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
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, ir.term, ir.premium_cost as premiumCost, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail
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
    athletes: { studentName: string; rocketNumber: string }[];
    term: string;
    coachName: string;
    sport: string;
  }>();

  if (!body.athletes?.length || !body.term) return err('Missing athletes or term');
  if (!body.coachName?.trim()) return err('Coach name is required');
  if (!body.sport) return err('Sport is required');

  if (!isBeforeDeadline(body.term)) {
    return err('Submission deadline has passed for this term', 422);
  }

  const premiumCost = getPremiumForTerm(body.term);
  if (!premiumCost) return err('Unknown term', 400);

  const coachName = body.coachName.trim();
  const sport = body.sport;
  const created = [];

  for (const athlete of body.athletes) {
    if (!athlete.studentName?.trim()) return err('Student name is required');
    if (!validateRocketNumber(athlete.rocketNumber)) {
      return err(`Invalid Rocket Number: ${athlete.rocketNumber}`);
    }

    const duplicate = await c.env.DB.prepare(
      'SELECT id FROM insurance_requests WHERE rocket_number = ? AND term = ? AND sport = ?'
    ).bind(athlete.rocketNumber, body.term, sport).first();
    if (duplicate) {
      return err(`A request already exists for ${athlete.rocketNumber} in ${body.term} for this sport`);
    }

    const id = newUUID();
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
    const isSoftball = sport === 'womens_softball';
    const initialStatus = isSoftball ? 'PENDING_CFO' : 'PENDING_SPORT_ADMIN';

    await c.env.DB.prepare(`
      INSERT INTO insurance_requests
        (id, student_name, rocket_number, sport, term, premium_cost, status, coach_email, coach_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id, athlete.studentName.trim(), athlete.rocketNumber, sport,
      body.term, premiumCost, initialStatus, null, coachName
    ).run();

    // Coach signature
    await c.env.DB.prepare(`
      INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
      VALUES (?, ?, 'COACH', ?, ?, ?)
    `).bind(newUUID(), id, '', coachName, ip).run();

    // Audit log
    await c.env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'SUBMITTED', ?, ?)
    `).bind(newUUID(), id, coachName, JSON.stringify({ status: initialStatus })).run();

    // Get sport admin for notification
    const sportRow = await c.env.DB.prepare(`
      SELECT sp.name as sportName, sa.email as adminEmail, sa.name as adminName
      FROM sports_programs sp
      LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
      WHERE sp.id = ?
    `).bind(sport).first<{ sportName: string; adminEmail: string | null; adminName: string | null }>();

    const emailData = {
      studentName: athlete.studentName.trim(),
      rocketNumber: athlete.rocketNumber,
      sport,
      sportName: sportRow?.sportName ?? sport,
      term: body.term,
      premiumCost,
      coachName,
      coachEmail: '',
      requestId: id,
      status: initialStatus,
    };

    // Email notifications
    if (isSoftball) {
      await notifyPendingCFO(c.env, emailData);
    } else if (sportRow?.adminEmail) {
      await notifyPendingSportAdmin(c.env, emailData, sportRow.adminEmail);
    }

    created.push({ id, studentName: athlete.studentName.trim(), rocketNumber: athlete.rocketNumber, sport, term: body.term, premiumCost, status: initialStatus, coachEmail: null, coachName });
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
           ir.sport, ir.term, ir.premium_cost as premiumCost, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail
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
  if (user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only sport admins, CFO, and super admins can sign in-app', 403);
  }

  const { id } = c.req.param();
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.status, ir.sport, ir.coach_email as coachEmail,
           sp.sport_admin_id as sportAdminId
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE ir.id = ?
  `).bind(id).first<{
    id: string; status: string; sport: string; coachEmail: string; sportAdminId: string | null;
  }>();

  if (!req) return err('Not found', 404);

  // Determine expected signer role
  // Super admin can sign as either SPORT_ADMIN or CFO depending on current status
  let sigRole: string;
  if (user.role === 'super_admin') {
    if (req.status === 'PENDING_SPORT_ADMIN') sigRole = 'SPORT_ADMIN';
    else if (req.status === 'PENDING_CFO') sigRole = 'CFO';
    else return err('This request is not awaiting any approval', 409);
  } else {
    sigRole = user.role === 'cfo' ? 'CFO' : 'SPORT_ADMIN';
  }

  // Validate status matches the expected signer
  if (sigRole === 'SPORT_ADMIN' && req.status !== 'PENDING_SPORT_ADMIN') {
    return err('This request is not awaiting sport admin approval', 409);
  }
  if (sigRole === 'CFO' && req.status !== 'PENDING_CFO') {
    return err('This request is not awaiting CFO approval', 409);
  }

  // Check for duplicate signature
  const existing = await c.env.DB.prepare(
    'SELECT id FROM signatures WHERE request_id = ? AND signatory_role = ?'
  ).bind(id, sigRole).first();
  if (existing) return err('Already signed', 409);

  // Record signature
  await c.env.DB.prepare(`
    INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(newUUID(), id, sigRole, user.email, user.name, ip).run();

  await c.env.DB.prepare(`
    INSERT INTO audit_log (id, request_id, action, performed_by, details)
    VALUES (?, ?, 'SIGNED', ?, ?)
  `).bind(newUUID(), id, user.email, JSON.stringify({ role: sigRole })).run();

  // Advance status
  let newStatus: string;
  if (sigRole === 'SPORT_ADMIN') {
    newStatus = 'PENDING_CFO';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind(newStatus, id).run();
    // Notify CFO
    const emailReq = await c.env.DB.prepare(`
      SELECT ir.student_name, ir.rocket_number, ir.sport, sp.name as sportName,
             ir.term, ir.premium_cost, ir.coach_name, ir.coach_email
      FROM insurance_requests ir
      LEFT JOIN sports_programs sp ON ir.sport = sp.id
      WHERE ir.id = ?
    `).bind(id).first<Record<string, unknown>>();
    if (emailReq) {
      await notifyPendingCFO(c.env, {
        studentName: emailReq.student_name as string,
        rocketNumber: emailReq.rocket_number as string,
        sport: emailReq.sport as string,
        sportName: (emailReq.sportName as string) ?? (emailReq.sport as string),
        term: emailReq.term as string,
        premiumCost: emailReq.premium_cost as number,
        coachName: emailReq.coach_name as string,
        coachEmail: emailReq.coach_email as string,
        requestId: id,
        status: newStatus,
      });
    }
  } else {
    // CFO signed → EXECUTED
    newStatus = 'EXECUTED';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind(newStatus, id).run();
    // Notify executed
    const emailReq = await c.env.DB.prepare(`
      SELECT ir.student_name, ir.rocket_number, ir.sport, sp.name as sportName,
             ir.term, ir.premium_cost, ir.coach_name, ir.coach_email,
             sa.email as sportAdminEmail
      FROM insurance_requests ir
      LEFT JOIN sports_programs sp ON ir.sport = sp.id
      LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
      WHERE ir.id = ?
    `).bind(id).first<Record<string, unknown>>();
    if (emailReq) {
      await notifyExecuted(c.env, {
        studentName: emailReq.student_name as string,
        rocketNumber: emailReq.rocket_number as string,
        sport: emailReq.sport as string,
        sportName: (emailReq.sportName as string) ?? (emailReq.sport as string),
        term: emailReq.term as string,
        premiumCost: emailReq.premium_cost as number,
        coachName: emailReq.coach_name as string,
        coachEmail: emailReq.coach_email as string,
        requestId: id,
        status: newStatus,
      }, emailReq.sportAdminEmail as string ?? undefined);
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
           ir.sport, ir.term, ir.premium_cost as premiumCost, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           sp.name as sportName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE ir.id = ?
  `).bind(id).first<{
    id: string; studentName: string; rocketNumber: string; sport: string;
    term: string; premiumCost: number; status: string;
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

// DELETE /api/requests/:id — super_admin only (permanent delete)
app.delete('/api/requests/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'super_admin') return err('Only Super Admin can delete requests', 403);

  const { id } = c.req.param();

  const req = await c.env.DB.prepare('SELECT id FROM insurance_requests WHERE id = ?').bind(id).first();
  if (!req) return err('Not found', 404);

  await c.env.DB.prepare('DELETE FROM signatures WHERE request_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM insurance_requests WHERE id = ?').bind(id).run();

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

// GET /api/reports/csv — CFO and super_admin, CSV download
app.get('/api/reports/csv', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') return err('Forbidden', 403);

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
  if (user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only sport admins, CFO, and super admins can bulk sign', 403);
  }

  const { ids } = await c.req.json<{ ids: string[] }>();
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

    let sigRole: string;
    if (user.role === 'super_admin') {
      if (req.status === 'PENDING_SPORT_ADMIN') sigRole = 'SPORT_ADMIN';
      else if (req.status === 'PENDING_CFO') sigRole = 'CFO';
      else continue;
    } else {
      sigRole = user.role === 'cfo' ? 'CFO' : 'SPORT_ADMIN';
    }

    if (sigRole === 'SPORT_ADMIN' && req.status !== 'PENDING_SPORT_ADMIN') continue;
    if (sigRole === 'CFO' && req.status !== 'PENDING_CFO') continue;

    const existing = await c.env.DB.prepare(
      'SELECT id FROM signatures WHERE request_id = ? AND signatory_role = ?'
    ).bind(id, sigRole).first();
    if (existing) continue;

    await c.env.DB.prepare(`
      INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(newUUID(), id, sigRole, user.email, user.name, ip).run();

    await c.env.DB.prepare(`
      INSERT INTO audit_log (id, request_id, action, performed_by, details)
      VALUES (?, ?, 'SIGNED', ?, ?)
    `).bind(newUUID(), id, user.email, JSON.stringify({ role: sigRole, bulk: true })).run();

    let newStatus: string;
    if (sigRole === 'SPORT_ADMIN') {
      newStatus = 'PENDING_CFO';
    } else {
      newStatus = 'EXECUTED';
    }
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind(newStatus, id).run();

    results.push({ id, status: newStatus });
  }

  return json({ signed: results.length, results });
});

// PUT /api/admin/sports/:id — update sport admin assignment
app.put('/api/admin/sports/:id', async c => {
  const user = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
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

