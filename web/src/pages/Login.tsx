import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { checkAuthStatus, listSports, setupAccount } from '../lib/api';
import type { SportProgram } from '../types';

export function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState<'login' | 'setup' | 'checking'>('checking');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState('cfo');
  const [sportId, setSportId] = useState('');
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    Promise.all([
      checkAuthStatus().catch(() => ({ setupRequired: false })),
      listSports().catch(() => [] as SportProgram[]),
    ]).then(([status, sportsList]) => {
      setMode(status.setupRequired ? 'setup' : 'login');
      setSports(sportsList);
    });
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await setupAccount(
        email.trim(),
        password,
        name.trim(),
        role,
        role === 'coach' ? sportId : undefined,
      );
      await login(email.trim(), password);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const switchMode = (newMode: 'login' | 'setup') => {
    setMode(newMode);
    setError('');
  };

  if (mode === 'checking') {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-loading">Loading…</div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo-badge">UT</div>
          <h1 className="auth-title">Athletics Insurance Portal</h1>
          <p className="auth-subtitle">University of Toledo — Student-Athlete Health Insurance</p>
        </div>

        {mode === 'setup' && (
          <div className="auth-notice">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" style={{flexShrink:0,marginTop:2}}>
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm-.75 3.75a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zm.75 7a.75.75 0 110-1.5.75.75 0 010 1.5z"/>
            </svg>
            <span>No accounts exist yet. Create your first administrator account to get started.</span>
          </div>
        )}

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="auth-form">
            <div className="auth-field">
              <label htmlFor="email">Email Address</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@utoledo.edu"
                required
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="auth-submit" disabled={loading}>
              {loading ? (
                <span className="auth-spinner" />
              ) : null}
              {loading ? 'Signing in…' : 'Sign In'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetup} className="auth-form">
            <div className="auth-field">
              <label htmlFor="setup-name">Full Name</label>
              <input
                id="setup-name"
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Jane Smith"
                required
                autoFocus
              />
            </div>
            <div className="auth-field">
              <label htmlFor="setup-email">Email Address</label>
              <input
                id="setup-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@utoledo.edu"
                required
              />
            </div>
            <div className="auth-field">
              <label htmlFor="setup-password">Password</label>
              <input
                id="setup-password"
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                placeholder="Min. 8 characters"
                required
                minLength={8}
              />
            </div>
            <div className="auth-field">
              <label htmlFor="setup-role">Your Role</label>
              <div className="auth-role-grid">
                {[
                  { value: 'cfo', label: 'CFO / Admin', desc: 'Full access, manage users & reports' },
                  { value: 'sport_admin', label: 'Sport Admin', desc: 'Approve requests for your sports' },
                  { value: 'coach', label: 'Coach', desc: 'Submit insurance requests' },
                ].map(r => (
                  <button
                    key={r.value}
                    type="button"
                    className={`auth-role-option ${role === r.value ? 'auth-role-option--active' : ''}`}
                    onClick={() => { setRole(r.value); if (r.value !== 'coach') setSportId(''); }}
                  >
                    <strong>{r.label}</strong>
                    <span>{r.desc}</span>
                  </button>
                ))}
              </div>
            </div>
            {role === 'coach' && (
              <div className="auth-field">
                <label htmlFor="setup-sport">Sport Program</label>
                <select
                  id="setup-sport"
                  value={sportId}
                  onChange={e => setSportId(e.target.value)}
                  required
                >
                  <option value="">Select your sport…</option>
                  {sports.map(s => (
                    <option key={s.id} value={s.id}>{s.name} ({s.gender})</option>
                  ))}
                </select>
              </div>
            )}
            {error && <div className="auth-error">{error}</div>}
            <button type="submit" className="auth-submit" disabled={loading}>
              {loading ? (
                <span className="auth-spinner" />
              ) : null}
              {loading ? 'Creating account…' : 'Create Account & Sign In'}
            </button>
          </form>
        )}

        <div className="auth-footer">
          {mode === 'login' ? (
            <p>First time? <button type="button" className="auth-link" onClick={() => switchMode('setup')}>Set up your account</button></p>
          ) : (
            <p>Already have an account? <button type="button" className="auth-link" onClick={() => switchMode('login')}>Sign in</button></p>
          )}
        </div>
      </div>
      <div className="auth-attribution">
        University of Toledo Athletics
      </div>
    </div>
  );
}
