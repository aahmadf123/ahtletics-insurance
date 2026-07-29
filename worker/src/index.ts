import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  hashPassword, verifyPassword, signJWT, getUser, setAuthCookie, clearAuthCookie,
  sha256Hex, type JWTPayload,
} from './lib/auth';
import {
  notifyPendingSportAdmin, notifyPendingCFO, notifyExecuted, notifyVoided, notifyReminder,
  notifyCoachSubmitted, notifyStudentSubmitted, notifyPendingHeadCoach, notifyDenied,
  notifyExpired, notifyPasswordReset, notifyRegistrationDecision, notifyAccountCreated,
  buildApprovalIcs, bytesToBase64, type EmailData, type EmailAttachment,
} from './lib/email';
import {
  validateRocketNumber, isBeforeDeadline, getPremiumForTerm, getSubmissionDeadline,
  getSubmissionDeadlineISO, newUUID,
} from './lib/validation';
import { buildInsuranceFormPdf, type PdfFormData } from './lib/pdf';

// ── Env bindings ──────────────────────────────────────────────────────────────

export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  CFO_EMAIL: string;
  FROM_NAME?: string;
  FROM_EMAIL: string;
  /** Monitored mailbox recipients can actually reply to. Absent = no Reply-To header. */
  REPLY_TO_EMAIL?: string;
  APP_BASE_URL: string;
  RESEND_API_KEY?: string;
  ASSETS: Fetcher;
}

const TOKEN_EXPIRATION_SECONDS = 60 * 60; // password-reset link lifetime: 1 hour
const SESSION_SECONDS = 60 * 60 * 24 * 7; // auth cookie lifetime: 7 days

// Per-account login backoff. The IP limiter below is per-isolate and in-memory, so
// it resets whenever the isolate recycles; this counter lives in D1 and does not.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MINUTES = 15;

// Anonymous one-click Coach sessions have no `users` row by design, so they are
// exempt from the database re-check in currentUser().
const ANON_COACH_PREFIX = 'coach_anonymous_';

const app = new Hono<{ Bindings: Env }>();

// ── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = new Set([
  'https://ahtletics-insurance.firas-azfar.workers.dev',
  'https://utrockets-insurance.com',
  'https://www.utrockets-insurance.com',
]);

