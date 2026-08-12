import { env } from 'cloudflare:test';
import worker from '../src/index';
import { hashPassword, signJWT, type JWTPayload } from '../src/lib/auth';

// Per-test tables, in dependency order — sport_admin_assignments before users, since
// it references it.
//
// `coaches` and `sport_administrators` are per-test state now. Migration 0002 no longer
// seeds people, so both start empty, but rows created through the API during a test
// would otherwise leak into every later one: vitest.config.ts sets singleWorker, so that
// means the rest of the suite.
const PER_TEST_TABLES = [
  'email_log', 'password_reset_tokens', 'app_settings', 'audit_log',
  'signatures', 'insurance_requests', 'sport_admin_assignments', 'coaches', 'users',
];

/** Clear per-test state and restore anything a test may have changed on the sport rows. */
export async function resetDatabase(): Promise<void> {
  for (const table of PER_TEST_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  // Detach before deleting the mirror: sports_programs.sport_admin_id is a foreign key
  // into sport_administrators, so the delete fails while any sport still points at a row.
  await env.DB.prepare(
    `UPDATE sports_programs
     SET sport_admin_id = NULL, head_coach = NULL, head_coach_email = NULL,
         single_approval = 0, budget_cap = NULL`
  ).run();
  await env.DB.prepare('DELETE FROM sport_administrators').run();
}

/**
 * An active administrator account plus its sport_administrators mirror row, matching what
 * POST /api/admin/users produces. `primaryFor` sets sports_programs.sport_admin_id (the
 * designated administrator, which drives single_approval); `sportIds` sets the assignments
 * that drive RBAC scoping and the notification fan-out.
 */
export async function seedAdministrator(opts: {
  email: string;
  role: 'sport_admin' | 'cfo';
  name?: string;
  status?: string;
  sportIds?: string[];
  primaryFor?: string[];
}): Promise<SeededUser> {
  const user = await seedUser({
    email: opts.email, role: opts.role, name: opts.name,
    status: opts.status, sportIds: opts.sportIds,
  });

  await env.DB.prepare(
    'INSERT OR REPLACE INTO sport_administrators (id, name, title, email, is_cfo) VALUES (?, ?, ?, ?, ?)'
  ).bind(
    user.id, opts.name ?? opts.email.split('@')[0],
    opts.role === 'cfo' ? 'Chief Financial Officer' : 'Sport Administrator',
    user.email, opts.role === 'cfo' ? 1 : 0,
  ).run();

  for (const sportId of opts.primaryFor ?? []) {
    await env.DB.prepare('UPDATE sports_programs SET sport_admin_id = ? WHERE id = ?')
      .bind(user.id, sportId).run();
    await env.DB.prepare(
      `UPDATE sports_programs SET single_approval = CASE
         WHEN sport_admin_id IN (SELECT id FROM users WHERE role = 'cfo' AND status = 'active')
         THEN 1 ELSE 0 END
       WHERE id = ?`
    ).bind(sportId).run();
  }

  return user;
}

/**
 * Give a sport a head coach with a working address.
 *
 * Without one, getHeadCoachForSport returns null and step 1 never routes — which is the
 * production defect these helpers exist to let us assert on, so it must be opt-in.
 */
export async function seedHeadCoach(sportId: string, email: string, name = 'Head Coach'): Promise<string> {
  const id = `coach_${sportId}`;
  await env.DB.prepare('UPDATE coaches SET is_head_coach = 0 WHERE sport_id = ?').bind(sportId).run();
  await env.DB.prepare(
    `INSERT OR REPLACE INTO coaches (id, display_name, email, sport_id, title, is_head_coach)
     VALUES (?, ?, ?, ?, 'Head Coach', 1)`
  ).bind(id, name, email.toLowerCase(), sportId).run();
  await env.DB.prepare('UPDATE sports_programs SET head_coach = ?, head_coach_email = ? WHERE id = ?')
    .bind(name, email.toLowerCase(), sportId).run();
  return id;
}

/**
 * Turn the provider on for one test. vitest.config.ts deliberately leaves RESEND_API_KEY
 * unset so the default suite records `skipped`; the mail-safety tests need a real send
 * attempt to assert what the envelope would have been.
 */
export function enableResend(): void {
  (env as { RESEND_API_KEY?: string }).RESEND_API_KEY = 'test-key';
}

export function disableResend(): void {
  delete (env as { RESEND_API_KEY?: string }).RESEND_API_KEY;
}

/** Write app_settings rows directly, for tests that need a particular mail policy. */
export async function setSettings(pairs: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(pairs)) {
    await env.DB.prepare(
      `INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)
       ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value`
    ).bind(key, value).run();
  }
}

