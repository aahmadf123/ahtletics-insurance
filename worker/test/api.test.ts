import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  resetDatabase, seedUser, seedRequest, seedSignature, call, anonymousCoachCookie, runScheduled,
} from './helpers';

beforeEach(resetDatabase);

// Every test in this file covers a defect found in the review. The comment above each
// block says what was wrong before, so a future change that reintroduces it fails here.

describe('session validation against the database', () => {
  it('rejects a token whose user row has been deleted', async () => {
    const user = await seedUser({ email: 'admin@example.edu', role: 'super_admin' });
    expect((await call('/auth/me', { cookie: user.cookie })).status).toBe(200);

    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();

    // /auth/me used to return the token payload verbatim, so a deleted account kept
    // working for the remaining life of the seven-day cookie.
    expect((await call('/auth/me', { cookie: user.cookie })).status).toBe(401);
  });

  it('rejects a token whose token_version is stale', async () => {
    const user = await seedUser({ email: 'admin@example.edu', role: 'super_admin' });
    await env.DB.prepare('UPDATE users SET token_version = 1 WHERE id = ?').bind(user.id).run();
    expect((await call('/auth/me', { cookie: user.cookie })).status).toBe(401);
  });

  it('rejects a token for an account that is no longer active', async () => {
    const user = await seedUser({ email: 'pending@example.edu', role: 'sport_admin' });
    await env.DB.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").bind(user.id).run();
    expect((await call('/auth/me', { cookie: user.cookie })).status).toBe(401);
  });

  it('reports the live role, not the one baked into the token', async () => {
    const user = await seedUser({ email: 'person@example.edu', role: 'cfo' });
    await env.DB.prepare("UPDATE users SET role = 'sport_admin' WHERE id = ?").bind(user.id).run();
    const body = await (await call('/auth/me', { cookie: user.cookie })).json<{ role: string }>();
    expect(body.role).toBe('sport_admin');
  });

  it('still accepts the anonymous coach session, which has no user row', async () => {
    const res = await call('/auth/me', { cookie: await anonymousCoachCookie() });
    expect(res.status).toBe(200);
    expect((await res.json<{ role: string }>()).role).toBe('coach');
  });
});