app.use('*', cors({
  origin: origin =>
    !origin ||
    origin.startsWith('http://localhost') ||
    ALLOWED_ORIGINS.has(origin)
      ? origin : null,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// ── Rate limiting (3.5) ───────────────────────────────────────────────────────
// Best-effort, in-memory, per-isolate limiter for tokenised approval/auth URLs so
// they can't be cheaply enumerated. Over the limit → 429 with a Retry-After header.
// (For globally-consistent limits, swap this for a Cloudflare `ratelimit` binding.)
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function rateLimit(limit: number, windowSec: number) {
  return async (c: { req: { header: (k: string) => string | undefined; url: string } }, next: () => Promise<void>) => {
    const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
    const route = new URL(c.req.url).pathname.replace(/\/[0-9a-fA-F-]{8,}/g, '/:id');
    const key = `${ip}:${route}`;
    const now = Date.now();
    if (rateBuckets.size > 5000) {
      for (const [k, v] of rateBuckets) if (v.resetAt < now) rateBuckets.delete(k);
    }
    let b = rateBuckets.get(key);
    if (!b || b.resetAt < now) { b = { count: 0, resetAt: now + windowSec * 1000 }; rateBuckets.set(key, b); }
    b.count++;
    if (b.count > limit) {
      const retry = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
      return new Response(JSON.stringify({ error: 'Too many requests. Please slow down and try again shortly.' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': String(retry) },
      });
    }
    return next();
  };
}

// Apply to the sensitive, tokenised endpoints (registered before their handlers).
app.use('/api/requests/:id/sign', rateLimit(10, 60));
app.use('/api/requests/:id/void', rateLimit(10, 60));
app.use('/api/requests/:id/deny', rateLimit(10, 60));
app.use('/api/requests/:id/resubmit', rateLimit(10, 60));
app.use('/auth/login', rateLimit(15, 60));
app.use('/auth/forgot-password', rateLimit(5, 60));
app.use('/auth/reset-password', rateLimit(10, 60));
app.use('/auth/select', rateLimit(20, 60));
app.use('/auth/register', rateLimit(5, 60));

// ── Auth helpers ──────────────────────────────────────────────────────────────

type AuthedContext = { req: { raw: Request }; env: Env };

/** A verified session plus the account state the token cannot be trusted to carry. */
type SessionUser = JWTPayload & { mustChangePassword: number };

/**
 * Resolve the caller from the auth cookie, then re-validate against the database.
 *
 * A JWT alone is not enough: the cookie lives for 7 days, so a token issued before
 * an account was deleted, rejected, or had its password reset would otherwise keep
 * working for the rest of that week. Every request re-reads the user row and checks
 * that the account still exists, is still active, and that the token's `tv` still
 * matches `users.token_version`. Role, name, and email come from the row rather than
 * the token, so a role change takes effect immediately.
 *
 * Anonymous Coach sessions (issued by POST /auth/select) have no user row and are
 * returned as-is.
 */
async function currentUser(c: AuthedContext): Promise<SessionUser | null> {
  const payload = await getUser(c.req.raw, c.env.JWT_SECRET);
  if (!payload) return null;
  if (payload.sub.startsWith(ANON_COACH_PREFIX)) return { ...payload, mustChangePassword: 0 };

  const row = await c.env.DB.prepare(
    'SELECT email, name, role, sport_id, status, token_version, must_change_password FROM users WHERE id = ?'
  ).bind(payload.sub).first<{
    email: string; name: string; role: string;
    sport_id: string | null; status: string | null; token_version: number | null;
    must_change_password: number | null;
  }>();

  if (!row) return null;                                              // account deleted
  if ((row.status ?? 'active') !== 'active') return null;             // pending / rejected
  if ((row.token_version ?? 0) !== (payload.tv ?? 0)) return null;    // session revoked

  return {
    ...payload,
    email: row.email,
    name: row.name,
    role: row.role as JWTPayload['role'],
    sportId: row.sport_id ?? undefined,
    mustChangePassword: row.must_change_password ?? 0,
  };
}

/**
 * Block everything except changing the password while a temporary one is still in place.
 *
 * The SPA redirects to /change-password, but a redirect only constrains the SPA. An
 * account created by an administrator gets a fully privileged session cookie at login,
 * and the administrator knows that temporary password, so without a server-side check
 * either party can drive the API directly and never replace it. The allowed routes are
 * the ones needed to see who you are, change the password, and sign out.
 */
// Scoped to /api/* deliberately. Static assets and the SPA shell must keep loading so
// the user can reach the change-password screen, and nothing under /auth/* is exploitable
// with a temporary password: /auth/me, /auth/password, and /auth/logout are exactly what
// the flow needs, and the rest are public endpoints that ignore the caller's session.
app.use('/api/*', async (c, next) => {
  const user = await currentUser(c);
  if (user?.mustChangePassword) {
    return err('You must set a new password before using the portal.', 403);
  }
  return next();
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(message: string, status = 400) {
  return json({ error: message }, status);
}

const STATUS_LABELS: Record<string, string> = {
  PENDING_COACH: 'Pending Head Coach',
  PENDING_APPROVAL: 'Pending Approval',
  EXECUTED: 'Executed',
  VOIDED: 'Voided',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
};
const prettyStatus = (s: string) => STATUS_LABELS[s] ?? s.replace(/_/g, ' ');

// Make a value safe for a download filename / Content-Disposition (e.g. "Spring/Summer" → "Spring-Summer").
const safeFilePart = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const isSecure = (req: Request) =>
  new URL(req.url).protocol === 'https:';

const DEFAULT_FROM_NAME = 'Athletics Business Office';
type PortalSettings = { fromName: string; fromEmail: string; appBaseUrl: string; replyTo: string };

async function getPortalSettings(env: Env): Promise<PortalSettings> {
  const defaults: PortalSettings = {
    fromName: env.FROM_NAME?.trim() || DEFAULT_FROM_NAME,
    fromEmail: env.FROM_EMAIL,
    appBaseUrl: env.APP_BASE_URL,
    replyTo: env.REPLY_TO_EMAIL?.trim() || '',
  };

  try {
    const { results } = await env.DB.prepare(
      `SELECT setting_key, setting_value FROM app_settings
       WHERE setting_key IN ('from_name', 'from_email', 'app_base_url', 'reply_to')`
    ).all<{ setting_key: string; setting_value: string }>();
    const map = new Map(results.map(r => [r.setting_key, r.setting_value]));
    return {
      fromName: (map.get('from_name') || defaults.fromName).trim() || defaults.fromName,
      fromEmail: (map.get('from_email') || defaults.fromEmail).trim() || defaults.fromEmail,
      appBaseUrl: (map.get('app_base_url') || defaults.appBaseUrl).trim() || defaults.appBaseUrl,
      replyTo: (map.get('reply_to') || defaults.replyTo).trim(),
    };
  } catch {
    // If settings storage is unavailable, safely fall back to env vars.
    return defaults;
  }
}

async function getConfiguredEnv(env: Env): Promise<Env> {
  const settings = await getPortalSettings(env);
  return {
    ...env,
    FROM_NAME: settings.fromName,
    FROM_EMAIL: settings.fromEmail,
    APP_BASE_URL: settings.appBaseUrl,
    REPLY_TO_EMAIL: settings.replyTo,
  };
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
/** Upper bound on the on-screen financial report. The CSV export is unbounded. */
const REPORT_ROW_CAP = 5000;

/**
 * Bounded limit/offset for list endpoints.
 *
 * These queries had no LIMIT, so a full season across sixteen sports came back as one
 * response and rendered as one table. The cap applies even when the caller sends no
 * paging parameters at all.
 */
function pageParams(c: { req: { query: () => Record<string, string> } }): { limit: number; offset: number } {
  const q = c.req.query();
  const rawLimit = parseInt(q.limit ?? '', 10);
  const rawOffset = parseInt(q.offset ?? '', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

const EMAIL_SIMPLE_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ── Approval helpers (parallel approval model) ───────────────────────────────

const FUNDING_SOURCES = ['operating_budget', 'foundation_account'] as const;

/**
 * Whether a sport finalizes on the CFO signature alone.
 *
 * Softball's sport administrator is the CFO, so a second signature would be the same
 * person twice. This used to be a hardcoded `sport === 'womens_softball'` check, which
 * broke silently if the sport was renamed or recreated from the admin UI. It is now a
 * column on sports_programs that the Sports and Coaches page maintains.
 */
async function isSingleApproval(env: Env, sportId: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT single_approval FROM sports_programs WHERE id = ?')
    .bind(sportId).first<{ single_approval: number | null }>();
  return !!row?.single_approval;
}

/**
 * Recompute a sport's single_approval flag from its current administrator.
 *
 * The flag means "this sport's administrator is the CFO, so one CFO signature is the
 * whole approval". Backfilling it once in the migration is not enough, because the
 * Sports admin UI can create a sport or reassign sport_admin_id afterwards. Left
 * unmaintained it drifts both ways: assigning the CFO to another sport would leave the
 * flag at 0 and stall the workflow waiting for a second signature from the same person,
 * and moving softball to a different administrator would leave it at 1 and let the CFO
 * execute alone. Called from both write paths, mirroring syncHeadCoachColumns.
 */
async function syncSingleApproval(env: Env, sportId: string): Promise<void> {
  await env.DB.prepare(`
    UPDATE sports_programs
    SET single_approval = CASE
      WHEN sport_admin_id IS NOT NULL
       AND sport_admin_id IN (SELECT id FROM sport_administrators WHERE is_cfo = 1)
      THEN 1 ELSE 0 END
    WHERE id = ?
  `).bind(sportId).run();
}

const clientIp = (c: { req: { header: (k: string) => string | undefined } }) =>
  c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';

/** Write an audit-log row capturing the actor and originating IP (3.3). */
async function audit(
  env: Env, requestId: string | null, action: string, performedBy: string,
  details: Record<string, unknown> | null, ip?: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, request_id, action, performed_by, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(newUUID(), requestId, action, performedBy, details ? JSON.stringify(details) : null, ip ?? null).run();
}

/** True once all required approvals (Sport Admin + CFO, or just CFO for softball) exist. */
async function hasAllApprovals(env: Env, id: string, sport: string): Promise<boolean> {
  const { results } = await env.DB.prepare(
    `SELECT signatory_role FROM signatures WHERE request_id = ? AND signatory_role IN ('SPORT_ADMIN', 'CFO')`
  ).bind(id).all<{ signatory_role: string }>();
  const roles = new Set(results.map(r => r.signatory_role));
  if (await isSingleApproval(env, sport)) return roles.has('CFO');
  return roles.has('SPORT_ADMIN') && roles.has('CFO');
}

/** Every active CFO account's email, so notifications are not pinned to an env var. */
async function getCfoEmails(env: Env): Promise<string[]> {
  try {
    const { results } = await env.DB.prepare(
      `SELECT email FROM users WHERE role = 'cfo' AND status = 'active'
       UNION
       SELECT email FROM sport_administrators WHERE is_cfo = 1`
    ).all<{ email: string }>();
    const list = [...new Set(results.map(r => r.email).filter(Boolean))];
    return list.length ? list : [env.CFO_EMAIL].filter(Boolean);
  } catch {
    return [env.CFO_EMAIL].filter(Boolean);
  }
}

/**
 * Whether a delegation is still active. A date-only expiry (YYYY-MM-DD from the date
 * picker) is treated as inclusive of that whole day, so a delegation set to expire on
 * the last day of travel still routes to the delegate on that day (review feedback).
 */
function isDelegationActive(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
    ? Date.parse(`${expiresAt}T00:00:00Z`) + 24 * 60 * 60 * 1000 // through end of that UTC day
    : Date.parse(expiresAt);
  return !isNaN(ms) && ms > Date.now();
}

/**
 * Resolve the Step-1 approver for a sport: the head coach from the coaches table,
 * honouring an active (non-expired) out-of-office delegation (1.1 / 1.8). Falls
 * back to the head coach name/email stored on sports_programs.
 */
async function getHeadCoachForSport(
  env: Env, sportId: string,
): Promise<{ name: string; email: string } | null> {
  const hc = await env.DB.prepare(
    `SELECT display_name, email, delegated_approver_email, delegation_expires_at
     FROM coaches WHERE sport_id = ? AND is_head_coach = 1 LIMIT 1`
  ).bind(sportId).first<{
    display_name: string; email: string;
    delegated_approver_email: string | null; delegation_expires_at: string | null;
  }>();
  if (hc) {
    if (hc.delegated_approver_email && isDelegationActive(hc.delegation_expires_at)) {
      return { name: hc.display_name, email: hc.delegated_approver_email };
    }
    if (hc.email) return { name: hc.display_name, email: hc.email };
  }
  const sp = await env.DB.prepare(
    'SELECT head_coach, head_coach_email FROM sports_programs WHERE id = ?'
  ).bind(sportId).first<{ head_coach: string | null; head_coach_email: string | null }>();
  if (sp?.head_coach_email) return { name: sp.head_coach ?? 'Head Coach', email: sp.head_coach_email };
  return null;
}

/**
 * Every sport-admin email that should be notified for a sport: the legacy
 * sport_administrators lookup PLUS every sport_admin user assigned via
 * sport_admin_assignments (1.3, fan-out — not a single column).
 */
async function getSportAdminEmailsForSport(env: Env, sportId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(`
    SELECT sa.email AS email
    FROM sports_programs sp JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE sp.id = ?
    UNION
    SELECT u.email AS email
    FROM sport_admin_assignments saa JOIN users u ON saa.admin_user_id = u.id
    WHERE saa.sport_id = ? AND u.status = 'active'
  `).bind(sportId, sportId).all<{ email: string }>();
  return [...new Set(results.map(r => r.email).filter(Boolean))];
}

/** The set of sport ids a sport-admin user is scoped to (assignments, else legacy sport_id). */
async function sportAdminScopeIds(env: Env, user: { sub: string; sportId?: string }): Promise<string[]> {
  const { results } = await env.DB.prepare(
    'SELECT sport_id FROM sport_admin_assignments WHERE admin_user_id = ?'
  ).bind(user.sub).all<{ sport_id: string }>();
  const ids = results.map(r => r.sport_id);
  if (ids.length) return ids;
  return user.sportId ? [user.sportId] : [];
}

async function sportAdminScopeIncludes(
  env: Env, user: { sub: string; sportId?: string }, sportId: string,
): Promise<boolean> {
  const ids = await sportAdminScopeIds(env, user);
  return ids.includes(sportId);
}

/** Replace a sport-admin user's sport assignments with the given set (4.6). */
async function setSportAdminAssignments(env: Env, adminUserId: string, sportIds: string[]): Promise<void> {
  await env.DB.prepare('DELETE FROM sport_admin_assignments WHERE admin_user_id = ?').bind(adminUserId).run();
  const unique = [...new Set(sportIds.filter(Boolean))];
  for (const sportId of unique) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO sport_admin_assignments (id, admin_user_id, sport_id) VALUES (?, ?, ?)'
    ).bind(newUUID(), adminUserId, sportId).run();
  }
}

/** Build the notification payload (head coach + all sport admins) for a request. */
async function loadRequestEmailData(env: Env, id: string): Promise<EmailData | null> {
  const r = await env.DB.prepare(`
    SELECT ir.student_name, ir.rocket_number, ir.student_email, ir.sport, sp.name as sportName,
           ir.term, ir.premium_cost, ir.funding_source, ir.coach_name, ir.coach_email,
           ir.denial_reason,
           sa.email as sportAdminEmail, sa.name as sportAdminName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();
  if (!r) return null;
  const sportId = r.sport as string;
  const headCoach = await getHeadCoachForSport(env, sportId);
  const sportAdminEmails = await getSportAdminEmailsForSport(env, sportId);
  const cfoEmails = await getCfoEmails(env);
  return {
    cfoEmails,
    studentName: r.student_name as string,
    rocketNumber: r.rocket_number as string,
    studentEmail: (r.student_email as string) || undefined,
    sport: sportId,
    sportName: (r.sportName as string) ?? sportId,
    term: r.term as string,
    premiumCost: r.premium_cost as number,
    fundingSource: (r.funding_source as string) || 'operating_budget',
    coachName: r.coach_name as string,
    coachEmail: (r.coach_email as string) || '',
    requestId: id,
    status: '',
    sportAdminName: (r.sportAdminName as string) ?? undefined,
    sportAdminEmail: (r.sportAdminEmail as string) ?? undefined,
    sportAdminEmails,
    headCoachName: headCoach?.name,
    headCoachEmail: headCoach?.email,
    denialReason: (r.denial_reason as string) || undefined,
    submissionDeadline: getSubmissionDeadline(r.term as string),
    submissionDeadlineISO: getSubmissionDeadlineISO(r.term as string),
  };
}

/** Assemble the signed authorization PDF for a request. */
async function loadPdfFormData(env: Env, id: string): Promise<PdfFormData | null> {
  const req = await env.DB.prepare(`
    SELECT ir.id, ir.status,
           ir.rocket_number as rocketNumber, ir.student_name as studentName, ir.sport,
           ir.term, ir.premium_cost as premiumCost, ir.funding_source as fundingSource,
           ir.coach_name as coachName, ir.coach_email as coachEmail, sp.name as sportName
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE ir.id = ?
  `).bind(id).first<{
    id: string; status: string;
    rocketNumber: string; studentName: string; sport: string; term: string;
    premiumCost: number; fundingSource: string; coachName: string; coachEmail: string; sportName: string | null;
  }>();
  if (!req) return null;
  const { results: sigs } = await env.DB.prepare(`
    SELECT signatory_role as role, signatory_name as name, timestamp
    FROM signatures WHERE request_id = ? ORDER BY timestamp ASC
  `).bind(id).all<{ role: string; name: string; timestamp: string }>();
  return {
    requestId: req.id,
    status: req.status,
    studentName: req.studentName,
    rocketNumber: req.rocketNumber,
    sport: req.sportName ?? req.sport,
    term: req.term,
    premiumCost: `$${req.premiumCost.toFixed(2)}`,
    fundingSource: req.fundingSource,
    coachName: req.coachName,
    coachEmail: req.coachEmail ?? '',
    submissionDeadline: getSubmissionDeadline(req.term),
    signatures: sigs.map(s => ({
      role: s.role as 'COACH' | 'SPORT_ADMIN' | 'CFO',
      name: s.name,
      date: new Date(s.timestamp).toLocaleDateString('en-US'),
    })),
  };
}

/** Fetch the white-on-transparent rocket logo from the ASSETS binding for embedding in PDFs. */
async function loadLogoPng(env: Env): Promise<Uint8Array | undefined> {
  try {
    const origin = env.APP_BASE_URL.replace(/\/$/, '');
    const res = await env.ASSETS.fetch(new Request(`${origin}/logo-dark.png`));
    if (!res.ok) return undefined;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Build the base64 PDF email attachment for a completed request (1.6). */
async function buildRequestPdfAttachment(env: Env, id: string): Promise<EmailAttachment | undefined> {
  const data = await loadPdfFormData(env, id);
  if (!data) return undefined;
  try {
    const logo  = await loadLogoPng(env);
    const bytes = await buildInsuranceFormPdf(data, logo);
    return {
      filename: `insurance-request-${safeFilePart(data.rocketNumber)}-${safeFilePart(data.term)}.pdf`,
      content: bytesToBase64(bytes),
    };
  } catch (e) {
    console.warn(`[pdf] attachment build failed: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

// ── Deferred notification ─────────────────────────────────────────────────────

type NotifyContext = { env: Env; executionCtx: ExecutionContext };

/**
 * Run notification fan-out after the response has been returned.
 *
 * Sends used to be awaited inline. A 50-athlete bulk submit therefore issued roughly
 * 150 sequential provider calls plus their D1 writes inside a single Worker
 * invocation, which exhausts the subrequest budget and times out. waitUntil keeps the
 * work attached to the same invocation without making the caller wait for it, and a
 * failure in here can no longer fail the approval action that triggered it.
 */
function deferNotify(c: NotifyContext, run: (mailEnv: Env) => Promise<void>): void {
  const task = (async () => {
    try {
      await run(await getConfiguredEnv(c.env));
    } catch (e) {
      console.warn(`[notify] deferred send failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  })();
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context (unit tests, direct app.fetch calls): let it run detached.
    void task;
  }
}

/** Load a request's email payload, stamp the new status, then send, all deferred. */
function deferRequestNotify(
  c: NotifyContext, id: string, status: string,
  run: (mailEnv: Env, d: EmailData) => Promise<void>,
): void {
  deferNotify(c, async mailEnv => {
    const d = await loadRequestEmailData(c.env, id);
    if (!d) return;
    d.status = status;
    await run(mailEnv, d);
  });
}

/** On submission: confirm to coach + student and ask the head coach to approve (Step 1). */
async function notifyOnCreate(env: Env, d: EmailData, headCoachEmail?: string): Promise<void> {
  await notifyCoachSubmitted(env, d);
  await notifyStudentSubmitted(env, d);
  if (headCoachEmail) await notifyPendingHeadCoach(env, d, headCoachEmail);
}

/** After the head coach approves: ask the Sport Admin(s) and CFO to act (Step 2). */
async function notifyApprovers(env: Env, d: EmailData): Promise<void> {
  if (!(await isSingleApproval(env, d.sport)) && d.sportAdminEmails?.length) {
    await notifyPendingSportAdmin(env, d, d.sportAdminEmails);
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
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT(
    {
      sub: id, email: email.toLowerCase(), name,
      role: role as 'coach' | 'sport_admin' | 'cfo' | 'super_admin',
      tv: 0, iat: now, exp: now + SESSION_SECONDS,
    },
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
  const { email, password } = await c.req.json<{ email: string; password: string }>()
    .catch(() => ({ email: '', password: '' }));
  if (!email || !password) return err('Email and password required');

  const user = await c.env.DB.prepare(
    `SELECT id, email, password_hash, name, role, sport_id, must_change_password, status,
            token_version, failed_login_count, locked_until
     FROM users WHERE email = ?`
  ).bind(email.toLowerCase().trim()).first<{
    id: string; email: string; password_hash: string; name: string; role: string;
    sport_id: string | null; must_change_password: number; status: string | null;
    token_version: number | null; failed_login_count: number | null; locked_until: string | null;
  }>();

  // Uniform failure message so the endpoint cannot be used to enumerate accounts.
  const invalid = () => err('Invalid email or password', 401);
  if (!user) return invalid();

  if (user.locked_until && Date.parse(user.locked_until) > Date.now()) {
    const mins = Math.max(1, Math.ceil((Date.parse(user.locked_until) - Date.now()) / 60000));
    return err(`Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  }

  if (!(await verifyPassword(password, user.password_hash))) {
    const attempts = (user.failed_login_count ?? 0) + 1;
    const lockUntil = attempts >= MAX_FAILED_LOGINS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null;
    await c.env.DB.prepare(
      'UPDATE users SET failed_login_count = ?, locked_until = ? WHERE id = ?'
    ).bind(lockUntil ? 0 : attempts, lockUntil, user.id).run();
    return invalid();
  }

  const userStatus = user.status ?? 'active';
  if (userStatus === 'pending') {
    return err('Your account is pending approval. A Super Admin will review it shortly.', 403);
  }
  if (userStatus === 'rejected') {
    return err('Your account request has been rejected.', 403);
  }

  if (user.failed_login_count || user.locked_until) {
    await c.env.DB.prepare(
      'UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?'
    ).bind(user.id).run();
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role as 'coach' | 'sport_admin' | 'cfo' | 'super_admin',
    sportId: user.sport_id ?? undefined,
    tv: user.token_version ?? 0,
    iat: now,
    exp: now + SESSION_SECONDS,
  }, c.env.JWT_SECRET);

  return new Response(JSON.stringify({
    id: user.id, email: user.email, name: user.name, role: user.role,
    sportId: user.sport_id, mustChangePassword: user.must_change_password,
    status: userStatus,
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
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  const { currentPassword, newPassword } = await c.req.json<{ currentPassword: string; newPassword: string }>();
  if (!currentPassword || !newPassword) return err('Missing fields');
  if (newPassword.length < 8) return err('Password must be at least 8 characters');
  if (currentPassword === newPassword) return err('New password must differ from the current one');

  const dbUser = await c.env.DB.prepare(
    'SELECT password_hash, token_version FROM users WHERE id = ?'
  ).bind(user.sub).first<{ password_hash: string; token_version: number | null }>();
  if (!dbUser || !(await verifyPassword(currentPassword, dbUser.password_hash))) {
    return err('Current password is incorrect', 401);
  }

  // Bumping token_version revokes every cookie already issued for this account, so a
  // stolen session does not survive a password change. Any outstanding reset links are
  // dropped for the same reason.
  const newTv = (dbUser.token_version ?? 0) + 1;
  const newHash = await hashPassword(newPassword);
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ? WHERE id = ?'
    ).bind(newHash, newTv, user.sub),
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(user.sub),
  ]);

  // Re-issue this caller's own cookie at the new version so they stay signed in.
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT(
    { ...user, tv: newTv, iat: now, exp: now + SESSION_SECONDS },
    c.env.JWT_SECRET,
  );
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setAuthCookie(token, isSecure(c.req.raw)),
    },
  });
});

// POST /auth/forgot-password — send a password reset email
app.post('/auth/forgot-password', async c => {
  const { email } = await c.req.json<{ email: string }>().catch(() => ({ email: '' }));
  if (!email?.trim()) return err('Email is required');
  const address = email.toLowerCase().trim();

  const dbUser = await c.env.DB.prepare(
    'SELECT id, name FROM users WHERE email = ? AND status = ?'
  ).bind(address, 'active').first<{ id: string; name: string }>();

  if (dbUser) {
    // The token is emailed in the clear but only its SHA-256 digest is stored, so a
    // database read cannot be turned into a working reset link.
    const token = `${newUUID()}${newUUID()}`.replace(/-/g, '');
    const expiresAt = Math.floor(Date.now() / 1000) + TOKEN_EXPIRATION_SECONDS;

    await c.env.DB.batch([
      // One live link at a time: requesting a new one retires the previous.
      c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(dbUser.id),
      c.env.DB.prepare(
        'INSERT INTO password_reset_tokens (token_hash, user_id, expires_at, used) VALUES (?, ?, ?, 0)'
      ).bind(await sha256Hex(token), dbUser.id, expiresAt),
    ]);

    deferNotify(c, mailEnv => notifyPasswordReset(mailEnv, address, dbUser.name, token));
  }

  // Always the same response, whether or not the account exists.
  return json({ message: 'If an account with that email exists, a reset link has been sent.' });
});

// POST /auth/reset-password — reset password with token
app.post('/auth/reset-password', async c => {
  const { token, newPassword } = await c.req.json<{ token: string; newPassword: string }>()
    .catch(() => ({ token: '', newPassword: '' }));
  if (!token || !newPassword) return err('Missing required fields');
  if (newPassword.length < 8) return err('Password must be at least 8 characters');

  const resetToken = await c.env.DB.prepare(
    'SELECT user_id, expires_at, used FROM password_reset_tokens WHERE token_hash = ?'
  ).bind(await sha256Hex(token)).first<{ user_id: string; expires_at: number; used: number }>();

  if (!resetToken) return err('Invalid or expired reset link', 400);
  if (resetToken.used) return err('This reset link has already been used', 400);
  if (Math.floor(Date.now() / 1000) > resetToken.expires_at) return err('This reset link has expired', 400);

  const target = await c.env.DB.prepare('SELECT token_version FROM users WHERE id = ?')
    .bind(resetToken.user_id).first<{ token_version: number | null }>();
  if (!target) return err('Invalid or expired reset link', 400);

  const newHash = await hashPassword(newPassword);
  // Bump token_version so any session opened with the old password stops working, and
  // clear every other outstanding link for this account.
  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ?, failed_login_count = 0, locked_until = NULL WHERE id = ?'
    ).bind(newHash, (target.token_version ?? 0) + 1, resetToken.user_id),
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(resetToken.user_id),
  ]);

  // The caller may be holding a now-revoked cookie; clear it so they land on login.
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': clearAuthCookie() },
  });
});

// GET /auth/me
// Returns live values from the database (see currentUser), not the token's snapshot,
// so a role change or a pending forced password change is visible immediately.
app.get('/auth/me', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);

  let mustChangePassword = 0;
  if (!user.sub.startsWith(ANON_COACH_PREFIX)) {
    const row = await c.env.DB.prepare('SELECT must_change_password FROM users WHERE id = ?')
      .bind(user.sub).first<{ must_change_password: number | null }>();
    mustChangePassword = row?.must_change_password ?? 0;
  }

  return json({
    id: user.sub, email: user.email, name: user.name, role: user.role,
    sportId: user.sportId, mustChangePassword,
  });
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

  const now = Math.floor(Date.now() / 1000);
  const sub = `${ANON_COACH_PREFIX}${newUUID()}`;
  const payload = {
    sub,
    email,
    name,
    role: 'coach' as const,
    sportId: undefined,
    iat: now,
    exp: now + SESSION_SECONDS,
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
  const { email, password, name, role, sportIds } = await c.req.json<{
    email: string; password: string; name: string; role: string; sportIds?: string[];
  }>();

  if (!email || !password || !name || !role) return err('Missing required fields');
  if (!['sport_admin', 'cfo'].includes(role)) return err('Only Sport Admin and CFO roles can self-register');
  if (password.length < 8) return err('Password must be at least 8 characters');
  // Sport Admins must pick at least one sport to manage (4.6).
  if (role === 'sport_admin' && !(sportIds?.length)) return err('Select at least one sport you administer');

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase()).first();
  if (exists) return err('Email already in use', 409);

  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, status) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, 'pending').run();

  await setSportAdminAssignments(c.env, id, role === 'sport_admin' ? (sportIds ?? []) : []);

  return json({ message: 'Your account request has been submitted. A Super Admin will review and approve it.' }, 201);
});