export interface SeededUser {
  id: string;
  email: string;
  password: string;
  role: string;
  cookie: string;
}

/** Create an active user and return a cookie header for them. */
export async function seedUser(opts: {
  email: string;
  role: 'coach' | 'sport_admin' | 'cfo' | 'super_admin';
  password?: string;
  name?: string;
  status?: string;
  mustChangePassword?: number;
  sportIds?: string[];
}): Promise<SeededUser> {
  const id = crypto.randomUUID();
  const password = opts.password ?? 'test-password-123';
  const name = opts.name ?? opts.email.split('@')[0];

  await env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, name, role, status, must_change_password, token_version)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id, opts.email.toLowerCase(), await hashPassword(password), name, opts.role,
    opts.status ?? 'active', opts.mustChangePassword ?? 0,
  ).run();

  for (const sportId of opts.sportIds ?? []) {
    await env.DB.prepare(
      'INSERT INTO sport_admin_assignments (id, admin_user_id, sport_id) VALUES (?, ?, ?)'
    ).bind(crypto.randomUUID(), id, sportId).run();
  }

  return { id, email: opts.email.toLowerCase(), password, role: opts.role, cookie: await cookieFor({
    sub: id, email: opts.email.toLowerCase(), name, role: opts.role, tv: 0,
  }) };
}

/** Build an auth cookie header for a payload, filling in sane iat/exp. */
export async function cookieFor(partial: Partial<JWTPayload> & { sub: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    email: 'someone@example.edu',
    name: 'Someone',
    role: 'coach',
    tv: 0,
    iat: now,
    exp: now + 3600,
    ...partial,
  } as JWTPayload, env.JWT_SECRET);
  return `auth_token=${token}`;
}

/** A cookie for the anonymous one-click Coach session. */
export async function anonymousCoachCookie(): Promise<string> {
  return cookieFor({
    sub: `coach_anonymous_${crypto.randomUUID()}`,
    email: 'anonymous@coaches.utoledo.edu',
    name: 'Coach',
    role: 'coach',
  });
}

/**
 * Issue a request against the Worker and settle its deferred work before returning.
 *
 * Notification fan-out runs under ctx.waitUntil, so without draining it here the sends
 * would still be writing to the database after the test finished, which the isolated
 * storage checker flags. Draining also makes email_log assertions deterministic.
 */
export async function call(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const { cookie, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('Content-Type', 'application/json');
  if (cookie) headers.set('Cookie', cookie);

  const deferred: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { deferred.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  const res = await worker.fetch(
    new Request(`https://portal.example.test${path}`, { ...rest, headers }),
    env,
    ctx,
  );
  await Promise.allSettled(deferred);
  return res;
}

/** Run the scheduled handler (expiry sweep, then reminders). */
export async function runScheduled(): Promise<void> {
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  await worker.scheduled!({} as ScheduledEvent, env, ctx);
}

/** Create a request row directly, bypassing the submit endpoint. */
export async function seedRequest(opts: {
  sport?: string;
  term?: string;
  status?: string;
  rocketNumber?: string;
  studentName?: string;
  createdAt?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(`
    INSERT INTO insurance_requests
      (id, student_name, rocket_number, student_email, sport, term, premium_cost,
       funding_source, status, coach_email, coach_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'operating_budget', ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).bind(
    id,
    opts.studentName ?? 'Test Athlete',
    opts.rocketNumber ?? `R${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    'athlete@rockets.utoledo.edu',
    opts.sport ?? 'womens_soccer',
    opts.term ?? 'Fall 2099',
    898,
    opts.status ?? 'PENDING_COACH',
    'coach@example.edu',
    'Test Coach',
    opts.createdAt ?? null,
  ).run();
  return id;
}

/** Record a signature so approval-state assertions have something to read. */
export async function seedSignature(requestId: string, role: 'COACH' | 'SPORT_ADMIN' | 'CFO'): Promise<void> {
  await env.DB.prepare(`
    INSERT INTO signatures (id, request_id, signatory_role, signatory_email, signatory_name, ip_address)
    VALUES (?, ?, ?, ?, ?, '127.0.0.1')
  `).bind(crypto.randomUUID(), requestId, role, `${role.toLowerCase()}@example.edu`, role).run();
}
