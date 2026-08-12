import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import {
  getAdminSettings, updateAdminSettings, sendTestEmail,
  type MailMode, type MailPolicy,
} from '../../lib/api';

/** Duration choices for test mode. Leaving it on indefinitely has to be deliberate. */
const EXPIRY_CHOICES: { label: string; hours: number | null }[] = [
  { label: '2 hours', hours: 2 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'No expiry', hours: null },
];

const MODE_COPY: Record<MailMode, { title: string; detail: string }> = {
  live: {
    title: 'Live',
    detail: 'Notifications are delivered to the people named on each request.',
  },
  redirect: {
    title: 'Redirect to a test address',
    detail: 'Every message goes to one address instead, with the intended recipients named '
      + 'in the subject and body. The delivery log still records who it was for. Use this to '
      + 'rehearse a full request without contacting anyone.',
  },
  suppress: {
    title: 'Suppress everything',
    detail: 'Nothing is sent. Each message is recorded in the delivery log as suppressed, so '
      + 'you can still see exactly who would have been contacted.',
  },
};

export function AdminSettingsPage() {
  const { user, refresh } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [appBaseUrl, setAppBaseUrl] = useState('');
  const [replyTo, setReplyTo] = useState('');

  const [mailMode, setMailMode] = useState<MailMode>('live');
  const [mailTestAddress, setMailTestAddress] = useState('');
  const [expiryHours, setExpiryHours] = useState<number | null>(8);
  const [effective, setEffective] = useState<MailPolicy | null>(null);
  const [setBy, setSetBy] = useState('');
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    getAdminSettings()
      .then(s => {
        setFromName(s.fromName);
        setFromEmail(s.fromEmail);
        setAppBaseUrl(s.appBaseUrl);
        setReplyTo(s.replyTo ?? '');
        setMailMode(s.mailMode ?? 'live');
        setMailTestAddress(s.mailTestAddress ?? '');
        setEffective(s.effective ?? null);
        setSetBy(s.mailModeSetBy ?? '');
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. Super Admin only.</p></div>;
  }

  const locked = effective?.locked ?? false;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const expiresAt = mailMode === 'live' || expiryHours === null
        ? ''
        : new Date(Date.now() + expiryHours * 3600_000).toISOString();
      const saved = await updateAdminSettings({
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim().toLowerCase(),
        appBaseUrl: appBaseUrl.trim().replace(/\/$/, ''),
        replyTo: replyTo.trim().toLowerCase(),
        mailMode,
        mailTestAddress: mailTestAddress.trim().toLowerCase(),
        mailModeExpiresAt: expiresAt,
      });
      setFromName(saved.fromName);
      setFromEmail(saved.fromEmail);
      setAppBaseUrl(saved.appBaseUrl);
      setReplyTo(saved.replyTo ?? '');
      setEffective(saved.effective ?? null);
      setSetBy(saved.mailMode !== 'live' && user ? user.email : '');
      // The test-mode banner reads /auth/me, fetched once at app mount. Without this the
      // ribbon outlives the mode it reports — saved to Live, still told nobody gets mail.
      await refresh();
      setSuccess('Settings saved. New values are now used for outgoing email and portal links.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setError('');
    setSuccess('');
    try {
      const res = await sendTestEmail();
      setSuccess(res.effective.mode === 'live'
        ? `Test message sent to ${res.to}. If it does not arrive, check the delivery log on any request.`
        : `Mail is in ${res.effective.mode} mode, so nothing was delivered — the attempt is recorded in the delivery log.`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to send test email');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Portal Settings</h1>
      </div>
      <p className="page-subtitle">
        Configure the sender and base portal URL used in system emails, reminders, and password reset links.
      </p>

      {loading ? <p className="muted">Loading…</p> : (
        <form className="form-card" onSubmit={handleSave} style={{ maxWidth: '760px' }}>
          <h2>Email &amp; Link Settings</h2>

          <div className="field">
            <label>From Name *</label>
            <input
              type="text"
              value={fromName}
              onChange={e => setFromName(e.target.value)}
              placeholder="Athletics Business Office"
              required
              maxLength={120}
            />
            <p className="field-hint">Shown as the sender display name in recipient inboxes.</p>
          </div>

          <div className="field">
            <label>From Email *</label>
            <input
              type="email"
              value={fromEmail}
              onChange={e => setFromEmail(e.target.value)}
              placeholder="noreply@mail.utrockets-insurance.com"
              required
            />
            <p className="field-hint">
              Must be an address on a domain verified with your email provider (Resend).
              Use the dedicated sending subdomain, not the apex, so a reputation problem
              stays contained.
            </p>
          </div>

          <div className="field">
            <label>Reply-To Address</label>
            <input
              type="email"
              value={replyTo}
              onChange={e => setReplyTo(e.target.value)}
              placeholder="athletics-insurance@send.utrockets-insurance.com"
            />
            <p className="field-hint">
              A monitored mailbox. Mail with no working reply path is scored more harshly
              by university spam filtering, and recipients who reply to a notification
              should reach a person. Leave blank to send without a Reply-To header.
            </p>
          </div>

          <div className="field">
            <label>Portal Base URL *</label>
            <input
              type="url"
              value={appBaseUrl}
              onChange={e => setAppBaseUrl(e.target.value)}
              placeholder="https://utrockets-insurance.com"
              required
            />
            <p className="field-hint">Used in request action links and password reset emails.</p>
          </div>

          <hr style={{ margin: '2rem 0 1.5rem', border: 'none', borderTop: '1px solid var(--gray-200)' }} />
          <h2>Outgoing Mail</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Controls whether notifications actually leave the portal. Every message is recorded
            in the delivery log in all three modes, so you can always see who would have been
            contacted.
          </p>

          {/* Stored and effective can differ — a locked environment or a lapsed expiry. Showing
              both stops that reading as the page having failed to save. */}
          {effective && effective.mode !== mailMode && (
            <p className="field-hint" style={{ color: 'var(--amber-700, #b45309)', fontWeight: 600 }}>
              Currently in effect: <strong>{effective.mode}</strong>
              {effective.reason ? ` — ${effective.reason}` : ''}
            </p>
          )}
          {locked && (
            <p className="error">
              Mail mode is locked to <strong>{effective?.mode}</strong> for this environment and
              cannot be changed here. This is set in the Worker configuration.
            </p>
          )}
          {setBy && mailMode !== 'live' && (
            <p className="field-hint">Test mode was last enabled by {setBy}.</p>
          )}

          <div className="field">
            {(Object.keys(MODE_COPY) as MailMode[]).map(mode => (
              <label
                key={mode}
                className={`checkbox-chip ${mailMode === mode ? 'checkbox-chip--checked' : ''}`}
                style={{ display: 'flex', alignItems: 'flex-start', marginBottom: '.5rem', cursor: locked ? 'not-allowed' : 'pointer' }}
              >
                <input
                  type="radio"
                  name="mailMode"
                  checked={mailMode === mode}
                  disabled={locked}
                  onChange={() => setMailMode(mode)}
                />
                <span>
                  <strong>{MODE_COPY[mode].title}</strong>
                  <br />
                  <span className="chip-detail">{MODE_COPY[mode].detail}</span>
                </span>
              </label>
            ))}
          </div>

          {mailMode === 'redirect' && (
            <div className="field">
              <label>Test Address *</label>
              <input
                type="email"
                value={mailTestAddress}
                onChange={e => setMailTestAddress(e.target.value)}
                placeholder="you@example.com"
                disabled={locked}
              />
              <p className="field-hint">
                Every notification goes here instead. Without a valid address, redirect falls
                back to suppressing mail rather than delivering it.
              </p>
            </div>
          )}

          {mailMode !== 'live' && (
            <div className="field">
              <label>Turn Off After</label>
              <select
                value={expiryHours === null ? 'never' : String(expiryHours)}
                onChange={e => setExpiryHours(e.target.value === 'never' ? null : Number(e.target.value))}
                disabled={locked}
              >
                {EXPIRY_CHOICES.map(c => (
                  <option key={c.label} value={c.hours === null ? 'never' : String(c.hours)}>{c.label}</option>
                ))}
              </select>
              <p className="field-hint">
                Test mode returns to Live automatically when this elapses, so it cannot be left
                on by being forgotten about. Choose "No expiry" only deliberately.
              </p>
            </div>
          )}

          {error && <p className="error">{error}</p>}
          {success && <p className="success" style={{ color: '#16a34a', fontWeight: 600 }}>{success}</p>}

          <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save Settings'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleTest} disabled={testing}>
              {testing ? 'Sending…' : 'Send test email to me'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