// ── Sports ────────────────────────────────────────────────────────────────────

app.get('/api/sports', async c => {
  const { results } = await c.env.DB.prepare(`
    SELECT sp.id, sp.name, sp.gender, sp.head_coach as headCoach,
           sp.head_coach_email as headCoachEmail, sp.budget_cap as budgetCap,
           sp.sport_admin_id as sportAdminId,
           sa.name as sportAdminName, sa.email as sportAdminEmail,
           (SELECT COUNT(*) FROM coaches co WHERE co.sport_id = sp.id AND co.is_head_coach = 0) as staffCount
    FROM sports_programs sp
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    ORDER BY sp.name
  `).all();
  return json(results);
});

// GET /api/admin/sport-admins — list selectable sport administrators (admin only)
app.get('/api/admin/sport-admins', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  // Rows mirrored from a user account share that account's id, so they can be joined back
  // and suppressed once the account is deactivated or rejected. The original seeded
  // administrators have no matching user row and are always listed.
  const { results } = await c.env.DB.prepare(`
    SELECT sa.id, sa.name, sa.title, sa.email, sa.is_cfo as isCfo
    FROM sport_administrators sa
    LEFT JOIN users u ON u.id = sa.id
    WHERE u.id IS NULL OR u.status = 'active'
    ORDER BY sa.name
  `).all();
  return json(results);
});

// ── Requests ──────────────────────────────────────────────────────────────────

