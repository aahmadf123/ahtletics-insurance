import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import {
  createSessionCookie,
  clearSessionCookie,
  getSessionUser,
  hashPassword,
  verifyPassword,
} from '../lib/auth';
import { resolveRole, getAdminSportIds } from '../lib/rbac';

const auth = new Hono<{ Bindings: Env }>();

// POST /auth/login — email + password
auth.post('/login', async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400);

  const db = getDb(c.env.DB);
  const user = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase().trim()))
    .get();

  if (!user) return c.json({ error: 'Invalid email or password' }, 401);

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return c.json({ error: 'Invalid email or password' }, 401);

  const role = await resolveRole(db, user.email);
  const adminSportIds = role === 'sport_admin' ? await getAdminSportIds(db, user.email) : undefined;

  const sessionCookie = await createSessionCookie(
    { email: user.email, displayName: user.displayName, role, adminSportIds },
    c.env.JWT_SECRET,
  );

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'LOGIN',
    performedBy: user.email,
    details: JSON.stringify({ displayName: user.displayName, role }),
  });

  return new Response(JSON.stringify({ ok: true, role }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie,
    },
  });
});

// POST /auth/register — create a new user account
auth.post('/register', async (c) => {
  const { email, password, displayName } = await c.req.json<{
    email: string;
    password: string;
    displayName: string;
  }>();

  if (!email || !password || !displayName) {
    return c.json({ error: 'Email, password, and display name are required' }, 400);
  }
  if (password.length < 8) {
    return c.json({ error: 'Password must be at least 8 characters' }, 400);
  }

  const db = getDb(c.env.DB);

  // Check if email already exists
  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase().trim()))
    .get();

  if (existing) return c.json({ error: 'An account with this email already exists' }, 409);

  const passwordHash = await hashPassword(password);

  await db.insert(schema.users).values({
    id: crypto.randomUUID(),
    email: email.toLowerCase().trim(),
    passwordHash,
    displayName: displayName.trim(),
  });

  // Auto-login after registration
  const role = await resolveRole(db, email.toLowerCase().trim());
  const adminSportIds = role === 'sport_admin' ? await getAdminSportIds(db, email.toLowerCase().trim()) : undefined;

  const sessionCookie = await createSessionCookie(
    { email: email.toLowerCase().trim(), displayName: displayName.trim(), role, adminSportIds },
    c.env.JWT_SECRET,
  );

  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'REGISTERED',
    performedBy: email.toLowerCase().trim(),
    details: JSON.stringify({ displayName: displayName.trim(), role }),
  });

  return new Response(JSON.stringify({ ok: true, role }), {
    status: 201,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie,
    },
  });
});

// GET /auth/me
auth.get('/me', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);
  return c.json(user);
});

// POST /auth/logout
auth.post('/logout', (c) => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
});

// POST /auth/dev-login — only active when DEV_MODE=true
auth.post('/dev-login', async (c) => {
  if (c.env.DEV_MODE !== 'true') {
    return c.json({ error: 'Not available in production' }, 404);
  }

  const { email, displayName } = await c.req.json<{ email: string; displayName: string }>();
  if (!email) return c.json({ error: 'email required' }, 400);

  const db = getDb(c.env.DB);
  const role = await resolveRole(db, email);
  const adminSportIds = role === 'sport_admin' ? await getAdminSportIds(db, email) : undefined;

  const sessionCookie = await createSessionCookie(
    { email, displayName: displayName ?? email, role, adminSportIds },
    c.env.JWT_SECRET,
  );

  return new Response(JSON.stringify({ ok: true, role }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': sessionCookie,
    },
  });
});

export default auth;
