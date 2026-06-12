import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { getAdminSettings, updateAdminSettings } from '../../lib/api';

export function AdminSettingsPage() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [appBaseUrl, setAppBaseUrl] = useState('');

  useEffect(() => {
    getAdminSettings()
      .then(s => {
        setFromName(s.fromName);
        setFromEmail(s.fromEmail);
        setAppBaseUrl(s.appBaseUrl);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. Super Admin only.</p></div>;
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const saved = await updateAdminSettings({
        fromName: fromName.trim(),
        fromEmail: fromEmail.trim().toLowerCase(),
        appBaseUrl: appBaseUrl.trim().replace(/\/$/, ''),
      });
      setFromName(saved.fromName);
      setFromEmail(saved.fromEmail);
      setAppBaseUrl(saved.appBaseUrl);
      setSuccess('Settings saved. New values are now used for outgoing email and portal links.');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
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
            <p className="field-hint">Must be a domain/address allowed by your email provider (Resend).</p>
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

          {error && <p className="error">{error}</p>}
          {success && <p className="success" style={{ color: '#16a34a', fontWeight: 600 }}>{success}</p>}

          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Settings'}
          </button>
        </form>
      )}
    </div>
  );
}