// GET /api/requests — list (filtered by role)
app.get('/api/requests', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);

  const { sport, term, status, coach } = c.req.query();
  const { limit, offset } = pageParams(c);

  let query = `
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.sport, ir.term, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.denial_reason as denialReason, ir.parent_request_id as parentRequestId,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'COACH') as headCoachSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  // Coaches see ALL requests (anonymous coach model). Sport admins are scoped to the
  // sports they are assigned to (1.3); CFO and super_admin see everything.
  if (user.role === 'sport_admin') {
    const scope = await sportAdminScopeIds(c.env, { sub: user.sub, sportId: user.sportId });
    if (scope.length === 0) return json([]);
    query += ` AND ir.sport IN (${scope.map(() => '?').join(',')})`;
    params.push(...scope);
  }

  if (sport) { query += ' AND ir.sport = ?'; params.push(sport); }
  if (term) { query += ' AND ir.term LIKE ?'; params.push(`%${term}%`); }
  if (status) { query += ' AND ir.status = ?'; params.push(status); }
  if (coach) { query += ' AND (ir.coach_name LIKE ? OR ir.coach_email LIKE ?)'; params.push(`%${coach}%`, `%${coach}%`); }

  query += ' ORDER BY ir.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const stmt = c.env.DB.prepare(query).bind(...params);
  const { results } = await stmt.all();
  return json(results);
});

// POST /api/requests — create (bulk)
app.post('/api/requests', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach') return err('Only coaches can submit requests', 403);

  const body = await c.req.json<{
    athletes: { studentName: string; rocketNumber: string; email?: string }[];
    term: string;
    sport: string;
    fundingSource?: string;
    coachEmail?: string;
    coachName?: string;
    parentRequestId?: string;
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
  const ip = clientIp(c);

  // Pull the head coach name/email the Super Admin maintains for this sport, so the
  // coach's info is pre-populated on the request and at signing time.
  const sportRow = await c.env.DB.prepare(
    'SELECT head_coach, head_coach_email FROM sports_programs WHERE id = ?'
  ).bind(sport).first<{ head_coach: string | null; head_coach_email: string | null }>();
  if (!sportRow) return err('Unknown sport', 400);

  // The submitting coach's identity is resolved from the registered coaches table on
  // the form (1.2); fall back to the sport's head coach when not provided.
  const coachEmail = (body.coachEmail?.trim() || sportRow.head_coach_email || '') || null;
  if (coachEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coachEmail)) {
    return err('Invalid coach email');
  }
  const coachName = body.coachName?.trim() || sportRow.head_coach?.trim() || '';

  const initialStatus = 'PENDING_COACH';

  // Validate the whole batch before writing anything.
  //
  // This loop used to insert as it validated, so a bad athlete part-way through left the
  // earlier ones committed with their emails already sent while the coach saw a 400.
  // Retrying then collided with the duplicate guard on the rows that did land. Nothing
  // is written until every athlete passes.
  const prepared: {
    id: string; studentName: string; rocketNumber: string; studentEmail: string | null;
  }[] = [];
  const seenInBatch = new Set<string>();

  for (const athlete of body.athletes) {
    const studentName = athlete.studentName?.trim();
    if (!studentName) return err('Student name is required');

    const rocketNumber = athlete.rocketNumber?.trim().toUpperCase() ?? '';
    if (!validateRocketNumber(rocketNumber)) {
      return err(`Invalid Rocket Number: ${athlete.rocketNumber}`);
    }

    const studentEmail = athlete.email?.trim() || null;
    if (studentEmail && !EMAIL_SIMPLE_RE.test(studentEmail)) {
      return err(`Invalid email for ${studentName}`);
    }

    // Same athlete twice in one submission would satisfy the duplicate check
    // individually and then violate the unique index at write time.
    if (seenInBatch.has(rocketNumber)) {
      return err(`${rocketNumber} appears more than once in this submission`, 409);
    }
    seenInBatch.add(rocketNumber);

    // Duplicate guard (2.1): block a second active request for the same student + term.
    const duplicate = await c.env.DB.prepare(
      `SELECT student_name, status FROM insurance_requests
       WHERE rocket_number = ? AND term = ? AND status NOT IN ('VOIDED', 'DENIED', 'EXPIRED') LIMIT 1`
    ).bind(rocketNumber, body.term).first<{ student_name: string; status: string }>();
    if (duplicate) {
      return err(`A request for ${duplicate.student_name} in ${body.term} already exists (status: ${prettyStatus(duplicate.status)})`, 409);
    }

    prepared.push({ id: newUUID(), studentName, rocketNumber, studentEmail });
  }

  const actor = coachName || user.name || 'Coach';
  const auditDetails = JSON.stringify({
    status: initialStatus, fundingSource,
    ...(body.parentRequestId ? { resubmissionOf: body.parentRequestId } : {}),
  });

  // One batch, so the whole submission lands or none of it does.
  await c.env.DB.batch(prepared.flatMap(p => [
    c.env.DB.prepare(`
      INSERT INTO insurance_requests
        (id, student_name, rocket_number, student_email, sport, term, premium_cost, funding_source, status, coach_email, coach_name, parent_request_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      p.id, p.studentName, p.rocketNumber, p.studentEmail, sport,
      body.term, premiumCost, fundingSource, initialStatus, coachEmail, coachName,
      body.parentRequestId || null,
    ),
    c.env.DB.prepare(
      `INSERT INTO audit_log (id, request_id, action, performed_by, details, ip_address)
       VALUES (?, ?, 'SUBMITTED', ?, ?, ?)`
    ).bind(newUUID(), p.id, actor, auditDetails, ip),
  ]));

  // Confirm to coach + student and route the Step-1 approval email to the head coach
  // (or active delegate) of the sport (1.1). Deferred so a large batch does not block
  // the response on dozens of sequential provider calls.
  deferNotify(c, async mailEnv => {
    const headCoach = await getHeadCoachForSport(c.env, sport);
    for (const p of prepared) {
      const d = await loadRequestEmailData(c.env, p.id);
      if (!d) continue;
      d.status = initialStatus;
      await notifyOnCreate(mailEnv, d, headCoach?.email);
    }
  });

  const created = prepared.map(p => ({
    id: p.id, studentName: p.studentName, rocketNumber: p.rocketNumber,
    studentEmail: p.studentEmail, sport, term: body.term, premiumCost, fundingSource,
    status: initialStatus, coachEmail, coachName,
  }));
  return json(created, 201);
});

// GET /api/requests/:id
app.get('/api/requests/:id', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  const { id } = c.req.param();

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.student_name as studentName, ir.rocket_number as rocketNumber,
           ir.student_email as studentEmail,
           ir.sport, ir.term, ir.premium_cost as premiumCost,
           ir.funding_source as fundingSource, ir.status,
           ir.coach_email as coachEmail, ir.coach_name as coachName,
           ir.denial_reason as denialReason, ir.parent_request_id as parentRequestId,
           ir.created_at as createdAt,
           sp.name as sportName,
           sa.name as sportAdminName, sa.email as sportAdminEmail,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'COACH') as headCoachSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.id = ?
  `).bind(id).first<Record<string, unknown>>();

  if (!req) return err('Not found', 404);

  // RBAC — coaches view all (anonymous model); sport admins are scoped to their sports (1.3).
  if (user.role === 'sport_admin' && !(await sportAdminScopeIncludes(c.env, user, req.sport as string))) {
    return err('This request is outside your assigned sports', 403);
  }

  const { results: sigs } = await c.env.DB.prepare(`
    SELECT id, request_id as requestId, signatory_role as signatoryRole,
           signatory_email as signatoryEmail, signatory_name as signatoryName, timestamp
    FROM signatures WHERE request_id = ? ORDER BY timestamp ASC
  `).bind(id).all();

  return json({ ...req, signatures: sigs });
});

// POST /api/requests/:id/sign — in-app signing for sport admin, CFO, and super_admin
app.post('/api/requests/:id/sign', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach' && user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only authorized roles can sign in-app', 403);
  }

  const { id } = c.req.param();
  const { coachName } = await c.req.json<{ coachName?: string }>().catch(() => ({ coachName: undefined }));
  const ip = clientIp(c);

  const req = await c.env.DB.prepare(`
    SELECT ir.id, ir.status, ir.sport, ir.coach_email as coachEmail
    FROM insurance_requests ir
    WHERE ir.id = ?
  `).bind(id).first<{ id: string; status: string; sport: string; coachEmail: string }>();

  if (!req) return err('Not found', 404);

  // Sport-admin scoping enforced server-side (1.3): can only act on assigned sports.
  if (user.role === 'sport_admin' && !(await sportAdminScopeIncludes(c.env, user, req.sport))) {
    return err('This request is outside your assigned sports', 403);
  }

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
    else if (!signedRoles.has('SPORT_ADMIN') && !(await isSingleApproval(c.env, req.sport))) sigRole = 'SPORT_ADMIN';
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

  // A super_admin can fill an approval that belongs to another role. That is a
  // legitimate break-glass path, but it lets one person execute a request on their own,
  // so it is recorded distinctly rather than as an ordinary signature.
  const breakGlass = user.role === 'super_admin';
  await audit(c.env, id, sigRole === 'COACH' ? 'HEAD_COACH_APPROVED' : (breakGlass ? 'SIGNED_ON_BEHALF' : 'SIGNED'),
    user.email || signatoryName, { role: sigRole, ...(breakGlass ? { onBehalfOf: sigRole } : {}) }, ip);

  // Advance status + notify
  let newStatus: string;
  if (sigRole === 'COACH') {
    newStatus = 'PENDING_APPROVAL';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, coach_name = ?, reminder_count = 0 WHERE id = ?')
      .bind(newStatus, signatoryName, id).run();
    deferRequestNotify(c, id, newStatus, notifyApprovers);
  } else {
    // Sport Admin or CFO approval — executed once all required approvals exist
    const allApproved = await hasAllApprovals(c.env, id, req.sport);
    newStatus = allApproved ? 'EXECUTED' : 'PENDING_APPROVAL';
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind(newStatus, id).run();
    if (allApproved) {
      deferRequestNotify(c, id, newStatus, async (mailEnv, d) =>
        notifyExecuted(mailEnv, d, await buildRequestPdfAttachment(c.env, id)));
    }
  }

  return json({ id, status: newStatus });
});

// GET /api/requests/:id/pdf — download completed authorization PDF
app.get('/api/requests/:id/pdf', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);

  const { id } = c.req.param();

  // Same scoping the list/detail/sign routes apply. Without this, any session could
  // fetch any student's signed authorization form by id.
  const owner = await c.env.DB.prepare('SELECT sport FROM insurance_requests WHERE id = ?')
    .bind(id).first<{ sport: string }>();
  if (!owner) return err('Not found', 404);
  if (user.role === 'sport_admin' && !(await sportAdminScopeIncludes(c.env, user, owner.sport))) {
    return err('This request is outside your assigned sports', 403);
  }

  const pdfData = await loadPdfFormData(c.env, id);
  if (!pdfData) return err('Not found', 404);
  // An unsigned form has nothing to authorize; the UI already hides the button.
  if (pdfData.signatures.length === 0) {
    return err('This request has no signatures yet', 409);
  }

  const logo     = await loadLogoPng(c.env);
  const pdfBytes = await buildInsuranceFormPdf(pdfData, logo);

  const filename = `insurance-auth-${safeFilePart(pdfData.rocketNumber)}-${safeFilePart(pdfData.term)}.pdf`;
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${filename}"`,
    },
  });
});

