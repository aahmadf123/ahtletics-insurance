import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env } from 'cloudflare:test';
import {
  resetDatabase, seedUser, seedAdministrator, seedHeadCoach, call,
  enableResend, disableResend, setSettings,
} from './helpers';

beforeEach(resetDatabase);

// Exercising the portal used to mean mailing whoever the seed data pointed at. A test
// submission reached two real staff members and the hourly reminder chased them again two
// days later. Every test here covers one way that must now be impossible.

type SentMessage = { to: string[]; subject: string; html: string; text: string };

/** Capture what would have gone to the provider, without letting anything leave. */
function interceptResend(): SentMessage[] {
  const calls: SentMessage[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://api.resend.com/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      calls.push({ to: body.to, subject: body.subject, html: body.html, text: body.text });
      return new Response(JSON.stringify({ id: 'test-message-id' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return real(input as RequestInfo, init);
  }) as typeof fetch;
  return calls;
}

/**
 * Drive one real send through the ordinary notification path.
 *
 * Deliberately NOT /auth/forgot-password: that route is rateLimit(5, 60) and the limiter is
 * per-isolate, which vitest.config.ts pins with singleWorker — so a sixth call anywhere in
 * this file would silently 429 and read as a suppressed send.
 */
async function triggerAccountCreated(email: string): Promise<void> {
  const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
  await call('/api/admin/users', {
    method: 'POST', cookie: boss.cookie,
    body: JSON.stringify({
      email, password: 'temp-password-1', name: 'New Admin',
      role: 'sport_admin', sportIds: ['womens_golf'],
    }),
  });
}

describe('mail safety mode', () => {
  beforeEach(enableResend);
  afterEach(disableResend);

  it('suppress sends nothing and records who it was for', async () => {
    // The test that would have caught the 29 July incident.
    const calls = interceptResend();
    await setSettings({ mail_mode: 'suppress' });

    await triggerAccountCreated('newadmin@example.edu');

    expect(calls).toHaveLength(0);
    const row = await env.DB.prepare(
      'SELECT to_email, status, error, redirected_to FROM email_log WHERE template = ?'
    ).bind('notifyAccountCreated').first<{ to_email: string; status: string; error: string; redirected_to: string | null }>();
    expect(row).toBeTruthy();
    expect(row!.status).toBe('suppressed');
    expect(row!.to_email).toBe('newadmin@example.edu');
    expect(row!.redirected_to).toBeNull();
  });

  it('redirect rewrites the envelope but still logs the intended recipient', async () => {
    const calls = interceptResend();
    await setSettings({ mail_mode: 'redirect', mail_test_address: 'tester@example.test' });

    await triggerAccountCreated('newadmin@example.edu');

    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual(['tester@example.test']);
    // The tester needs to know who it was really for, in the subject and in the body.
    expect(calls[0].subject).toContain('[TEST → newadmin@example.edu]');
    expect(calls[0].html).toContain('newadmin@example.edu');
    expect(calls[0].text).toContain('TEST MODE');

    const row = await env.DB.prepare(
      'SELECT to_email, status, redirected_to FROM email_log WHERE template = ?'
    ).bind('notifyAccountCreated').first<{ to_email: string; status: string; redirected_to: string }>();
    expect(row!.to_email).toBe('newadmin@example.edu');   // who it was about
    expect(row!.redirected_to).toBe('tester@example.test'); // where it went
    expect(row!.status).toBe('sent');
  });

  it('redirect with no valid test address fails closed rather than open', async () => {
    const calls = interceptResend();
    await setSettings({ mail_mode: 'redirect', mail_test_address: '' });

    await triggerAccountCreated('newadmin@example.edu');

    expect(calls).toHaveLength(0);
    const row = await env.DB.prepare('SELECT status, error FROM email_log WHERE template = ?')
      .bind('notifyAccountCreated').first<{ status: string; error: string }>();
    expect(row!.status).toBe('suppressed');
    expect(row!.error).toMatch(/no valid test address/i);
  });

  it('a locked environment beats app_settings', async () => {
    // Proves the preview lock cannot be undone by restoring a production database.
    const calls = interceptResend();
    await setSettings({ mail_mode: 'live' });
    (env as { MAIL_LOCKED_MODE?: string }).MAIL_LOCKED_MODE = 'suppress';
    try {
      await triggerAccountCreated('newadmin@example.edu');
      expect(calls).toHaveLength(0);
    } finally {
      delete (env as { MAIL_LOCKED_MODE?: string }).MAIL_LOCKED_MODE;
    }
  });

  it('a lapsed expiry reverts to live', async () => {
    const calls = interceptResend();
    await setSettings({
      mail_mode: 'suppress',
      mail_mode_expires_at: new Date(Date.now() - 3600_000).toISOString(),
    });

    await triggerAccountCreated('newadmin@example.edu');

    // Test mode is not a state you can leave on by forgetting about it.
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toEqual(['newadmin@example.edu']);
  });

  it('no template can bypass the mode', async () => {
    // forgot-password carries no requestId and admin/users is a different call path, so
    // between them they cover both shapes. A template added later that does not route
    // through sendEmail would fail here.
    const calls = interceptResend();
    await setSettings({ mail_mode: 'suppress' });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });

    await seedUser({ email: 'coach@example.edu', role: 'coach' });
    await call('/auth/forgot-password', {
      method: 'POST', body: JSON.stringify({ email: 'coach@example.edu' }),
    });
    await call('/api/admin/users', {
      method: 'POST', cookie: boss.cookie,
      body: JSON.stringify({
        email: 'newadmin@example.edu', password: 'temp-password-1', name: 'New Admin',
        role: 'sport_admin', sportIds: ['womens_golf'],
      }),
    });

    expect(calls).toHaveLength(0);
    const { results } = await env.DB.prepare(
      "SELECT DISTINCT template FROM email_log WHERE status = 'suppressed'"
    ).all<{ template: string }>();
    expect(results.map(r => r.template).sort()).toEqual(['notifyAccountCreated', 'notifyPasswordReset']);
  });

  it('holds across the whole approval fan-out', async () => {
    const calls = interceptResend();
    await setSettings({ mail_mode: 'suppress' });
    await seedAdministrator({ email: 'sa@example.edu', role: 'sport_admin', primaryFor: ['womens_soccer'] });
    await seedAdministrator({ email: 'cfo@example.edu', role: 'cfo' });
    await seedHeadCoach('womens_soccer', 'head@example.edu');
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });

    const res = await call('/api/requests', {
      method: 'POST', cookie: coach.cookie,
      body: JSON.stringify({
        sport: 'womens_soccer', term: 'Fall 2099', coachName: 'Coach', coachEmail: 'coach@example.edu',
        fundingSource: 'operating_budget',
        athletes: [{ studentName: 'Test Athlete', rocketNumber: 'R00000123', email: 'a@rockets.utoledo.edu' }],
      }),
    });
    expect(res.status).toBe(201);

    expect(calls).toHaveLength(0);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM email_log WHERE status <> 'suppressed'"
    ).first<{ n: number }>();
    expect(row!.n).toBe(0);
  });
});

