import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Login() {
  const { selectIdentity, login } = useAuth();
  const navigate = useNavigate();

  const [role, setRole] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const needsCredentials = role === 'sport_admin' || role === 'cfo' || role === 'super_admin';

  const canContinue = role && (
    role === 'coach' || (needsCredentials && email && password)
  );

  const handleContinue = async () => {
    if (!canContinue) return;
    setError('');
    setLoading(true);
    try {
      if (role === 'coach') {
        await selectIdentity('coach');
      } else {
        await login(email, password);
      }
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to enter portal');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      {/* Left branding panel */}
      <div className="auth-panel-left">
        <div className="auth-left-content">
          <div className="auth-logo-badge">UT</div>
          <h1 className="auth-left-title">Athletics Insurance Portal</h1>
          <p className="auth-left-subtitle">
            University of Toledo<br />
            Student-Athlete Health Insurance Request System
          </p>
          <div className="auth-left-divider" />
          <div className="auth-features">
            <div className="auth-feature">
              <span className="auth-feature-dot" />
              <span>Submit insurance requests for student-athletes</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-dot" />
              <span>Multi-level digital signature workflow</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-dot" />
              <span>Real-time status tracking &amp; notifications</span>
            </div>
            <div className="auth-feature">
              <span className="auth-feature-dot" />
              <span>Financial reports &amp; CSV export</span>
            </div>
          </div>
        </div>
        <div className="auth-left-footer">
          University of Toledo Athletics
        </div>
      </div>

      {/* Right interactive panel */}
      <div className="auth-panel-right">
        <div className="auth-right-content">
          <h2 className="auth-welcome">Welcome</h2>
          <p className="auth-instruction">Select your role to get started</p>

          <div className="auth-role-cards">
            {[
              { value: 'coach', label: 'Coach', desc: 'Submit insurance requests for your athletes' },
              { value: 'sport_admin', label: 'Sport Administrator', desc: 'Review and approve requests for your sports' },
              { value: 'cfo', label: 'CFO', desc: 'Final approval, reports & user management' },
              { value: 'super_admin', label: 'Super Admin', desc: 'Full oversight, user approvals & system management' },
            ].map(r => (
              <button
                key={r.value}
                type="button"
                className={`auth-role-card ${role === r.value ? 'auth-role-card--active' : ''}`}
                onClick={() => {
                  setRole(r.value);
                  setEmail('');
                  setPassword('');
                  setError('');
                }}
              >
                <div className="auth-role-card-radio">
                  {role === r.value && <div className="auth-role-card-radio-dot" />}
                </div>
                <div className="auth-role-card-text">
                  <strong>{r.label}</strong>
                  <span>{r.desc}</span>
                </div>
              </button>
            ))}
          </div>

          {needsCredentials && (
            <div className="auth-selector" style={{ animationDelay: '0s' }}>
              <div className="field" style={{ marginBottom: '12px' }}>
                <label htmlFor="login-email">Email</label>
                <input
                  id="login-email"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="you@utoledo.edu"
                  autoComplete="email"
                />
              </div>
              <div className="field">
                <label htmlFor="login-password">Password</label>
                <input
                  id="login-password"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoComplete="current-password"
                />
              </div>
              <p style={{ fontSize: '0.85rem', marginTop: '8px', color: '#666' }}>
                Don't have an account?{' '}
                <Link to="/register" style={{ color: '#1B2A4A', fontWeight: 600 }}>
                  Request Access
                </Link>
              </p>
            </div>
          )}

          {role === 'coach' && (
            <div className="auth-identity-confirm">
              <div className="auth-identity-label">You'll enter as</div>
              <div className="auth-identity-name">Coach</div>
              <div className="auth-identity-detail">Anonymous coach — enter your name in the request form</div>
            </div>
          )}

          {error && <div className="auth-error">{error}</div>}

          <button
            className={`auth-submit ${canContinue ? '' : 'auth-submit--disabled'}`}
            onClick={handleContinue}
            disabled={!canContinue || loading}
          >
            {loading ? <span className="auth-spinner" /> : null}
            {loading ? 'Entering portal…' : 'Continue to Portal'}
          </button>
        </div>
      </div>
    </div>
  );
}
