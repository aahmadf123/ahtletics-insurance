import { useState } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { resetPassword } from '../lib/api';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = token && newPassword.length >= 8 && newPassword === confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    try {
      await resetPassword(token, newPassword);
      navigate('/login');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reset failed');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div className="auth-page">
        <div className="auth-panel-left">
          <div className="auth-left-content">
            <img src="/logo-dark.png" alt="University of Toledo Athletics" className="auth-logo-badge" />
            <h1 className="auth-left-title">Athletics Insurance Portal</h1>
          </div>
        </div>
        <div className="auth-panel-right">
          <div className="auth-right-content">
            <h2 className="auth-welcome">Invalid Link</h2>
            <p className="auth-instruction">This reset link is invalid or has expired.</p>
            <Link
              to="/forgot-password"
              className="auth-submit"
              style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '24px' }}
            >
              Request a new link
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-panel-left">
        <div className="auth-left-content">
          <img src="/logo-dark.png" alt="University of Toledo Athletics" className="auth-logo-badge" />
          <h1 className="auth-left-title">Athletics Insurance Portal</h1>
          <p className="auth-left-subtitle">
            University of Toledo<br />
            Student-Athlete Health Insurance Request System
          </p>
        </div>
      </div>
      <div className="auth-panel-right">
        <div className="auth-right-content">
          <h2 className="auth-welcome">Set New Password</h2>
          <p className="auth-instruction">Choose a strong password (at least 8 characters)</p>
          <form onSubmit={handleSubmit} style={{ marginTop: '8px' }}>
            <div className="field" style={{ marginBottom: '12px' }}>
              <label htmlFor="rp-new">New Password</label>
              <input
                id="rp-new"
                type="password"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                placeholder="At least 8 characters"
                minLength={8}
                required
                autoComplete="new-password"
              />
            </div>
            <div className="field" style={{ marginBottom: '16px' }}>
              <label htmlFor="rp-confirm">Confirm New Password</label>
              <input
                id="rp-confirm"
                type="password"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder="Repeat your new password"
                required
                autoComplete="new-password"
              />
              {confirm && newPassword !== confirm && (
                <span className="field-error">Passwords do not match.</span>
              )}
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button
              type="submit"
              className={`auth-submit ${!canSubmit ? 'auth-submit--disabled' : ''}`}
              disabled={!canSubmit || loading}
            >
              {loading ? <span className="auth-spinner" /> : null}
              {loading ? 'Saving…' : 'Set New Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