// GET /api/requests/:id/calendar — the approval-deadline .ics as a download.
//
// This used to ride along as an attachment on the first approval email. Calendar files
// from an unrecognised sender are a strong quarantine trigger in Exchange Online, and
// these messages are first contact from a new domain, so it is served here instead.
app.get('/api/requests/:id/calendar', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  const { id } = c.req.param();

  const d = await loadRequestEmailData(c.env, id);
  if (!d) return err('Not found', 404);
  if (user.role === 'sport_admin' && !(await sportAdminScopeIncludes(c.env, user, d.sport))) {
    return err('This request is outside your assigned sports', 403);
  }

  const ics = buildApprovalIcs(await getConfiguredEnv(c.env), d);
  if (!ics) return err('No deadline is set for this term', 404);

  return new Response(atob(ics.content), {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="insurance-deadline-${safeFilePart(d.rocketNumber)}.ics"`,
    },
  });
});

// GET /api/requests/:id/emails — delivery log for one request (CFO / Super Admin).
//
// Answers "did the head coach actually get it", which is the first question when an
// approval stalls. Delivery to utoledo.edu is unreliable and a provider success only
// means the receiving mail exchanger accepted the message.
app.get('/api/requests/:id/emails', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  const { results } = await c.env.DB.prepare(`
    SELECT id, to_email as toEmail, subject, template, provider_id as providerId,
           status, error, created_at as createdAt
    FROM email_log WHERE request_id = ? ORDER BY created_at DESC LIMIT 200
  `).bind(id).all();
  return json(results);
});

// POST /api/requests/:id/void — CFO or super_admin
app.post('/api/requests/:id/void', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') return err('Only CFO or Super Admin can void requests', 403);

  const { id } = c.req.param();
  const { reason } = await c.req.json<{ reason: string }>();
  if (!reason?.trim()) return err('Void reason is required');

  const req = await c.env.DB.prepare('SELECT status FROM insurance_requests WHERE id = ?')
    .bind(id).first<{ status: string }>();
  if (!req) return err('Not found', 404);
  if (req.status !== 'PENDING_APPROVAL' && req.status !== 'PENDING_COACH') {
    return err('Only active requests can be voided', 409);
  }

  // Capture the signed PDF before flipping status (a partially-signed form is still useful).
  const pdf = await buildRequestPdfAttachment(c.env, id);

  await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
    .bind('VOIDED', id).run();
  await audit(c.env, id, 'VOIDED', user.email, { reason: reason.trim() }, clientIp(c));

  deferRequestNotify(c, id, 'VOIDED', (mailEnv, d) => {
    d.voidReason = reason.trim();
    return notifyVoided(mailEnv, d, pdf);
  });

  return json({ id, status: 'VOIDED' });
});

// POST /api/requests/:id/deny — deny a pending request with a reason (1.4).
app.post('/api/requests/:id/deny', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (!['coach', 'sport_admin', 'cfo', 'super_admin'].includes(user.role)) {
    return err('You are not permitted to deny requests', 403);
  }

  const { id } = c.req.param();
  const { reason } = await c.req.json<{ reason: string }>().catch(() => ({ reason: '' }));
  if (!reason?.trim()) return err('A denial reason is required');

  const req = await c.env.DB.prepare('SELECT status, sport FROM insurance_requests WHERE id = ?')
    .bind(id).first<{ status: string; sport: string }>();
  if (!req) return err('Not found', 404);
  if (req.status !== 'PENDING_COACH' && req.status !== 'PENDING_APPROVAL') {
    return err('Only pending requests can be denied', 409);
  }
  if (user.role === 'sport_admin' && !(await sportAdminScopeIncludes(c.env, user, req.sport))) {
    return err('This request is outside your assigned sports', 403);
  }
  if (user.role === 'cfo' && req.status !== 'PENDING_APPROVAL') {
    return err('CFO can only deny requests that are pending approval', 409);
  }

  await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, denial_reason = ? WHERE id = ?')
    .bind('DENIED', reason.trim(), id).run();
  await audit(c.env, id, 'DENIED', user.email || user.name, { reason: reason.trim(), role: user.role }, clientIp(c));

  deferRequestNotify(c, id, 'DENIED', (mailEnv, d) => {
    d.denialReason = reason.trim();
    return notifyDenied(mailEnv, d);
  });

  return json({ id, status: 'DENIED' });
});

// POST /api/requests/:id/resubmit — clone a denied request as a fresh PENDING_COACH (1.5)
app.post('/api/requests/:id/resubmit', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach' && user.role !== 'super_admin') {
    return err('Only the coach can resubmit a denied request', 403);
  }

  const { id } = c.req.param();
  type ResubmitOverrides = {
    studentName?: string; rocketNumber?: string; studentEmail?: string;
    term?: string; fundingSource?: string; coachName?: string; coachEmail?: string;
  };
  const overrides = await c.req.json<ResubmitOverrides>().catch(() => ({} as ResubmitOverrides));

  const orig = await c.env.DB.prepare('SELECT * FROM insurance_requests WHERE id = ?')
    .bind(id).first<Record<string, unknown>>();
  if (!orig) return err('Not found', 404);
  if (orig.status !== 'DENIED') return err('Only denied requests can be resubmitted', 409);

  const studentName = (overrides.studentName ?? (orig.student_name as string)).trim();
  const rocketNumber = (overrides.rocketNumber ?? (orig.rocket_number as string)).trim().toUpperCase();
  const term = overrides.term ?? (orig.term as string);
  const sport = orig.sport as string;

  if (!validateRocketNumber(rocketNumber)) return err(`Invalid Rocket Number: ${rocketNumber}`);
  if (!isBeforeDeadline(term)) return err('Submission deadline has passed for this term', 422);

  const fundingSource = overrides.fundingSource ?? (orig.funding_source as string) ?? 'operating_budget';
  if (!FUNDING_SOURCES.includes(fundingSource as typeof FUNDING_SOURCES[number])) return err('Invalid funding source');

  const premiumCost = getPremiumForTerm(term);
  if (!premiumCost) return err('Unknown term', 400);

  const dup = await c.env.DB.prepare(
    `SELECT student_name FROM insurance_requests
     WHERE rocket_number = ? AND term = ? AND status NOT IN ('VOIDED', 'DENIED', 'EXPIRED') LIMIT 1`
  ).bind(rocketNumber, term).first<{ student_name: string }>();
  if (dup) return err(`An active request for ${dup.student_name} in ${term} already exists`, 409);

  const newId = newUUID();
  const coachName = overrides.coachName ?? (orig.coach_name as string) ?? '';
  const coachEmail = overrides.coachEmail ?? (orig.coach_email as string | null) ?? null;
  const studentEmail = overrides.studentEmail ?? (orig.student_email as string | null) ?? null;

  await c.env.DB.prepare(`
    INSERT INTO insurance_requests
      (id, student_name, rocket_number, student_email, sport, term, premium_cost, funding_source, status, coach_email, coach_name, parent_request_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_COACH', ?, ?, ?)
  `).bind(newId, studentName, rocketNumber, studentEmail, sport, term, premiumCost, fundingSource, coachEmail, coachName, id).run();

  await audit(c.env, newId, 'RESUBMITTED', coachName || user.name, { resubmissionOf: id }, clientIp(c));

  deferRequestNotify(c, newId, 'PENDING_COACH', async (mailEnv, d) => {
    const headCoach = await getHeadCoachForSport(c.env, sport);
    await notifyOnCreate(mailEnv, d, headCoach?.email);
  });

  return json({ id: newId, status: 'PENDING_COACH', parentRequestId: id }, 201);
});

// DELETE /api/requests/bulk-delete — permanent bulk delete (Super Admin only)
app.delete('/api/requests/bulk-delete', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'super_admin') return err('Only Super Admin can bulk delete requests', 403);

  const { ids } = await c.req.json<{ ids: string[] }>();
  if (!ids?.length) return err('No request IDs provided');

  const ip = clientIp(c);
  let deleted = 0;
  for (const id of ids) {
    const req = await c.env.DB.prepare(
      'SELECT id, student_name, rocket_number, term, sport, status FROM insurance_requests WHERE id = ?'
    ).bind(id).first<Record<string, unknown>>();
    if (!req) continue;

    await writeDeletionTombstone(c.env, req, user.email || user.name, ip, true);
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM signatures WHERE request_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id),
      c.env.DB.prepare('DELETE FROM insurance_requests WHERE id = ?').bind(id),
    ]);
    deleted++;
  }

  return json({ deleted });
});

/**
 * Record that a request was destroyed before its audit rows go with it.
 *
 * A permanent delete cascades to audit_log, so without this the system forgets a
 * record ever existed. The tombstone has a null request_id (the row it pointed at is
 * gone) and carries enough identifying detail to reconstruct what was removed.
 */
async function writeDeletionTombstone(
  env: Env, req: Record<string, unknown>, actor: string, ip: string, bulk: boolean,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, request_id, action, performed_by, details, ip_address)
     VALUES (?, NULL, 'REQUEST_DELETED', ?, ?, ?)`
  ).bind(
    newUUID(),
    actor,
    JSON.stringify({
      deletedRequestId: req.id,
      studentName: req.student_name,
      rocketNumber: req.rocket_number,
      term: req.term,
      sport: req.sport,
      statusAtDeletion: req.status,
      ...(bulk ? { bulk: true } : {}),
    }),
    ip,
  ).run();
}

// DELETE /api/requests/:id — super_admin only (permanent delete)
app.delete('/api/requests/:id', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'super_admin') return err('Only Super Admin can delete requests', 403);

  const { id } = c.req.param();

  const req = await c.env.DB.prepare(
    'SELECT id, student_name, rocket_number, term, sport, status FROM insurance_requests WHERE id = ?'
  ).bind(id).first<Record<string, unknown>>();
  if (!req) return err('Not found', 404);

  await writeDeletionTombstone(c.env, req, user.email || user.name, clientIp(c), false);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM signatures WHERE request_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM audit_log WHERE request_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM insurance_requests WHERE id = ?').bind(id),
  ]);

  return json({ ok: true });
});

// ── Reports (CFO and super_admin) ────────────────────────────────────────────

app.get('/api/reports', async c => {
  const user = await currentUser(c);
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

  // The report drives on-screen aggregates, so paging it would silently change the
  // totals. It is bounded instead, and the page warns when the bound is reached rather
  // than presenting a truncated total as if it were complete. Use the CSV export for
  // anything larger.
  query += ` ORDER BY ir.created_at DESC LIMIT ${REPORT_ROW_CAP}`;

  const stmt = c.env.DB.prepare(query).bind(...params);
  const { results } = await stmt.all();
  return json(results);
});

// GET /api/reports/csv — CFO and super_admin, CSV download
app.get('/api/reports/csv', async c => {
  const user = await currentUser(c);
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

  const stmt = c.env.DB.prepare(query).bind(...params);
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

// GET /api/admin/settings — system email + portal URL settings (Super Admin)
app.get('/api/admin/settings', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can access settings', 403);
  const settings = await getPortalSettings(c.env);
  return json(settings);
});

// PUT /api/admin/settings — update system email + portal URL settings (Super Admin)
app.put('/api/admin/settings', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can update settings', 403);

  const body = await c.req.json<{
    fromName: string; fromEmail: string; appBaseUrl: string; replyTo?: string;
  }>();
  const fromName = body.fromName?.trim();
  const fromEmail = body.fromEmail?.trim().toLowerCase();
  const appBaseUrl = body.appBaseUrl?.trim().replace(/\/$/, '');
  const replyTo = body.replyTo?.trim().toLowerCase() ?? '';

  if (!fromName) return err('From name is required');
  if (!fromEmail || !EMAIL_SIMPLE_RE.test(fromEmail)) return err('Valid from email is required');
  if (!appBaseUrl || !isValidHttpUrl(appBaseUrl)) return err('Valid portal base URL is required (http/https)');
  if (replyTo && !EMAIL_SIMPLE_RE.test(replyTo)) return err('Reply-to must be a valid email address');

  const upsert = (key: string, value: string) => c.env.DB.prepare(
    `INSERT INTO app_settings (setting_key, setting_value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value, updated_at = datetime('now')`
  ).bind(key, value);

  await c.env.DB.batch([
    upsert('from_name', fromName),
    upsert('from_email', fromEmail),
    upsert('app_base_url', appBaseUrl),
    upsert('reply_to', replyTo),
  ]);

  return json({ ok: true, fromName, fromEmail, appBaseUrl, replyTo });
});

app.get('/api/admin/users', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, name, role, sport_id as sportId, must_change_password as mustChangePassword, status, created_at as createdAt FROM users ORDER BY created_at DESC'
  ).all<Record<string, unknown>>();
  // Attach sport-admin assignments so the Users table can show & edit them (4.6).
  const { results: assignments } = await c.env.DB.prepare(
    'SELECT admin_user_id, sport_id FROM sport_admin_assignments'
  ).all<{ admin_user_id: string; sport_id: string }>();
  const byUser = new Map<string, string[]>();
  for (const a of assignments) {
    const list = byUser.get(a.admin_user_id) ?? [];
    list.push(a.sport_id);
    byUser.set(a.admin_user_id, list);
  }
  return json(results.map(u => ({ ...u, sportIds: byUser.get(u.id as string) ?? [] })));
});

app.post('/api/admin/users', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);

  const { email, password, name, role, sportId, sportIds } = await c.req.json<{
    email: string; password: string; name: string; role: string; sportId?: string; sportIds?: string[];
  }>();

  if (!email || !password || !name || !role) return err('Missing required fields');
  if (!['coach', 'sport_admin', 'cfo', 'super_admin'].includes(role)) return err('Invalid role');
  if (password.length < 8) return err('Password must be at least 8 characters');
  if (role === 'sport_admin' && !(sportIds?.length)) return err('Select at least one sport for this Sport Admin');

  const exists = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email.toLowerCase()).first();
  if (exists) return err('Email already in use', 409);

  const id = newUUID();
  const passwordHash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, email, password_hash, name, role, sport_id, must_change_password, status) VALUES (?, ?, ?, ?, ?, ?, 1, ?)'
  ).bind(id, email.toLowerCase(), passwordHash, name, role, sportId ?? null, 'active').run();

  if (role === 'sport_admin') await setSportAdminAssignments(c.env, id, sportIds ?? []);

  // Mirror the account into sport_administrators.
  //
  // Two parallel models exist: sports_programs.sport_admin_id references this table,
  // while login accounts live in users and reach sports through sport_admin_assignments.
  // The Sports page picker reads sport_administrators, so without a row here a newly
  // created administrator cannot be assigned to a sport at all. Reusing the user's id as
  // the primary key keeps the two sides joinable, which is what lets the picker filter on
  // account status and lets deletion clean up both.
  if (role === 'sport_admin' || role === 'cfo') {
    // A seeded administrator may already exist for this person under a slug id that sports
    // already reference. Giving them a login must not add a second entry to the picker, so
    // the existing row is left as the canonical one. Re-pointing it at the new id would
    // mean rewriting every sports_programs.sport_admin_id that references it, which is the
    // riskier half of the trade for no visible gain.
    const existing = await c.env.DB.prepare(
      'SELECT id FROM sport_administrators WHERE lower(email) = ?'
    ).bind(email.toLowerCase()).first<{ id: string }>();

    if (!existing) {
      await c.env.DB.prepare(
        'INSERT INTO sport_administrators (id, name, title, email, is_cfo) VALUES (?, ?, ?, ?, ?)'
      ).bind(
        id, name,
        role === 'cfo' ? 'Chief Financial Officer' : 'Sport Administrator',
        email.toLowerCase(), role === 'cfo' ? 1 : 0,
      ).run();
    }
  }

  // Best-effort: the account exists whether or not the message lands, and the outcome is
  // recorded in email_log either way.
  const roleLabel = role === 'super_admin' ? 'a Super Admin'
    : role === 'cfo' ? 'the Chief Financial Officer'
    : role === 'sport_admin' ? 'a Sport Administrator'
    : 'a Coach';
  deferNotify(c, mailEnv => notifyAccountCreated(mailEnv, email.toLowerCase(), name, password, roleLabel));

  return json({ id, email: email.toLowerCase(), name, role, sportId: sportId ?? null, sportIds: role === 'sport_admin' ? (sportIds ?? []) : [], mustChangePassword: 1, status: 'active', createdAt: new Date().toISOString() }, 201);
});

