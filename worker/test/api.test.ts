import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  resetDatabase, seedUser, seedAdministrator, seedHeadCoach, seedRequest, seedSignature,
  call, anonymousCoachCookie, runScheduled,
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

describe('administrator accounts are visible to the Sports page', () => {
  // sports_programs.sport_admin_id references sport_administrators, but accounts created
  // through the Users page only ever landed in users. The picker reads the former, so a
  // newly created Sport Administrator could not be assigned to any sport.
  it('mirrors a created sport_admin into sport_administrators and lists it', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    const res = await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newadmin@example.edu', password: 'temp-password-1', name: 'New Admin',
        role: 'sport_admin', sportIds: ['womens_golf'],
      }),
    });
    expect(res.status).toBe(201);
    const created = await res.json<{ id: string }>();

    const mirrored = await env.DB.prepare(
      'SELECT id, email, is_cfo FROM sport_administrators WHERE id = ?'
    ).bind(created.id).first<{ id: string; email: string; is_cfo: number }>();
    expect(mirrored).toBeTruthy();
    expect(mirrored!.email).toBe('newadmin@example.edu');
    expect(mirrored!.is_cfo).toBe(0);

    const list = await (await call('/api/admin/sport-admins', { cookie: boss.cookie }))
      .json<{ id: string; name: string }[]>();
    expect(list.map(a => a.id)).toContain(created.id);
  });

  it('flags a created cfo so its sports finalize on one signature', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    const res = await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newcfo@example.edu', password: 'temp-password-1', name: 'New CFO', role: 'cfo',
      }),
    });
    const created = await res.json<{ id: string }>();

    const mirrored = await env.DB.prepare('SELECT is_cfo FROM sport_administrators WHERE id = ?')
      .bind(created.id).first<{ is_cfo: number }>();
    expect(mirrored!.is_cfo).toBe(1);
  });

  it('emails the temporary password to the new account', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newadmin@example.edu', password: 'temp-password-1', name: 'New Admin',
        role: 'sport_admin', sportIds: ['womens_golf'],
      }),
    });

    const logged = await env.DB.prepare(
      'SELECT to_email, template FROM email_log WHERE template = ?'
    ).bind('notifyAccountCreated').first<{ to_email: string; template: string }>();
    expect(logged).toBeTruthy();
    expect(logged!.to_email).toBe('newadmin@example.edu');
  });

  it('detaches sports and removes the mirror when the account is deleted', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const created = await (await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newadmin@example.edu', password: 'temp-password-1', name: 'New Admin',
        role: 'sport_admin', sportIds: ['womens_golf'],
      }),
    })).json<{ id: string }>();

    await env.DB.prepare('UPDATE sports_programs SET sport_admin_id = ? WHERE id = ?')
      .bind(created.id, 'womens_golf').run();

    expect((await call(`/api/admin/users/${created.id}`, { method: 'DELETE', cookie: boss.cookie })).status).toBe(200);

    expect(await env.DB.prepare('SELECT id FROM sport_administrators WHERE id = ?')
      .bind(created.id).first()).toBeNull();
    // Left dangling, the Sports page renders a blank administrator for this sport.
    const sport = await env.DB.prepare('SELECT sport_admin_id FROM sports_programs WHERE id = ?')
      .bind('womens_golf').first<{ sport_admin_id: string | null }>();
    expect(sport!.sport_admin_id).toBeNull();
  });

  it('hides a mirrored administrator once the account is deactivated', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const created = await (await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newadmin@example.edu', password: 'temp-password-1', name: 'New Admin',
        role: 'sport_admin', sportIds: ['womens_golf'],
      }),
    })).json<{ id: string }>();

    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind('rejected', created.id).run();

    const list = await (await call('/api/admin/sport-admins', { cookie: boss.cookie }))
      .json<{ id: string }[]>();
    expect(list.map(a => a.id)).not.toContain(created.id);
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
    // The flag is no longer seeded — it is derived from who administers the sport, so the
    // CFO has to actually be its administrator for one signature to finalize.
    const cfo = await seedAdministrator({
      email: 'cfo@example.edu', role: 'cfo', primaryFor: ['womens_softball'],
    });
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

