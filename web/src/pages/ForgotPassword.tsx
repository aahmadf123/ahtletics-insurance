import { useState } from 'react';
import { Link } from 'react-router-dom';
import { forgotPassword } from '../lib/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setError('');
    setLoading(true);
    try {
      await forgotPassword(email.trim());
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setLoading(false);
    }
  };

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
          <h2 className="auth-welcome">Reset Password</h2>
          {submitted ? (
            <>
              <div className="auth-identity-confirm">
                <div className="auth-identity-label">✓ Email sent</div>
                <div className="auth-identity-detail" style={{ marginTop: '8px' }}>
                  If an account with that email exists, a password reset link has been sent.
                  Check your inbox and follow the link to set a new password.
                </div>
              </div>
              <Link
                to="/login"
                className="auth-submit"
                style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '24px' }}
              >
                Back to Login
              </Link>
            </>
          ) : (
            <>
              <p className="auth-instruction">Enter your email and we'll send you a reset link</p>
              <form onSubmit={handleSubmit} style={{ marginTop: '8px' }}>
                <div className="field" style={{ marginBottom: '16px' }}>
                  <label htmlFor="fp-email">Email</label>
                  <input
                    id="fp-email"
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@utoledo.edu"
                    required
                    autoComplete="email"
                  />
                </div>
                {error && <div className="auth-error">{error}</div>}
                <button
                  type="submit"
                  className={`auth-submit ${!email.trim() ? 'auth-submit--disabled' : ''}`}
                  disabled={!email.trim() || loading}
                >
                  {loading ? <span className="auth-spinner" /> : null}
                  {loading ? 'Sending…' : 'Send Reset Link'}
                </button>
              </form>
              <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '0.85rem', color: '#666' }}>
                Remembered your password?{' '}
                <Link to="/login" style={{ color: '#1B2A4A', fontWeight: 600 }}>Sign in</Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