// PUT /api/admin/users/:id/sports — update a Sport Admin's sport assignments (4.6)
app.put('/api/admin/users/:id/sports', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  const { sportIds } = await c.req.json<{ sportIds: string[] }>();
  const target = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?').bind(id).first<{ role: string }>();
  if (!target) return err('Not found', 404);
  if (target.role !== 'sport_admin') return err('Only Sport Admin accounts have sport assignments', 400);
  if (!sportIds?.length) return err('Select at least one sport');
  await setSportAdminAssignments(c.env, id, sportIds);
  return json({ ok: true, sportIds: [...new Set(sportIds)] });
});

// Privilege ranking, so an account cannot be removed by someone at or below its level.
const ROLE_RANK: Record<string, number> = { coach: 1, sport_admin: 2, cfo: 3, super_admin: 4 };

app.delete('/api/admin/users/:id', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  if (id === user.sub) return err('Cannot delete your own account', 400);

  const target = await c.env.DB.prepare('SELECT role FROM users WHERE id = ?')
    .bind(id).first<{ role: string }>();
  if (!target) return err('Not found', 404);

  // isAdmin() includes cfo, so without this a CFO could delete a Super Admin.
  if ((ROLE_RANK[target.role] ?? 0) >= (ROLE_RANK[user.role] ?? 0)) {
    return err('You cannot delete an account at or above your own permission level', 403);
  }

  // Sports pointing at this account's mirrored administrator row have to be detached
  // before it goes, or they keep a dangling sport_admin_id and the Sports page renders a
  // blank administrator. Captured first so single_approval can be recomputed after.
  const { results: orphaned } = await c.env.DB.prepare(
    'SELECT id FROM sports_programs WHERE sport_admin_id = ?'
  ).bind(id).all<{ id: string }>();

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sport_admin_assignments WHERE admin_user_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').bind(id),
    c.env.DB.prepare('UPDATE sports_programs SET sport_admin_id = NULL WHERE sport_admin_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sport_administrators WHERE id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);

  // Losing a CFO administrator means those sports no longer finalize on one signature.
  for (const s of orphaned) await syncSingleApproval(c.env, s.id);

  return json({ ok: true });
});

// PUT /api/admin/users/:id/approve — approve pending user
app.put('/api/admin/users/:id/approve', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can approve users', 403);
  const { id } = c.req.param();
  const target = await c.env.DB.prepare('SELECT email, name, status FROM users WHERE id = ?')
    .bind(id).first<{ email: string; name: string; status: string }>();
  if (!target) return err('Not found', 404);
  if (target.status !== 'pending') return err('This account is not awaiting approval', 409);

  await c.env.DB.prepare('UPDATE users SET status = ? WHERE id = ? AND status = ?')
    .bind('active', id, 'pending').run();
  await audit(c.env, null, 'USER_APPROVED', user.email, { userId: id, email: target.email }, clientIp(c));
  deferNotify(c, mailEnv => notifyRegistrationDecision(mailEnv, target.email, target.name, true));
  return json({ ok: true });
});

// PUT /api/admin/users/:id/reject — reject pending user
app.put('/api/admin/users/:id/reject', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can reject users', 403);
  const { id } = c.req.param();
  const target = await c.env.DB.prepare('SELECT email, name, status, token_version FROM users WHERE id = ?')
    .bind(id).first<{ email: string; name: string; status: string; token_version: number | null }>();
  if (!target) return err('Not found', 404);

  // Bump token_version too: a previously-active account being rejected must lose any
  // session it already holds, not just fail future logins.
  await c.env.DB.prepare('UPDATE users SET status = ?, token_version = ? WHERE id = ?')
    .bind('rejected', (target.token_version ?? 0) + 1, id).run();
  await audit(c.env, null, 'USER_REJECTED', user.email, { userId: id, email: target.email }, clientIp(c));
  deferNotify(c, mailEnv => notifyRegistrationDecision(mailEnv, target.email, target.name, false));
  return json({ ok: true });
});

// POST /api/requests/bulk-sign — bulk approve for sport admin, CFO, and super_admin
app.post('/api/requests/bulk-sign', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach' && user.role !== 'sport_admin' && user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only authorized roles can bulk sign', 403);
  }

  const { ids, coachName } = await c.req.json<{ ids: string[]; coachName?: string }>();
  if (!ids?.length) return err('No request IDs provided');

  const ip = clientIp(c);
  const adminScope = user.role === 'sport_admin'
    ? new Set(await sportAdminScopeIds(c.env, { sub: user.sub, sportId: user.sportId }))
    : null;
  const results: { id: string; status: string }[] = [];

  for (const id of ids) {
    const req = await c.env.DB.prepare(`
      SELECT ir.id, ir.status, ir.sport
      FROM insurance_requests ir
      WHERE ir.id = ?
    `).bind(id).first<{ id: string; status: string; sport: string }>();

    if (!req) continue;
    if (adminScope && !adminScope.has(req.sport)) continue; // sport-admin scoping (1.3)

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
      else if (!signedRoles.has('SPORT_ADMIN') && !(await isSingleApproval(c.env, req.sport))) sigRole = 'SPORT_ADMIN';
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

    const breakGlass = user.role === 'super_admin';
    await audit(c.env, id, sigRole === 'COACH' ? 'HEAD_COACH_APPROVED' : (breakGlass ? 'SIGNED_ON_BEHALF' : 'SIGNED'),
      user.email || signatoryName, { role: sigRole, bulk: true, ...(breakGlass ? { onBehalfOf: sigRole } : {}) }, ip);

    let newStatus: string;
    if (sigRole === 'COACH') {
      newStatus = 'PENDING_APPROVAL';
      await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, coach_name = ?, reminder_count = 0 WHERE id = ?')
        .bind(newStatus, signatoryName, id).run();
      deferRequestNotify(c, id, newStatus, notifyApprovers);
    } else {
      const allApproved = await hasAllApprovals(c.env, id, req.sport);
      newStatus = allApproved ? 'EXECUTED' : 'PENDING_APPROVAL';
      await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
        .bind(newStatus, id).run();
      if (allApproved) {
        deferRequestNotify(c, id, newStatus, async (mailEnv, d) =>
          notifyExecuted(mailEnv, d, await buildRequestPdfAttachment(c.env, id)));
      }
    }

    results.push({ id, status: newStatus });
  }

  return json({ signed: results.length, results });
});

// POST /api/requests/bulk-deny — bulk decline pending requests
app.post('/api/requests/bulk-deny', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (!['coach', 'sport_admin', 'cfo', 'super_admin'].includes(user.role)) {
    return err('You are not permitted to bulk deny requests', 403);
  }

  const { ids, reason } = await c.req.json<{ ids: string[]; reason: string }>();
  if (!ids?.length) return err('No request IDs provided');
  if (!reason?.trim()) return err('A denial reason is required');

  const ip = clientIp(c);
  const adminScope = user.role === 'sport_admin'
    ? new Set(await sportAdminScopeIds(c.env, { sub: user.sub, sportId: user.sportId }))
    : null;
  const results: { id: string; status: string }[] = [];

  for (const id of ids) {
    const req = await c.env.DB.prepare('SELECT status, sport FROM insurance_requests WHERE id = ?')
      .bind(id).first<{ status: string; sport: string }>();
    if (!req) continue;

    if (req.status !== 'PENDING_COACH' && req.status !== 'PENDING_APPROVAL') continue;
    if (adminScope && !adminScope.has(req.sport)) continue;
    if (user.role === 'cfo' && req.status !== 'PENDING_APPROVAL') continue;

    await c.env.DB.prepare('UPDATE insurance_requests SET status = ?, denial_reason = ? WHERE id = ?')
      .bind('DENIED', reason.trim(), id).run();
    await audit(c.env, id, 'DENIED', user.email || user.name,
      { reason: reason.trim(), role: user.role, bulk: true }, ip);

    deferRequestNotify(c, id, 'DENIED', (mailEnv, d) => {
      d.denialReason = reason.trim();
      return notifyDenied(mailEnv, d);
    });
    results.push({ id, status: 'DENIED' });
  }

  return json({ denied: results.length, results });
});

// POST /api/requests/bulk-void — bulk void pending requests (CFO/Super Admin)
app.post('/api/requests/bulk-void', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'cfo' && user.role !== 'super_admin') {
    return err('Only CFO or Super Admin can bulk void requests', 403);
  }

  const { ids, reason } = await c.req.json<{ ids: string[]; reason: string }>();
  if (!ids?.length) return err('No request IDs provided');
  if (!reason?.trim()) return err('Void reason is required');

  const ip = clientIp(c);
  const results: { id: string; status: string }[] = [];

  for (const id of ids) {
    const req = await c.env.DB.prepare('SELECT status FROM insurance_requests WHERE id = ?')
      .bind(id).first<{ status: string }>();
    if (!req) continue;
    if (req.status !== 'PENDING_APPROVAL' && req.status !== 'PENDING_COACH') continue;

    const pdf = await buildRequestPdfAttachment(c.env, id);
    await c.env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind('VOIDED', id).run();
    await audit(c.env, id, 'VOIDED', user.email || user.name,
      { reason: reason.trim(), bulk: true }, ip);

    deferRequestNotify(c, id, 'VOIDED', (mailEnv, d) => {
      d.voidReason = reason.trim();
      return notifyVoided(mailEnv, d, pdf);
    });
    results.push({ id, status: 'VOIDED' });
  }

  return json({ voided: results.length, results });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const slugify = (s: string) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

// POST /api/admin/sports — create a new sport/program (Super Admin)
app.post('/api/admin/sports', async c => {
  const user = await currentUser(c);
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
  await syncSingleApproval(c.env, id);

  return json({ id, name: name.trim(), gender: gender.trim(), headCoach: headCoach?.trim() || null, headCoachEmail: email, sportAdminId: sportAdminId || null }, 201);
});

// PUT /api/admin/sports/:id — update sport details + admin assignment (Super Admin)
app.put('/api/admin/sports/:id', async c => {
  const user = await currentUser(c);
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
  // The administrator may have changed, which changes whether one CFO signature is the
  // whole approval for this sport.
  await syncSingleApproval(c.env, id);

  return json({ ok: true });
});

// DELETE /api/admin/sports/:id — remove a sport with no requests (Super Admin)
app.delete('/api/admin/sports/:id', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can delete sports', 403);
  const { id } = c.req.param();
  const inUse = await c.env.DB.prepare('SELECT id FROM insurance_requests WHERE sport = ? LIMIT 1').bind(id).first();
  if (inUse) return err('Cannot delete a sport that already has insurance requests', 409);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM coaches WHERE sport_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sport_admin_assignments WHERE sport_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM sports_programs WHERE id = ?').bind(id),
  ]);
  return json({ ok: true });
});

// ── Coaches (multi-staff per sport, 4.2–4.3) ─────────────────────────────────

/** Keep sports_programs.head_coach / head_coach_email in sync with the head coach row. */
async function syncHeadCoachColumns(env: Env, sportId: string): Promise<void> {
  const hc = await env.DB.prepare(
    'SELECT display_name, email FROM coaches WHERE sport_id = ? AND is_head_coach = 1 LIMIT 1'
  ).bind(sportId).first<{ display_name: string; email: string }>();
  await env.DB.prepare('UPDATE sports_programs SET head_coach = ?, head_coach_email = ? WHERE id = ?')
    .bind(hc?.display_name ?? null, hc?.email ?? null, sportId).run();
}

const coachSelect = `
  SELECT id, display_name as displayName, email, sport_id as sportId, title,
         is_head_coach as isHeadCoach, delegated_approver_email as delegatedApproverEmail,
         delegation_expires_at as delegationExpiresAt
  FROM coaches`;