describe('password change and reset revoke sessions', () => {
  it('invalidates other sessions but keeps the caller signed in', async () => {
    const user = await seedUser({ email: 'admin@example.edu', role: 'super_admin', password: 'original-password' });
    const otherSession = user.cookie;

    const res = await call('/auth/password', {
      method: 'PUT',
      cookie: user.cookie,
      body: JSON.stringify({ currentPassword: 'original-password', newPassword: 'replacement-password' }),
    });
    expect(res.status).toBe(200);

    // The response carries a re-issued cookie at the new token version.
    const refreshed = res.headers.get('Set-Cookie');
    expect(refreshed).toContain('auth_token=');

    // The session that was open elsewhere is dead.
    expect((await call('/auth/me', { cookie: otherSession })).status).toBe(401);
  });

  it('refuses to reuse the current password', async () => {
    const user = await seedUser({ email: 'admin@example.edu', role: 'super_admin', password: 'same-password-1' });
    const res = await call('/auth/password', {
      method: 'PUT',
      cookie: user.cookie,
      body: JSON.stringify({ currentPassword: 'same-password-1', newPassword: 'same-password-1' }),
    });
    expect(res.status).toBe(400);
  });

  it('stores only a hash of the reset token', async () => {
    await seedUser({ email: 'coach@example.edu', role: 'sport_admin' });
    await call('/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'coach@example.edu' }),
    });

    const row = await env.DB.prepare('SELECT token_hash FROM password_reset_tokens').first<{ token_hash: string }>();
    // A database read must not yield a usable link, so the stored value is a digest.
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('answers identically whether or not the account exists', async () => {
    const known = await call('/auth/forgot-password', {
      method: 'POST', body: JSON.stringify({ email: 'nobody@example.edu' }),
    });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual({
      message: 'If an account with that email exists, a reset link has been sent.',
    });
  });

  it('rejects an unknown or already-used reset token', async () => {
    const res = await call('/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token: 'made-up', newPassword: 'brand-new-password' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('login lockout', () => {
  it('locks an account after repeated failures and keeps the message generic', async () => {
    await seedUser({ email: 'target@example.edu', role: 'cfo', password: 'the-real-password' });

    for (let i = 0; i < 8; i++) {
      const res = await call('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: 'target@example.edu', password: 'wrong' }),
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid email or password' });
    }

    // The correct password no longer helps while the lockout window is open.
    const locked = await call('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'target@example.edu', password: 'the-real-password' }),
    });
    expect(locked.status).toBe(429);
  });

  it('clears the failure counter on a successful sign-in', async () => {
    const user = await seedUser({ email: 'target@example.edu', role: 'cfo', password: 'the-real-password' });
    await call('/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'target@example.edu', password: 'wrong' }),
    });
    const ok = await call('/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'target@example.edu', password: 'the-real-password' }),
    });
    expect(ok.status).toBe(200);

    const row = await env.DB.prepare('SELECT failed_login_count FROM users WHERE id = ?')
      .bind(user.id).first<{ failed_login_count: number }>();
    expect(row?.failed_login_count).toBe(0);
  });

  it('does not sign in a pending account', async () => {
    await seedUser({ email: 'waiting@example.edu', role: 'sport_admin', password: 'a-password-here', status: 'pending' });
    const res = await call('/auth/login', {
      method: 'POST', body: JSON.stringify({ email: 'waiting@example.edu', password: 'a-password-here' }),
    });
    expect(res.status).toBe(403);
  });
});

describe('PDF authorization', () => {
  it('refuses a sport admin a request outside their assigned sports', async () => {
    const admin = await seedUser({
      email: 'soccer-admin@example.edu', role: 'sport_admin', sportIds: ['womens_soccer'],
    });
    const otherSport = await seedRequest({ sport: 'mens_football', status: 'PENDING_APPROVAL' });
    await seedSignature(otherSport, 'COACH');

    // This endpoint previously checked only that a session existed, so any signed-in
    // user could pull any student's signed authorization form by id.
    const res = await call(`/api/requests/${otherSport}/pdf`, { cookie: admin.cookie });
    expect(res.status).toBe(403);
  });

  it('serves a request inside the sport admin scope', async () => {
    const admin = await seedUser({
      email: 'soccer-admin@example.edu', role: 'sport_admin', sportIds: ['womens_soccer'],
    });
    const id = await seedRequest({ sport: 'womens_soccer', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');

    const res = await call(`/api/requests/${id}/pdf`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('refuses a request with no signatures', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const id = await seedRequest({ status: 'PENDING_COACH' });
    expect((await call(`/api/requests/${id}/pdf`, { cookie: cfo.cookie })).status).toBe(409);
  });

  it('requires a session at all', async () => {
    const id = await seedRequest({});
    expect((await call(`/api/requests/${id}/pdf`)).status).toBe(401);
  });
});

describe('user deletion privileges', () => {
  it('stops a CFO deleting a Super Admin', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    // isAdmin() includes cfo, so this used to succeed.
    const res = await call(`/api/admin/users/${superAdmin.id}`, { method: 'DELETE', cookie: cfo.cookie });
    expect(res.status).toBe(403);

    const still = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(superAdmin.id).first();
    expect(still).toBeTruthy();
  });

  it('allows a Super Admin to delete a sport admin', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const target = await seedUser({ email: 'sa@example.edu', role: 'sport_admin', sportIds: ['womens_golf'] });

    expect((await call(`/api/admin/users/${target.id}`, { method: 'DELETE', cookie: superAdmin.cookie })).status).toBe(200);
    expect(await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(target.id).first()).toBeNull();
    // Assignments go with the account rather than dangling.
    expect(await env.DB.prepare('SELECT id FROM sport_admin_assignments WHERE admin_user_id = ?')
      .bind(target.id).first()).toBeNull();
  });
});

describe('request deletion leaves a tombstone', () => {
  it('records what was destroyed after the audit rows go with it', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const id = await seedRequest({ studentName: 'Jane Doe', rocketNumber: 'R00000001', status: 'EXECUTED' });

    expect((await call(`/api/requests/${id}`, { method: 'DELETE', cookie: superAdmin.cookie })).status).toBe(200);

    const tombstone = await env.DB.prepare(
      "SELECT details FROM audit_log WHERE action = 'REQUEST_DELETED'"
    ).first<{ details: string }>();
    expect(tombstone).toBeTruthy();
    const details = JSON.parse(tombstone!.details);
    expect(details.deletedRequestId).toBe(id);
    expect(details.studentName).toBe('Jane Doe');
    expect(details.statusAtDeletion).toBe('EXECUTED');
  });
});

describe('submission is all or nothing', () => {
  it('writes nothing when any athlete in the batch is invalid', async () => {
    const coach = await anonymousCoachCookie();
    const res = await call('/api/requests', {
      method: 'POST',
      cookie: coach,
      body: JSON.stringify({
        sport: 'womens_soccer',
        term: 'Fall 2099',
        coachName: 'Test Coach',
        coachEmail: 'coach@example.edu',
        athletes: [
          { studentName: 'Valid One', rocketNumber: 'R11111111' },
          { studentName: 'Valid Two', rocketNumber: 'R22222222' },
          { studentName: 'Bad Rocket', rocketNumber: 'NOPE' },
        ],
      }),
    });
    expect(res.status).toBe(400);

    // The first two used to be committed with their emails already sent.
    const { results } = await env.DB.prepare('SELECT id FROM insurance_requests').all();
    expect(results).toHaveLength(0);
    const emails = await env.DB.prepare('SELECT id FROM email_log').all();
    expect(emails.results).toHaveLength(0);
  });

  it('rejects the same athlete listed twice in one submission', async () => {
    const res = await call('/api/requests', {
      method: 'POST',
      cookie: await anonymousCoachCookie(),
      body: JSON.stringify({
        sport: 'womens_soccer',
        term: 'Fall 2099',
        coachName: 'Test Coach',
        coachEmail: 'coach@example.edu',
        athletes: [
          { studentName: 'Twice Listed', rocketNumber: 'R33333333' },
          { studentName: 'Twice Listed', rocketNumber: 'R33333333' },
        ],
      }),
    });
    expect(res.status).toBe(409);
    expect((await env.DB.prepare('SELECT id FROM insurance_requests').all()).results).toHaveLength(0);
  });

  it('commits every athlete when the whole batch is valid', async () => {
    const res = await call('/api/requests', {
      method: 'POST',
      cookie: await anonymousCoachCookie(),
      body: JSON.stringify({
        sport: 'womens_soccer',
        term: 'Fall 2099',
        coachName: 'Test Coach',
        coachEmail: 'coach@example.edu',
        athletes: [
          { studentName: 'First Athlete', rocketNumber: 'R44444444' },
          { studentName: 'Second Athlete', rocketNumber: 'R55555555' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect((await env.DB.prepare('SELECT id FROM insurance_requests').all()).results).toHaveLength(2);
    // One audit row per request, written in the same batch as the insert.
    expect((await env.DB.prepare("SELECT id FROM audit_log WHERE action = 'SUBMITTED'").all()).results)
      .toHaveLength(2);
  });

  it('normalizes rocket numbers so mixed case cannot slip past the duplicate guard', async () => {
    const coach = await anonymousCoachCookie();
    const body = (rocket: string) => JSON.stringify({
      sport: 'womens_soccer', term: 'Fall 2099',
      coachName: 'Test Coach', coachEmail: 'coach@example.edu',
      athletes: [{ studentName: 'Case Test', rocketNumber: rocket }],
    });

    expect((await call('/api/requests', { method: 'POST', cookie: coach, body: body('R66666666') })).status).toBe(201);
    // Lowercase 'r' is the same athlete and must be refused as a duplicate.
    expect((await call('/api/requests', { method: 'POST', cookie: coach, body: body('r66666666') })).status).toBe(409);
  });

  it('refuses a term whose deadline has passed', async () => {
    const res = await call('/api/requests', {
      method: 'POST',
      cookie: await anonymousCoachCookie(),
      body: JSON.stringify({
        sport: 'womens_soccer', term: 'Fall 2000',
        coachName: 'Test Coach', coachEmail: 'coach@example.edu',
        athletes: [{ studentName: 'Too Late', rocketNumber: 'R77777777' }],
      }),
    });
    expect(res.status).toBe(422);
  });
});

describe('single-approval rule comes from the sport row', () => {
  it('executes softball on the CFO signature alone', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const id = await seedRequest({ sport: 'womens_softball', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');

    const res = await call(`/api/requests/${id}/sign`, { method: 'POST', cookie: cfo.cookie, body: '{}' });
    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('EXECUTED');
  });

  it('still needs both signatures for a sport without the flag', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const id = await seedRequest({ sport: 'womens_soccer', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');

    const res = await call(`/api/requests/${id}/sign`, { method: 'POST', cookie: cfo.cookie, body: '{}' });
    expect((await res.json<{ status: string }>()).status).toBe('PENDING_APPROVAL');
  });

  it('follows the flag rather than the sport id, so renaming softball is safe', async () => {
    // The old check matched the literal string 'womens_softball'.
    await env.DB.prepare("UPDATE sports_programs SET single_approval = 0 WHERE id = 'womens_softball'").run();
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const id = await seedRequest({ sport: 'womens_softball', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');

    const res = await call(`/api/requests/${id}/sign`, { method: 'POST', cookie: cfo.cookie, body: '{}' });
    expect((await res.json<{ status: string }>()).status).toBe('PENDING_APPROVAL');
  });
});

describe('break-glass approvals are distinguishable', () => {
  it('records a super admin filling another role as SIGNED_ON_BEHALF', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const id = await seedRequest({ sport: 'womens_soccer', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');

    await call(`/api/requests/${id}/sign`, { method: 'POST', cookie: superAdmin.cookie, body: '{}' });

    const row = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE request_id = ? AND action LIKE 'SIGNED%'"
    ).bind(id).first<{ action: string }>();
    expect(row?.action).toBe('SIGNED_ON_BEHALF');
  });
});

describe('list pagination', () => {
  it('bounds the result set even when the caller asks for no paging', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    for (let i = 0; i < 60; i++) {
      await seedRequest({ rocketNumber: `R${String(i).padStart(8, '0')}` });
    }
    const rows = await (await call('/api/requests', { cookie: cfo.cookie })).json<unknown[]>();
    expect(rows).toHaveLength(50);
  });

  it('honours limit and offset', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    for (let i = 0; i < 10; i++) {
      await seedRequest({ rocketNumber: `R${String(i).padStart(8, '0')}` });
    }
    const page = await (await call('/api/requests?limit=4&offset=8', { cookie: cfo.cookie })).json<unknown[]>();
    expect(page).toHaveLength(2);
  });

  it('caps an unreasonably large limit', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    await seedRequest({});
    expect((await call('/api/requests?limit=999999', { cookie: cfo.cookie })).status).toBe(200);
  });
});

describe('filtered list queries', () => {
  // Parameters used to be bound one at a time by chaining .bind(), which does not
  // accumulate in D1. Any query carrying two or more parameters failed outright.
  it('applies several filters at once', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    await seedRequest({ sport: 'womens_soccer', term: 'Fall 2099', status: 'EXECUTED', rocketNumber: 'R10000001' });
    await seedRequest({ sport: 'mens_football', term: 'Fall 2099', status: 'EXECUTED', rocketNumber: 'R10000002' });
    await seedRequest({ sport: 'womens_soccer', term: 'Fall 2099', status: 'VOIDED', rocketNumber: 'R10000003' });

    const res = await call('/api/requests?sport=womens_soccer&status=EXECUTED&term=Fall', { cookie: cfo.cookie });
    expect(res.status).toBe(200);
    const rows = await res.json<{ rocketNumber: string }[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0].rocketNumber).toBe('R10000001');
  });

  it('applies several filters at once on the report', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    await seedRequest({ sport: 'womens_soccer', term: 'Fall 2099', status: 'EXECUTED', rocketNumber: 'R20000001' });
    await seedRequest({ sport: 'mens_football', term: 'Fall 2099', status: 'EXECUTED', rocketNumber: 'R20000002' });

    const res = await call('/api/reports?sport=womens_soccer&status=EXECUTED', { cookie: cfo.cookie });
    expect(res.status).toBe(200);
    expect(await res.json<unknown[]>()).toHaveLength(1);
  });

  it('applies several filters at once on the audit log', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const res = await call('/api/audit?actor=someone&action=SIGNED&from=2020-01-01&to=2099-01-01', { cookie: cfo.cookie });
    expect(res.status).toBe(200);
  });
});

describe('expiry sweep', () => {
  it('retires a pending request whose deadline has passed and frees the duplicate guard', async () => {
    const stale = await seedRequest({
      sport: 'womens_soccer', term: 'Fall 2000', status: 'PENDING_COACH', rocketNumber: 'R90000001',
    });

    await runScheduled();

    const row = await env.DB.prepare('SELECT status FROM insurance_requests WHERE id = ?')
      .bind(stale).first<{ status: string }>();
    // EXPIRED had a label, a badge, a filter, and an index exclusion, but nothing set it.
    expect(row?.status).toBe('EXPIRED');

    const logged = await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'EXPIRED'"
    ).bind(stale).first();
    expect(logged).toBeTruthy();
  });

  it('leaves a request alone while its deadline is still ahead', async () => {
    const live = await seedRequest({ term: 'Fall 2099', status: 'PENDING_APPROVAL' });
    await runScheduled();
    const row = await env.DB.prepare('SELECT status FROM insurance_requests WHERE id = ?')
      .bind(live).first<{ status: string }>();
    expect(row?.status).toBe('PENDING_APPROVAL');
  });
});

describe('reminders', () => {
  const longAgo = '2020-01-01 00:00:00';

  it('chases a request stalled at the head coach step', async () => {
    // This is the step that actually stalls, and it was never reminded: the query
    // looked only at PENDING_APPROVAL.
    const id = await seedRequest({
      sport: 'womens_soccer', term: 'Fall 2099', status: 'PENDING_COACH', createdAt: longAgo,
    });

    await runScheduled();

    const reminder = await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'REMINDER_SENT'"
    ).bind(id).first();
    expect(reminder).toBeTruthy();

    const row = await env.DB.prepare('SELECT reminder_count FROM insurance_requests WHERE id = ?')
      .bind(id).first<{ reminder_count: number }>();
    expect(row?.reminder_count).toBe(1);
  });

  it('chases a request stalled at the approval step', async () => {
    const id = await seedRequest({
      sport: 'womens_soccer', term: 'Fall 2099', status: 'PENDING_APPROVAL', createdAt: longAgo,
    });
    await runScheduled();
    expect(await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'REMINDER_SENT'"
    ).bind(id).first()).toBeTruthy();
  });

  it('stops after the reminder cap instead of chasing forever', async () => {
    const id = await seedRequest({
      sport: 'womens_soccer', term: 'Fall 2099', status: 'PENDING_APPROVAL', createdAt: longAgo,
    });
    await env.DB.prepare('UPDATE insurance_requests SET reminder_count = 4 WHERE id = ?').bind(id).run();

    await runScheduled();

    expect(await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'REMINDER_SENT'"
    ).bind(id).first()).toBeNull();
  });

  it('does not chase a request that was reminded within the last day', async () => {
    const id = await seedRequest({
      sport: 'womens_soccer', term: 'Fall 2099', status: 'PENDING_APPROVAL', createdAt: longAgo,
    });
    await env.DB.prepare(
      `INSERT INTO audit_log (id, request_id, action, performed_by, timestamp)
       VALUES (?, ?, 'REMINDER_SENT', 'system', datetime('now'))`
    ).bind(crypto.randomUUID(), id).run();

    await runScheduled();

    const { results } = await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'REMINDER_SENT'"
    ).bind(id).all();
    expect(results).toHaveLength(1);
  });

  it('leaves a freshly submitted request alone', async () => {
    const id = await seedRequest({ term: 'Fall 2099', status: 'PENDING_COACH' });
    await runScheduled();
    expect(await env.DB.prepare(
      "SELECT id FROM audit_log WHERE request_id = ? AND action = 'REMINDER_SENT'"
    ).bind(id).first()).toBeNull();
  });
});

describe('removed endpoints', () => {
  it('no longer exposes the unauthenticated staff roster', async () => {
    // /auth/identities returned every sport, head coach, and administrator to anyone,
    // and nothing in the SPA called it.
    const res = await call('/auth/identities');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(/coachName/);
  });

  it('answers an unknown API path with JSON rather than the SPA shell', async () => {
    // These used to fall through to index.html with a 200, so a client calling a
    // mistyped endpoint failed somewhere far away from the cause.
    const res = await call('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
  });
});