describe('temporary password gating', () => {
  // The SPA redirects to /change-password, but a redirect only constrains the SPA. The
  // administrator who typed the temporary password knows it, so the API had to enforce
  // this too or either party could keep using the account without replacing it.
  it('refuses API calls until the password is replaced', async () => {
    const user = await seedUser({
      email: 'newhire@example.edu', role: 'cfo', password: 'temp-password-1', mustChangePassword: 1,
    });
    const res = await call('/api/requests', { cookie: user.cookie });
    expect(res.status).toBe(403);
    expect((await res.json<{ error: string }>()).error).toMatch(/set a new password/i);
  });

  it('still allows the routes the change flow needs', async () => {
    const user = await seedUser({
      email: 'newhire@example.edu', role: 'cfo', password: 'temp-password-1', mustChangePassword: 1,
    });
    expect((await call('/auth/me', { cookie: user.cookie })).status).toBe(200);
    expect((await call('/auth/logout', { method: 'POST', cookie: user.cookie })).status).toBe(200);
  });

  it('reports the flag on /auth/me so the SPA can redirect', async () => {
    const user = await seedUser({
      email: 'newhire@example.edu', role: 'cfo', password: 'temp-password-1', mustChangePassword: 1,
    });
    const body = await (await call('/auth/me', { cookie: user.cookie })).json<{ mustChangePassword: number }>();
    expect(body.mustChangePassword).toBe(1);
  });

  it('lets the account through once the password is changed', async () => {
    const user = await seedUser({
      email: 'newhire@example.edu', role: 'cfo', password: 'temp-password-1', mustChangePassword: 1,
    });
    const changed = await call('/auth/password', {
      method: 'PUT',
      cookie: user.cookie,
      body: JSON.stringify({ currentPassword: 'temp-password-1', newPassword: 'chosen-password-1' }),
    });
    expect(changed.status).toBe(200);

    // The change re-issues the cookie at the new token version; use it.
    const refreshed = changed.headers.get('Set-Cookie')!.split(';')[0];
    expect((await call('/api/requests', { cookie: refreshed })).status).toBe(200);
  });

  it('does not gate an account that never had a temporary password', async () => {
    const user = await seedUser({ email: 'normal@example.edu', role: 'cfo' });
    expect((await call('/api/requests', { cookie: user.cookie })).status).toBe(200);
  });
});

describe('single_approval stays in step with the administrator', () => {
  // Backfilling the flag once in the migration is not enough: the Sports admin UI can
  // create a sport or reassign its administrator afterwards, and the flag drifts both ways.
  it('sets the flag when a new sport is created under the CFO', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const cfo = await seedAdministrator({ email: 'cfo@example.edu', role: 'cfo' });
    const res = await call('/api/admin/sports', {
      method: 'POST',
      cookie: superAdmin.cookie,
      body: JSON.stringify({ name: 'Beach Volleyball', gender: 'Womens', sportAdminId: cfo.id }),
    });
    expect(res.status).toBe(201);
    const { id } = await res.json<{ id: string }>();

    const row = await env.DB.prepare('SELECT single_approval FROM sports_programs WHERE id = ?')
      .bind(id).first<{ single_approval: number }>();
    expect(row?.single_approval).toBe(1);
  });

  it('leaves the flag clear for a sport under a non-CFO administrator', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const admin = await seedAdministrator({ email: 'sa@example.edu', role: 'sport_admin' });
    const res = await call('/api/admin/sports', {
      method: 'POST',
      cookie: superAdmin.cookie,
      body: JSON.stringify({ name: 'Wrestling', gender: 'Mens', sportAdminId: admin.id }),
    });
    const { id } = await res.json<{ id: string }>();

    const row = await env.DB.prepare('SELECT single_approval FROM sports_programs WHERE id = ?')
      .bind(id).first<{ single_approval: number }>();
    expect(row?.single_approval).toBe(0);
  });

  it('clears the flag when softball is moved off the CFO', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const cfo = await seedAdministrator({ email: 'cfo@example.edu', role: 'cfo', primaryFor: ['womens_softball'] });
    expect(cfo.id).toBeTruthy();
    const admin = await seedAdministrator({ email: 'sa@example.edu', role: 'sport_admin' });
    await call('/api/admin/sports/womens_softball', {
      method: 'PUT',
      cookie: superAdmin.cookie,
      body: JSON.stringify({ sportAdminId: admin.id }),
    });

    // Otherwise the CFO could still execute alone on a sport they no longer administer.
    const row = await env.DB.prepare("SELECT single_approval FROM sports_programs WHERE id = 'womens_softball'")
      .first<{ single_approval: number }>();
    expect(row?.single_approval).toBe(0);
  });

  it('sets the flag when an existing sport is moved onto the CFO', async () => {
    const superAdmin = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const cfo = await seedAdministrator({ email: 'cfo@example.edu', role: 'cfo' });
    await call('/api/admin/sports/womens_soccer', {
      method: 'PUT',
      cookie: superAdmin.cookie,
      body: JSON.stringify({ sportAdminId: cfo.id }),
    });

    // Otherwise the workflow waits for a second signature from the same person.
    const row = await env.DB.prepare("SELECT single_approval FROM sports_programs WHERE id = 'womens_soccer'")
      .first<{ single_approval: number }>();
    expect(row?.single_approval).toBe(1);
  });
});