// GET /api/sports/:id/coaches — list coaches for a sport (any authenticated user;
// used both by the Super Admin UI and to resolve the coach's name on the request form).
// Out-of-office delegation fields are only returned to the Super Admin who manages them.
app.get('/api/sports/:id/coaches', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  const { id } = c.req.param();
  const { results } = await c.env.DB.prepare(
    `${coachSelect} WHERE sport_id = ? ORDER BY is_head_coach DESC, display_name`
  ).bind(id).all<Record<string, unknown>>();
  if (user.role !== 'super_admin') {
    return json(results.map(({ delegatedApproverEmail, delegationExpiresAt, ...rest }) => rest));
  }
  return json(results);
});

// POST /api/admin/sports/:id/coaches — add a coach to a sport (Super Admin)
app.post('/api/admin/sports/:id/coaches', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can manage coaches', 403);
  const { id: sportId } = c.req.param();
  const { displayName, email, title, isHeadCoach } = await c.req.json<{
    displayName: string; email: string; title?: string; isHeadCoach?: boolean;
  }>();
  if (!displayName?.trim()) return err('Coach name is required');
  if (!email?.trim() || !EMAIL_RE.test(email.trim())) return err('A valid email is required');

  const sport = await c.env.DB.prepare('SELECT id FROM sports_programs WHERE id = ?').bind(sportId).first();
  if (!sport) return err('Unknown sport', 404);

  const coachId = newUUID();
  // Only one head coach per sport — demote any existing head coach first.
  if (isHeadCoach) {
    await c.env.DB.prepare('UPDATE coaches SET is_head_coach = 0 WHERE sport_id = ?').bind(sportId).run();
  }
  await c.env.DB.prepare(
    'INSERT INTO coaches (id, display_name, email, sport_id, title, is_head_coach) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(coachId, displayName.trim(), email.trim().toLowerCase(), sportId, title?.trim() || (isHeadCoach ? 'Head Coach' : 'Assistant Coach'), isHeadCoach ? 1 : 0).run();
  if (isHeadCoach) await syncHeadCoachColumns(c.env, sportId);

  return json({ id: coachId, displayName: displayName.trim(), email: email.trim().toLowerCase(), sportId, title: title?.trim() || (isHeadCoach ? 'Head Coach' : 'Assistant Coach'), isHeadCoach: isHeadCoach ? 1 : 0 }, 201);
});