describe('who may change the mail mode', () => {
  it('refuses a CFO, an unknown mode, and a redirect with no address', async () => {
    const cfo = await seedUser({ email: 'cfo@example.edu', role: 'cfo' });
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    const base = {
      fromName: 'Portal', fromEmail: 'noreply@example.test', appBaseUrl: 'https://example.test',
    };

    expect((await call('/api/admin/settings', {
      method: 'PUT', cookie: cfo.cookie, body: JSON.stringify({ ...base, mailMode: 'suppress' }),
    })).status).toBe(403);

    expect((await call('/api/admin/settings', {
      method: 'PUT', cookie: boss.cookie, body: JSON.stringify({ ...base, mailMode: 'off' }),
    })).status).toBe(400);

    // Storing a redirect that cannot be delivered would silently mean suppress.
    expect((await call('/api/admin/settings', {
      method: 'PUT', cookie: boss.cookie,
      body: JSON.stringify({ ...base, mailMode: 'redirect', mailTestAddress: 'not-an-email' }),
    })).status).toBe(400);
  });

  it('records a mode change in the audit log', async () => {
    const boss = await seedUser({ email: 'boss@example.edu', role: 'super_admin' });
    await call('/api/admin/settings', {
      method: 'PUT', cookie: boss.cookie,
      body: JSON.stringify({
        fromName: 'Portal', fromEmail: 'noreply@example.test', appBaseUrl: 'https://example.test',
        mailMode: 'suppress',
      }),
    });

    const row = await env.DB.prepare("SELECT performed_by FROM audit_log WHERE action = 'MAIL_MODE_CHANGED'")
      .first<{ performed_by: string }>();
    expect(row!.performed_by).toBe('boss@example.edu');
  });

  it('tells every signed-in user, not just admins', async () => {
    // The coach who submits and hears nothing is best placed to notice.
    await setSettings({ mail_mode: 'suppress' });
    const coach = await seedUser({ email: 'coach@example.edu', role: 'coach' });
    const me = await (await call('/auth/me', { cookie: coach.cookie }))
      .json<{ mailMode: string; mailTestAddress: string }>();
    expect(me.mailMode).toBe('suppress');
    // ...but the test address is only for those who can act on it.
    expect(me.mailTestAddress).toBe('');
  });
});
