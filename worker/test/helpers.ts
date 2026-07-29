import { env } from 'cloudflare:test';
import worker from '../src/index';
import { hashPassword, signJWT, type JWTPayload } from '../src/lib/auth';

// Per-test tables. The lookup tables seeded by migration 0002 (sports_programs,
// sport_administrators, coaches) are left in place and only their mutable columns are
// restored, so every test starts from the same seed without re-running migrations.
const PER_TEST_TABLES = [
  'email_log', 'password_reset_tokens', 'app_settings', 'audit_log',
  'signatures', 'insurance_requests', 'sport_admin_assignments', 'users',
];

/** Clear per-test state and restore anything a test may have changed on the seed rows. */
export async function resetDatabase(): Promise<void> {
  for (const table of PER_TEST_TABLES) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare(
    `UPDATE sports_programs
     SET single_approval = CASE
       WHEN id = 'womens_softball'
         OR sport_admin_id IN (SELECT id FROM sport_administrators WHERE is_cfo = 1)
       THEN 1 ELSE 0 END,
       budget_cap = NULL`
  ).run();
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