describe('expiry sweep', () => {
  it('reaches an expired request behind a batch of unexpired ones', async () => {
    // Selecting the oldest N pending rows and filtering afterwards starves: if the N
    // oldest are all for future terms, a newer expired request is never reached on any
    // run and stays pending forever, still blocking resubmission.
    for (let i = 0; i < 120; i++) {
      await seedRequest({
        term: 'Fall 2099', status: 'PENDING_APPROVAL',
        rocketNumber: `R${String(i).padStart(8, '0')}`, createdAt: '2020-01-01 00:00:00',
      });
    }
    const buried = await seedRequest({
      term: 'Fall 2000', status: 'PENDING_COACH', rocketNumber: 'R99999999',
      createdAt: '2026-01-01 00:00:00',
    });

    await runScheduled();

    const row = await env.DB.prepare('SELECT status FROM insurance_requests WHERE id = ?')
      .bind(buried).first<{ status: string }>();
    expect(row?.status).toBe('EXPIRED');
  });

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

describe('the coach email is required and the head coach is routable', () => {
  // Migration 0006 backfilled the coaches table from the seed with email = '', and the form
  // let a coach pick their name and submit with the field blank and read-only. coach_email
  // landed NULL, notifyCoachSubmitted returned early, and getHeadCoachForSport returned null
  // so step 1 was never sent at all — silently.
  const submit = (cookie: string, body: Record<string, unknown>) =>
    call('/api/requests', { method: 'POST', cookie, body: JSON.stringify(body) });

  const baseRequest = {
    sport: 'womens_soccer', term: 'Fall 2099', coachName: 'Test Coach',
    fundingSource: 'operating_budget',
    athletes: [{ studentName: 'Test Athlete', rocketNumber: 'R00000123' }],
  };

  it('refuses a submission with no coach email', async () => {
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    const res = await submit(coach.cookie, baseRequest);

    expect(res.status).toBe(400);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM insurance_requests').first<{ n: number }>();
    expect(row!.n).toBe(0);
  });

  it('sends the submitting coach their confirmation', async () => {
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    const res = await submit(coach.cookie, { ...baseRequest, coachEmail: 'coach@example.edu' });
    expect(res.status).toBe(201);

    const row = await env.DB.prepare(
      'SELECT to_email FROM email_log WHERE template = ?'
    ).bind('notifyCoachSubmitted').first<{ to_email: string }>();
    expect(row!.to_email).toBe('coach@example.edu');
  });

  it('records that the head coach could not be reached', async () => {
    // The sport has no routable head coach, so step 1 has nowhere to go. That must show up
    // in the delivery log rather than being swallowed.
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    await submit(coach.cookie, { ...baseRequest, coachEmail: 'coach@example.edu' });

    const row = await env.DB.prepare(
      'SELECT status, error FROM email_log WHERE template = ?'
    ).bind('notifyPendingHeadCoach').first<{ status: string; error: string }>();
    expect(row).toBeTruthy();
    expect(row!.status).toBe('failed');
    expect(row!.error).toMatch(/no head coach email/i);
  });

  it('routes to the head coach once an address is on file', async () => {
    await seedHeadCoach('womens_soccer', 'head@example.edu');
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    await submit(coach.cookie, { ...baseRequest, coachEmail: 'coach@example.edu' });

    const row = await env.DB.prepare(
      'SELECT to_email, status FROM email_log WHERE template = ?'
    ).bind('notifyPendingHeadCoach').first<{ to_email: string; status: string }>();
    expect(row!.to_email).toBe('head@example.edu');
    expect(row!.status).not.toBe('failed');
  });

  it('refuses to save a coach with a blank email', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const coachId = await seedHeadCoach('womens_soccer', 'head@example.edu');

    const res = await call(`/api/admin/coaches/${coachId}`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ email: '' }),
    });
    expect(res.status).toBe(400);

    const row = await env.DB.prepare('SELECT email FROM coaches WHERE id = ?')
      .bind(coachId).first<{ email: string }>();
    expect(row!.email).toBe('head@example.edu');
  });

  it('flags sports whose coaches have no address', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    await env.DB.prepare(
      `INSERT INTO coaches (id, display_name, email, sport_id, title, is_head_coach)
       VALUES ('c_blank', 'No Address', '', 'womens_soccer', 'Head Coach', 1)`
    ).run();

    const sports = await (await call('/api/sports', { cookie: boss.cookie }))
      .json<{ id: string; coachesMissingEmail: number }[]>();
    expect(sports.find(s => s.id === 'womens_soccer')!.coachesMissingEmail).toBe(1);
    expect(sports.find(s => s.id === 'mens_golf')!.coachesMissingEmail).toBe(0);
  });

  it('skips a CSV row with no coach email instead of creating it', async () => {
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    const res = await call('/api/requests/bulk', {
      method: 'POST', cookie: coach.cookie,
      body: JSON.stringify({
        rows: [{
          sport: 'womens_soccer', term: 'Fall 2099', studentName: 'Test Athlete',
          rocketNumber: 'R00000456', fundingSource: 'operating_budget',
        }],
      }),
    });

    const body = await res.json<{ skipped: { reason: string }[]; created?: unknown[] }>();
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toMatch(/coach email/i);
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM insurance_requests').first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe('turnover is serviceable without SQL', () => {
  // sport_administrators had no UPDATE path anywhere in the codebase and no status column,
  // so a departed administrator kept receiving student-athlete notifications forever.
  it('drops a deactivated sport administrator from the fan-out', async () => {
    const admin = await seedAdministrator({
      email: 'sa@example.edu', role: 'sport_admin', primaryFor: ['womens_soccer'], sportIds: ['womens_soccer'],
    });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    const res = await call(`/api/admin/users/${admin.id}/status`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ status: 'inactive' }),
    });
    expect(res.status).toBe(200);

    const id = await seedRequest({ sport: 'womens_soccer', status: 'PENDING_APPROVAL' });
    await seedSignature(id, 'COACH');
    await call(`/api/requests/${id}/sign`, {
      method: 'POST', cookie: (await seedUser({ email: 'cfo@example.edu', role: 'cfo' })).cookie, body: '{}',
    });

    const { results } = await env.DB.prepare('SELECT DISTINCT to_email FROM email_log').all<{ to_email: string }>();
    expect(results.map(r => r.to_email)).not.toContain('sa@example.edu');
  });

  it('stops a deactivated CFO finalizing a request alone', async () => {
    const cfo = await seedAdministrator({
      email: 'cfo@example.edu', role: 'cfo', primaryFor: ['womens_softball'],
    });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    expect((await env.DB.prepare("SELECT single_approval AS s FROM sports_programs WHERE id = 'womens_softball'")
      .first<{ s: number }>())!.s).toBe(1);

    await call(`/api/admin/users/${cfo.id}/status`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ status: 'inactive' }),
    });

    const row = await env.DB.prepare("SELECT single_approval AS s FROM sports_programs WHERE id = 'womens_softball'")
      .first<{ s: number }>();
    expect(row!.s).toBe(0);
  });

  it('renames an administrator everywhere at once', async () => {
    const admin = await seedAdministrator({
      email: 'old@example.edu', role: 'sport_admin', name: 'Old Name', primaryFor: ['womens_soccer'],
    });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    const res = await call(`/api/admin/users/${admin.id}`, {
      method: 'PUT', cookie: boss.cookie,
      body: JSON.stringify({ name: 'New Name', email: 'new@example.edu' }),
    });
    expect(res.status).toBe(200);

    const sports = await (await call('/api/sports', { cookie: boss.cookie }))
      .json<{ id: string; sportAdminName: string; sportAdminEmail: string }[]>();
    const soccer = sports.find(s => s.id === 'womens_soccer')!;
    expect(soccer.sportAdminName).toBe('New Name');
    expect(soccer.sportAdminEmail).toBe('new@example.edu');
  });

  it('refuses a duplicate email and an edit above your own rank', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const taken = await seedUser({ email: 'taken@example.edu', role: 'coach' });
    const other = await seedUser({ email: 'other@example.edu', role: 'coach' });

    expect((await call(`/api/admin/users/${other.id}`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ email: taken.email }),
    })).status).toBe(409);

    // isAdmin() includes cfo, so without the rank guard a CFO could rewrite a Super Admin.
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    expect((await call(`/api/admin/users/${boss.id}`, {
      method: 'PUT', cookie: cfo.cookie, body: JSON.stringify({ name: 'Hijacked' }),
    })).status).toBe(403);

    // ...nor grant a role at or above their own.
    expect((await call(`/api/admin/users/${other.id}`, {
      method: 'PUT', cookie: cfo.cookie, body: JSON.stringify({ role: 'super_admin' }),
    })).status).toBe(403);
  });

  it('detaches sports when an administrator is demoted', async () => {
    const admin = await seedAdministrator({
      email: 'sa@example.edu', role: 'sport_admin', primaryFor: ['womens_soccer'], sportIds: ['womens_soccer'],
    });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    await call(`/api/admin/users/${admin.id}`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ role: 'coach' }),
    });

    const sport = await env.DB.prepare("SELECT sport_admin_id FROM sports_programs WHERE id = 'womens_soccer'")
      .first<{ sport_admin_id: string | null }>();
    expect(sport!.sport_admin_id).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM sport_administrators WHERE id = ?')
      .bind(admin.id).first()).toBeNull();
    expect(await env.DB.prepare('SELECT id FROM sport_admin_assignments WHERE admin_user_id = ?')
      .bind(admin.id).first()).toBeNull();
  });

  it('resets a password on the account holder\'s behalf', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const target = await seedUser({ email: 'coach@example.edu', role: 'coach' });

    const res = await call(`/api/admin/users/${target.id}/reset-password`, {
      method: 'POST', cookie: boss.cookie, body: JSON.stringify({ mode: 'temp' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ temporaryPassword: string }>();
    expect(body.temporaryPassword).toBeTruthy();

    const row = await env.DB.prepare('SELECT must_change_password AS m, token_version AS tv FROM users WHERE id = ?')
      .bind(target.id).first<{ m: number; tv: number }>();
    expect(row!.m).toBe(1);         // the /api/* gate is re-armed
    expect(row!.tv).toBe(1);        // and any live session is dead
    expect((await call('/auth/me', { cookie: target.cookie })).status).toBe(401);
  });

  it('keeps at least one active Super Admin', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const other = await seedUser({ email: 'other@example.edu', role: 'super_admin' });

    // Demoting the last one would lock everyone out of the portal permanently.
    expect((await call(`/api/admin/users/${other.id}`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ role: 'coach' }),
    })).status).toBe(403);   // rank guard fires first: equal rank

    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(other.id).run();
    expect((await call(`/api/admin/users/${boss.id}`, {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ role: 'coach' }),
    })).status).toBe(409);
  });
});
