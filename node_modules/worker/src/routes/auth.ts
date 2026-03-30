import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { getDb, schema } from '../lib/db';
import {
  buildSamlAuthnRequest,
  parseSamlResponse,
  createSessionCookie,
  clearSessionCookie,
  getSessionUser,
} from '../lib/auth';
import { resolveRole, getAdminSportIds } from '../lib/rbac';

const auth = new Hono<{ Bindings: Env }>();

// ─── GET /auth/login — redirect to IdP ──────────────────────────────────────
auth.get('/login', async (c) => {
  if (!c.env.SAML_IDP_SSO_URL) {
    return c.text('SAML IdP not configured. Contact system administrator.', 503);
  }
  const redirectUrl = await buildSamlAuthnRequest(
    c.env.SAML_ENTITY_ID,
    c.env.SAML_ACS_URL,
    c.env.SAML_IDP_SSO_URL,
  );
  return c.redirect(redirectUrl, 302);
});

// ─── POST /auth/callback — receive SAMLResponse from IdP ─────────────────────
auth.post('/callback', async (c) => {
  const body = await c.req.parseBody();
  const samlResponse = body['SAMLResponse'] as string | undefined;

  if (!samlResponse) {
    return c.text('Missing SAMLResponse', 400);
  }

  const parsed = parseSamlResponse(samlResponse);
  if (!parsed) {
    return c.text('Invalid SAML response', 400);
  }

  const db = getDb(c.env.DB);
  const role = await resolveRole(db, parsed.email);
  const adminSportIds = role === 'sport_admin' ? await getAdminSportIds(db, parsed.email) : undefined;

  const sessionCookie = await createSessionCookie(
    { email: parsed.email, displayName: parsed.displayName, role, adminSportIds },
    c.env.JWT_SECRET,
  );

  // Log the login event
  await db.insert(schema.auditLog).values({
    id: crypto.randomUUID(),
    requestId: null,
    action: 'LOGIN',
    performedBy: parsed.email,
    details: JSON.stringify({ displayName: parsed.displayName, role }),
  });

  return new Response(null, {
    status: 302,
    headers: {
      'Location': `${c.env.APP_BASE_URL}/dashboard`,
      'Set-Cookie': sessionCookie,
    },
  });
});

// ─── GET /auth/me — return current session user ──────────────────────────────
auth.get('/me', async (c) => {
  const user = await getSessionUser(c.req.raw, c.env.JWT_SECRET);
  if (!user) return c.json({ error: 'Not authenticated' }, 401);
  return c.json(user);
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
auth.post('/logout', (c) => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': clearSessionCookie(),
    },
  });
});

// ─── POST /auth/dev-login — only active when DEV_MODE=true ───────────────────
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
