import { useState } from 'react';
import { Link } from 'react-router-dom';
import { register } from '../lib/api';

export function Register() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState('sport_admin');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit = name.trim() && email.trim() && password.length >= 8;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    setLoading(true);
    try {
      await register({ name: name.trim(), email: email.trim(), password, role });
      setSubmitted(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="auth-page">
        <div className="auth-panel-left">
          <div className="auth-left-content">
            <div className="auth-logo-badge">UT</div>
            <h1 className="auth-left-title">Athletics Insurance Portal</h1>
            <p className="auth-left-subtitle">
              University of Toledo<br />
              Student-Athlete Health Insurance Request System
            </p>
          </div>
        </div>
        <div className="auth-panel-right">
          <div className="auth-right-content">
            <h2 className="auth-welcome">Request Submitted</h2>
            <div className="auth-identity-confirm">
              <div className="auth-identity-label">✓ Account request received</div>
              <div className="auth-identity-detail" style={{ marginTop: '8px' }}>
                Your account request has been submitted. A Super Admin will review and approve it.
                You will be able to log in once your account is approved.
              </div>
            </div>
            <Link to="/login" className="auth-submit" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: '24px' }}>
              Back to Login
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
          <div className="auth-logo-badge">UT</div>
          <h1 className="auth-left-title">Athletics Insurance Portal</h1>
          <p className="auth-left-subtitle">
            University of Toledo<br />
            Student-Athlete Health Insurance Request System
          </p>
        </div>
      </div>
      <div className="auth-panel-right">
        <div className="auth-right-content">
          <h2 className="auth-welcome">Request Access</h2>
          <p className="auth-instruction">Create an account — a Super Admin will review your request</p>

          <form className="form-card" onSubmit={handleSubmit} style={{ marginTop: '16px' }}>
            <div className="field">
              <label>Full Name *</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Your full name"
                required
              />
            </div>
            <div className="field">
              <label>Email *</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@utoledo.edu"
                required
              />
            </div>
            <div className="field">
              <label>Password * (min 8 characters)</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Choose a password"
                minLength={8}
                required
              />
            </div>
            <div className="field">
              <label>Role *</label>
              <select value={role} onChange={e => setRole(e.target.value)}>
                <option value="sport_admin">Sport Administrator</option>
                <option value="cfo">CFO</option>
              </select>
            </div>

            {error && <p className="error">{error}</p>}

            <button
              type="submit"
              className="btn btn-primary btn-full"
              disabled={!canSubmit || loading}
            >
              {loading ? 'Submitting…' : 'Request Access'}
            </button>
          </form>

          <p style={{ textAlign: 'center', marginTop: '16px', fontSize: '0.85rem', color: '#666' }}>
            Already have an account?{' '}
            <Link to="/login" style={{ color: '#1B2A4A', fontWeight: 600 }}>Sign in</Link>
          </p>
        </div>
      </div>
    </div>
  );
}