// PUT /api/admin/coaches/:id — update a coach incl. head-coach flag & delegation (Super Admin)
app.put('/api/admin/coaches/:id', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can manage coaches', 403);
  const { id } = c.req.param();
  const body = await c.req.json<{
    displayName?: string; email?: string; title?: string | null; isHeadCoach?: boolean;
    delegatedApproverEmail?: string | null; delegationExpiresAt?: string | null;
  }>();

  const coach = await c.env.DB.prepare('SELECT * FROM coaches WHERE id = ?').bind(id).first<Record<string, unknown>>();
  if (!coach) return err('Not found', 404);
  const sportId = coach.sport_id as string;

  const email = body.email !== undefined ? body.email.trim().toLowerCase() : (coach.email as string);
  if (email && !EMAIL_RE.test(email)) return err('Invalid email');
  const delegateEmail = body.delegatedApproverEmail?.trim() || null;
  if (delegateEmail && !EMAIL_RE.test(delegateEmail)) return err('Invalid delegate email');

  // Don't allow directly demoting the current head coach — that would leave the sport with
  // no Step-1 approver and silently stall future requests. Reassign by promoting another
  // coach instead (which demotes this one automatically).
  if (coach.is_head_coach && body.isHeadCoach === false) {
    return err('To change the head coach, mark another coach as Head Coach instead — that reassigns it automatically.', 409);
  }

  const makeHead = body.isHeadCoach === true && !coach.is_head_coach;
  if (makeHead) {
    await c.env.DB.prepare('UPDATE coaches SET is_head_coach = 0 WHERE sport_id = ?').bind(sportId).run();
  }
  const isHeadCoach = body.isHeadCoach === undefined ? (coach.is_head_coach as number) : (body.isHeadCoach ? 1 : 0);

  await c.env.DB.prepare(`
    UPDATE coaches SET display_name = ?, email = ?, title = ?, is_head_coach = ?,
      delegated_approver_email = ?, delegation_expires_at = ?
    WHERE id = ?
  `).bind(
    body.displayName?.trim() || (coach.display_name as string),
    email,
    body.title !== undefined ? (body.title?.trim() || null) : (coach.title as string | null),
    isHeadCoach,
    body.delegatedApproverEmail !== undefined ? delegateEmail : (coach.delegated_approver_email as string | null),
    (() => {
      const raw = body.delegationExpiresAt !== undefined
        ? (body.delegationExpiresAt || null)
        : (coach.delegation_expires_at as string | null);
      // Normalize date-only inputs (YYYY-MM-DD) to end-of-day so the stored value
      // is unambiguous regardless of the caller's locale.
      return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59.999Z` : raw;
    })(),
    id,
  ).run();
  await syncHeadCoachColumns(c.env, sportId);

  return json({ ok: true });
});

// DELETE /api/admin/coaches/:id — remove a coach from a sport (Super Admin)
app.delete('/api/admin/coaches/:id', async c => {
  const user = await currentUser(c);
  if (!user || user.role !== 'super_admin') return err('Only Super Admin can manage coaches', 403);
  const { id } = c.req.param();
  const coach = await c.env.DB.prepare('SELECT sport_id, is_head_coach FROM coaches WHERE id = ?').bind(id).first<{ sport_id: string; is_head_coach: number }>();
  if (!coach) return err('Not found', 404);
  await c.env.DB.prepare('DELETE FROM coaches WHERE id = ?').bind(id).run();
  if (coach.is_head_coach) await syncHeadCoachColumns(c.env, coach.sport_id);
  return json({ ok: true });
});

// ── Budget dashboard (2.3) ────────────────────────────────────────────────────

// PUT /api/admin/sports/:id/budget — set a per-sport budget cap (CFO or Super Admin)
app.put('/api/admin/sports/:id/budget', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { id } = c.req.param();
  const { budgetCap } = await c.req.json<{ budgetCap: number | null }>();
  if (budgetCap !== null && (typeof budgetCap !== 'number' || budgetCap < 0 || !isFinite(budgetCap))) {
    return err('Budget cap must be a non-negative number or null');
  }
  const sport = await c.env.DB.prepare('SELECT id FROM sports_programs WHERE id = ?').bind(id).first();
  if (!sport) return err('Not found', 404);
  await c.env.DB.prepare('UPDATE sports_programs SET budget_cap = ? WHERE id = ?').bind(budgetCap, id).run();
  return json({ ok: true, budgetCap });
});

// GET /api/reports/budget — committed premium vs. cap per sport (CFO / Super Admin)
app.get('/api/reports/budget', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);

  const { results } = await c.env.DB.prepare(`
    SELECT sp.id as sportId, sp.name as sportName, sp.budget_cap as budgetCap,
           COALESCE(SUM(CASE WHEN ir.status = 'EXECUTED' THEN ir.premium_cost END), 0) as executedPremium,
           COALESCE(SUM(CASE WHEN ir.status IN ('EXECUTED', 'PENDING_APPROVAL', 'PENDING_COACH') THEN ir.premium_cost END), 0) as committedPremium,
           COUNT(CASE WHEN ir.status = 'EXECUTED' THEN 1 END) as executedCount
    FROM sports_programs sp
    LEFT JOIN insurance_requests ir ON ir.sport = sp.id
    GROUP BY sp.id, sp.name, sp.budget_cap
    ORDER BY sp.name
  `).all<{
    sportId: string; sportName: string; budgetCap: number | null;
    executedPremium: number; committedPremium: number; executedCount: number;
  }>();

  // Project end-of-year spend by extrapolating the academic year's elapsed fraction.
  const now = new Date();
  const ayStart = new Date(now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1, 6, 1); // Jul 1
  const ayEnd = new Date(ayStart.getFullYear() + 1, 5, 30); // Jun 30
  const elapsed = Math.min(1, Math.max(0.01, (now.getTime() - ayStart.getTime()) / (ayEnd.getTime() - ayStart.getTime())));

  const rows = results.map(r => ({
    ...r,
    projectedPremium: Math.round((r.committedPremium / elapsed) * 100) / 100,
    remaining: r.budgetCap != null ? Math.round((r.budgetCap - r.committedPremium) * 100) / 100 : null,
    overBudget: r.budgetCap != null && r.committedPremium > r.budgetCap,
  }));
  return json({ sports: rows, elapsedFraction: Math.round(elapsed * 100) / 100 });
});

// ── Audit log viewer (3.3) ────────────────────────────────────────────────────

function buildAuditQuery(c: { req: { query: () => Record<string, string> } }): { sql: string; params: (string | number)[] } {
  const { requestId, actor, from, to, action } = c.req.query();
  let sql = `
    SELECT al.id, al.request_id as requestId, al.action, al.performed_by as actor,
           al.details, al.ip_address as ipAddress, al.timestamp,
           ir.student_name as studentName, ir.rocket_number as rocketNumber, sp.name as sportName
    FROM audit_log al
    LEFT JOIN insurance_requests ir ON al.request_id = ir.id
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    WHERE 1=1`;
  const params: (string | number)[] = [];
  if (requestId) { sql += ' AND al.request_id = ?'; params.push(requestId); }
  if (actor) { sql += ' AND al.performed_by LIKE ?'; params.push(`%${actor}%`); }
  if (action) { sql += ' AND al.action = ?'; params.push(action); }
  if (from) { sql += ' AND al.timestamp >= ?'; params.push(from); }
  if (to) { sql += ' AND al.timestamp <= ?'; params.push(`${to} 23:59:59`); }
  sql += ' ORDER BY al.timestamp DESC LIMIT 2000';
  return { sql, params };
}

app.get('/api/audit', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { sql, params } = buildAuditQuery(c);
  const stmt = c.env.DB.prepare(sql).bind(...params);
  const { results } = await stmt.all();
  return json(results);
});

app.get('/api/audit/csv', async c => {
  const user = await currentUser(c);
  if (!user || !isAdmin(user.role)) return err('Forbidden', 403);
  const { sql, params } = buildAuditQuery(c);
  const stmt = c.env.DB.prepare(sql).bind(...params);
  const { results } = await stmt.all<Record<string, unknown>>();
  const headers = ['Timestamp', 'Action', 'Actor', 'IP Address', 'Student', 'Rocket #', 'Sport', 'Details'];
  const csvRows = [
    headers.join(','),
    ...results.map(r => [
      csvEscape(String(r.timestamp ?? '')),
      csvEscape(String(r.action ?? '')),
      csvEscape(String(r.actor ?? '')),
      csvEscape(String(r.ipAddress ?? '')),
      csvEscape(String(r.studentName ?? '')),
      csvEscape(String(r.rocketNumber ?? '')),
      csvEscape(String(r.sportName ?? '')),
      csvEscape(String(r.details ?? '')),
    ].join(',')),
  ];
  return new Response(csvRows.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit-log.csv"',
    },
  });
});

// ── Bulk CSV import (2.2) ─────────────────────────────────────────────────────

// POST /api/requests/bulk — submit many parsed CSV rows in one call (coach)
app.post('/api/requests/bulk', async c => {
  const user = await currentUser(c);
  if (!user) return err('Unauthorized', 401);
  if (user.role !== 'coach') return err('Only coaches can submit requests', 403);

  const { rows } = await c.req.json<{
    rows: { studentName: string; rocketNumber: string; email?: string; sport: string; term: string; fundingSource?: string; coachName?: string; coachEmail?: string }[];
  }>();
  if (!rows?.length) return err('No rows provided');
  if (rows.length > 200) return err('Too many rows (max 200 per import)');

  const ip = clientIp(c);
  const created: { id: string; studentName: string; rocketNumber: string; sport: string }[] = [];
  const skipped: { row: number; studentName: string; reason: string }[] = [];
  const headCoachBySport = new Map<string, { name: string; email: string } | null>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const studentName = r.studentName?.trim();
    const rocketNumber = r.rocketNumber?.trim().toUpperCase();
    try {
      if (!studentName) { skipped.push({ row: i + 1, studentName: studentName || '(blank)', reason: 'Missing student name' }); continue; }
      if (!validateRocketNumber(rocketNumber || '')) { skipped.push({ row: i + 1, studentName, reason: `Invalid Rocket Number: ${rocketNumber}` }); continue; }
      const studentEmail = r.email?.trim() || null;
      if (studentEmail && !EMAIL_SIMPLE_RE.test(studentEmail)) { skipped.push({ row: i + 1, studentName, reason: `Invalid email: ${studentEmail}` }); continue; }
      if (!r.sport) { skipped.push({ row: i + 1, studentName, reason: 'Missing sport' }); continue; }
      const sportRow = await c.env.DB.prepare('SELECT id, head_coach, head_coach_email FROM sports_programs WHERE id = ?').bind(r.sport).first<{ id: string; head_coach: string | null; head_coach_email: string | null }>();
      if (!sportRow) { skipped.push({ row: i + 1, studentName, reason: `Unknown sport: ${r.sport}` }); continue; }
      if (!isBeforeDeadline(r.term)) { skipped.push({ row: i + 1, studentName, reason: `Past deadline for ${r.term}` }); continue; }
      const premiumCost = getPremiumForTerm(r.term);
      if (!premiumCost) { skipped.push({ row: i + 1, studentName, reason: `Unknown term: ${r.term}` }); continue; }
      const fundingSource = r.fundingSource ?? 'operating_budget';
      if (!FUNDING_SOURCES.includes(fundingSource as typeof FUNDING_SOURCES[number])) { skipped.push({ row: i + 1, studentName, reason: 'Invalid funding source' }); continue; }

      const dup = await c.env.DB.prepare(
        `SELECT id FROM insurance_requests WHERE rocket_number = ? AND term = ? AND status NOT IN ('VOIDED', 'DENIED', 'EXPIRED') LIMIT 1`
      ).bind(rocketNumber, r.term).first();
      if (dup) { skipped.push({ row: i + 1, studentName, reason: `Duplicate — active request already exists for ${r.term}` }); continue; }

      const id = newUUID();
      const coachName = r.coachName?.trim() || sportRow.head_coach?.trim() || '';
      const coachEmail = (r.coachEmail?.trim() || sportRow.head_coach_email || '') || null;
      await c.env.DB.prepare(`
        INSERT INTO insurance_requests
          (id, student_name, rocket_number, student_email, sport, term, premium_cost, funding_source, status, coach_email, coach_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_COACH', ?, ?)
      `).bind(id, studentName, rocketNumber, studentEmail, r.sport, r.term, premiumCost, fundingSource, coachEmail, coachName).run();
      await audit(c.env, id, 'SUBMITTED', coachName || user.name || 'Coach', { status: 'PENDING_COACH', via: 'bulk_csv' }, ip);

      if (!headCoachBySport.has(r.sport)) headCoachBySport.set(r.sport, await getHeadCoachForSport(c.env, r.sport));
      created.push({ id, studentName, rocketNumber: rocketNumber!, sport: r.sport });
    } catch (e) {
      skipped.push({ row: i + 1, studentName: studentName || '(row)', reason: e instanceof Error ? e.message : 'Unexpected error' });
    }
  }

  // Send the same set of messages the manual path sends. The CSV path previously
  // notified only the head coach, so a coach importing a roster got no confirmation and
  // the athletes were never told a request had been filed on their behalf.
  deferNotify(c, async mailEnv => {
    for (const row of created) {
      const d = await loadRequestEmailData(c.env, row.id);
      if (!d) continue;
      d.status = 'PENDING_COACH';
      await notifyOnCreate(mailEnv, d, headCoachBySport.get(row.sport)?.email);
    }
  });

  return json({ submitted: created.length, skippedCount: skipped.length, created, skipped }, 201);
});

// ── Static assets / SPA fallback ─────────────────────────────────────────────

app.all('*', async c => {
  const { pathname, origin } = new URL(c.req.url);

  // An unmatched API route used to fall through to the SPA fallback and return
  // index.html with a 200, so a client calling a mistyped endpoint got HTML where it
  // expected JSON and failed somewhere far from the cause.
  if (pathname.startsWith('/api/') || pathname.startsWith('/auth/')) {
    return err('Not found', 404);
  }

  const assetResponse = await c.env.ASSETS.fetch(c.req.raw);
  if (assetResponse.status === 404) {
    // SPA fallback: serve index.html for client-side routing
    return c.env.ASSETS.fetch(new Request(`${origin}/index.html`));
  }
  return assetResponse;
});

// ── Scheduled: reminders and expiry ──────────────────────────────────────────

const REMINDER_AFTER_HOURS = 48;
const MAX_REMINDERS = 4;      // after this the request is left alone until it expires
const REMINDER_BATCH = 40;    // rows per cron tick, to stay inside the subrequest budget
const EXPIRY_BATCH = 100;

/**
 * Chase every approver who still owes a signature.
 *
 * This used to look only at PENDING_APPROVAL, so requests parked at PENDING_COACH were
 * never chased. That is the step most likely to stall, because it depends on a head
 * coach reading a message that Microsoft may have quarantined. Both steps are covered
 * now, reminders stop after MAX_REMINDERS instead of repeating forever, and the last one
 * escalates to the approvers above the blocked step.
 */
async function runReminders(env: Env): Promise<void> {
  const mailEnv = await getConfiguredEnv(env);
  const cutoff = new Date(Date.now() - REMINDER_AFTER_HOURS * 60 * 60 * 1000).toISOString();
  const cfoEmails = await getCfoEmails(env);

  const { results } = await env.DB.prepare(`
    SELECT ir.id, ir.student_name, ir.rocket_number, ir.student_email, ir.sport, sp.name as sportName,
           ir.term, ir.premium_cost, ir.funding_source, ir.status, ir.coach_email, ir.coach_name,
           ir.reminder_count, sp.single_approval as singleApproval,
           sa.email as sportAdminEmail, sa.name as sportAdminName,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'SPORT_ADMIN') as sportAdminSigned,
           EXISTS(SELECT 1 FROM signatures s WHERE s.request_id = ir.id AND s.signatory_role = 'CFO') as cfoSigned
    FROM insurance_requests ir
    LEFT JOIN sports_programs sp ON ir.sport = sp.id
    LEFT JOIN sport_administrators sa ON sp.sport_admin_id = sa.id
    WHERE ir.status IN ('PENDING_COACH', 'PENDING_APPROVAL')
      AND ir.created_at < ?
      AND ir.reminder_count < ?
      AND NOT EXISTS (
        SELECT 1 FROM audit_log al
        WHERE al.request_id = ir.id AND al.action = 'REMINDER_SENT'
          AND al.timestamp > datetime('now', '-24 hours')
      )
    ORDER BY ir.created_at ASC
    LIMIT ?
  `).bind(cutoff, MAX_REMINDERS, REMINDER_BATCH).all<{
    id: string; student_name: string; rocket_number: string; student_email: string | null;
    sport: string; sportName: string | null; term: string; premium_cost: number;
    funding_source: string; status: string; coach_email: string; coach_name: string;
    reminder_count: number; singleApproval: number | null;
    sportAdminEmail: string | null; sportAdminName: string | null;
    sportAdminSigned: number; cfoSigned: number;
  }>();

  for (const r of results) {
    const headCoach = await getHeadCoachForSport(env, r.sport);
    const sportAdminEmails = await getSportAdminEmailsForSport(env, r.sport);
    const attempt = (r.reminder_count ?? 0) + 1;
    const escalate = attempt >= MAX_REMINDERS;

    // Carry the same deadline context the original notification had. The old payload
    // omitted it, so reminders were less informative than the message they chased.
    const emailData: EmailData = {
      studentName: r.student_name,
      rocketNumber: r.rocket_number,
      studentEmail: r.student_email || undefined,
      sport: r.sport,
      sportName: r.sportName ?? r.sport,
      term: r.term,
      premiumCost: r.premium_cost,
      fundingSource: r.funding_source || 'operating_budget',
      coachName: r.coach_name,
      coachEmail: r.coach_email,
      requestId: r.id,
      status: r.status,
      sportAdminName: r.sportAdminName ?? undefined,
      sportAdminEmail: r.sportAdminEmail ?? undefined,
      sportAdminEmails,
      headCoachName: headCoach?.name,
      headCoachEmail: headCoach?.email,
      cfoEmails,
      submissionDeadline: getSubmissionDeadline(r.term),
      submissionDeadlineISO: getSubmissionDeadlineISO(r.term),
    };

    if (r.status === 'PENDING_COACH') {
      // Step 1 is blocked. Chase the head coach (or their active delegate), and once
      // reminders run out, tell the approvers downstream that it never reached them.
      if (headCoach?.email) {
        await notifyReminder(mailEnv, emailData, headCoach.email, 'Head Coach', escalate);
      }
      if (escalate) {
        for (const to of [...sportAdminEmails, ...cfoEmails]) {
          await notifyReminder(mailEnv, emailData, to, 'Sport Administrator or CFO', true);
        }
      }
    } else {
      // Remind each approver who still owes a signature. Sport-admin reminders fan out
      // to every admin assigned to the sport (1.3), not just the legacy lookup column.
      if (!r.singleApproval && !r.sportAdminSigned) {
        for (const to of sportAdminEmails) {
          await notifyReminder(mailEnv, emailData, to, 'Sport Administrator', escalate);
        }
      }
      if (!r.cfoSigned) {
        for (const to of cfoEmails) {
          await notifyReminder(mailEnv, emailData, to, 'CFO', escalate);
        }
      }
    }

    await env.DB.prepare('UPDATE insurance_requests SET reminder_count = ? WHERE id = ?')
      .bind(attempt, r.id).run();
    await audit(env, r.id, 'REMINDER_SENT', 'system', { status: r.status, attempt, escalated: escalate });
  }
}

/**
 * Retire requests whose term deadline passed while they were still awaiting approval.
 *
 * EXPIRED already had a label, a badge, a dashboard filter, an analytics bucket, and an
 * exclusion in the uq_request_student_term index, but nothing ever set it. Requests sat
 * pending forever and the duplicate guard kept rejecting a corrected resubmission for
 * the same athlete and term. This closes that loop.
 */
async function runExpiry(env: Env): Promise<void> {
  // Work out which terms are past their deadline first, then select only requests in
  // those terms. Taking the oldest N pending rows and filtering them afterwards would
  // starve: if the N oldest are all for future terms, a newer expired request is never
  // reached on any run, so it stays pending forever and keeps blocking resubmission.
  // Whether a term is expired depends on parsing the term string, which SQL cannot do,
  // but the set of distinct pending terms is tiny.
  const { results: terms } = await env.DB.prepare(`
    SELECT DISTINCT term FROM insurance_requests
    WHERE status IN ('PENDING_COACH', 'PENDING_APPROVAL')
  `).all<{ term: string }>();

  const expiredTerms = terms.map(t => t.term).filter(term => !isBeforeDeadline(term));
  if (expiredTerms.length === 0) return;

  const { results } = await env.DB.prepare(`
    SELECT id, term FROM insurance_requests
    WHERE status IN ('PENDING_COACH', 'PENDING_APPROVAL')
      AND term IN (${expiredTerms.map(() => '?').join(',')})
    ORDER BY created_at ASC
    LIMIT ?
  `).bind(...expiredTerms, EXPIRY_BATCH).all<{ id: string; term: string }>();

  const expired = results;
  if (expired.length === 0) return;

  const mailEnv = await getConfiguredEnv(env);
  for (const r of expired) {
    await env.DB.prepare('UPDATE insurance_requests SET status = ? WHERE id = ?')
      .bind('EXPIRED', r.id).run();
    await audit(env, r.id, 'EXPIRED', 'system', { term: r.term, deadline: getSubmissionDeadline(r.term) });

    const d = await loadRequestEmailData(env, r.id);
    if (d) {
      d.status = 'EXPIRED';
      await notifyExpired(mailEnv, d);
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    // Expire first, so a request past its deadline is not also chased for a signature.
    await runExpiry(env);
    await runReminders(env);
  },
};

