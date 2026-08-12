import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { getAuthStatus, completeSetup } from '../lib/api';
import { useAuth } from '../lib/auth';

/**
 * First-run creation of the initial Super Admin.
 *
 * The /auth/status and /auth/setup endpoints already existed but had no interface, so
 * the only way to bootstrap a fresh database was a hand-written curl. The endpoint
 * refuses once any user exists, so this page is safe to leave routed.
 */
export function Setup() {
  const navigate = useNavigate();
  const { refresh } = useAuth();

  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    getAuthStatus()
      .then(s => setSetupRequired(s.setupRequired))
      .catch(() => setSetupRequired(false))
      .finally(() => setChecking(false));
  }, []);

  const canSubmit = name.trim() && email.trim() && password.length >= 8 && password === confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setSubmitting(true);
    try {
      await completeSetup({
        name: name.trim(), email: email.trim(), password, role: 'super_admin',
      });
      await refresh();
      // Straight to the checklist, not the dashboard: a fresh database has sixteen sports
      // and nobody attached to any of them, so the dashboard would be empty and silent.
      navigate('/admin/setup');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Setup failed');
      setSubmitting(false);
    }
  };

  if (checking) return <div className="loading-screen"><p>Checking…</p></div>;

  if (!setupRequired) {
    return (
      <div className="page">
        <div className="form-card" style={{ maxWidth: '520px', margin: '3rem auto' }}>
          <h1>Setup already complete</h1>
          <p className="muted">
            This portal already has accounts, so the first-run setup is closed. Sign in
            instead, or ask a Super Admin to create an account for you.
          </p>
          <Link to="/login" className="btn btn-primary" style={{ textDecoration: 'none' }}>
            Go to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <form className="form-card" onSubmit={handleSubmit} style={{ maxWidth: '520px', margin: '3rem auto' }}>
        <h1>Create the first Super Admin</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          This portal has no accounts yet. The account you create here has full access,
          including user management and system settings.
        </p>

        <div className="field">
          <label htmlFor="setup-name">Full Name</label>
          <input id="setup-name" type="text" value={name} onChange={e => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="setup-email">Email</label>
          <input
            id="setup-email" type="email" value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="you@utoledo.edu" autoComplete="email" required
          />
        </div>
        <div className="field">
          <label htmlFor="setup-password">Password (at least 8 characters)</label>
          <input
            id="setup-password" type="password" value={password}
            onChange={e => setPassword(e.target.value)}
            minLength={8} autoComplete="new-password" required
          />
        </div>
        <div className="field">
          <label htmlFor="setup-confirm">Confirm Password</label>
          <input
            id="setup-confirm" type="password" value={confirm}
            onChange={e => setConfirm(e.target.value)}
            autoComplete="new-password" required
          />
          {confirm && password !== confirm && <span className="field-error">Passwords do not match.</span>}
        </div>

        {error && <p className="error">{error}</p>}

        <button type="submit" className="btn btn-primary btn-full" disabled={!canSubmit || submitting}>
          {submitting ? 'Creating…' : 'Create Super Admin'}
        </button>
      </form>
    </div>
  );
}
