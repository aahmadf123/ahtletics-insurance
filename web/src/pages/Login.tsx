import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { login, register, devLogin } from '../lib/api';

export function Login() {
  const { user, loading, reload } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode]           = useState<'login' | 'register'>('login');
  const [email, setEmail]         = useState('');
  const [password, setPassword]   = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError]         = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) navigate('/dashboard');
  }, [user, loading, navigate]);

  const isDev = import.meta.env.DEV;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email, password);
      } else {
        if (!displayName.trim()) {
          setError('Display name is required');
          setSubmitting(false);
          return;
        }
        await register(email, password, displayName);
      }
      reload();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDevLogin = async (role: string) => {
    const profiles: Record<string, { email: string; displayName: string }> = {
      coach:       { email: 'coach.test@utoledo.edu',       displayName: 'Test Coach' },
      sport_admin: { email: 'nicole.harris@utoledo.edu',    displayName: 'Nicole Harris' },
      cfo:         { email: 'melissa.deangelo@utoledo.edu', displayName: 'Melissa DeAngelo' },
    };
    const p = profiles[role];
    if (!p) return;
    await devLogin(p.email, p.displayName);
    reload();
  };

  if (loading) return <div className="page-center">Loading...</div>;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <span className="logo-ut large">UT</span>
          <h1>Athletics Insurance Portal</h1>
          <p>University of Toledo Student-Athlete Health Insurance Request System</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="field" style={{ marginBottom: 12 }}>
            <label>Email</label>
            <input
              type="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="your.name@utoledo.edu"
              required
            />
          </div>

          {mode === 'register' && (
            <div className="field" style={{ marginBottom: 12 }}>
              <label>Full Name</label>
              <input
                type="text"
                value={displayName}
                onChange={e => setDisplayName(e.target.value)}
                placeholder="First Last"
                required
              />
            </div>
          )}

          <div className="field" style={{ marginBottom: 16 }}>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder={mode === 'register' ? 'Min 8 characters' : 'Enter password'}
              required
              minLength={mode === 'register' ? 8 : undefined}
            />
          </div>

          {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

          <button className="btn btn-primary btn-full" type="submit" disabled={submitting}>
            {submitting ? 'Please wait...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: 16, fontSize: '0.88rem' }}>
          {mode === 'login' ? (
            <>Don't have an account?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode('register'); setError(''); }}>
              Create one
            </a></>
          ) : (
            <>Already have an account?{' '}
            <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); setError(''); }}>
              Sign in
            </a></>
          )}
        </p>

        {isDev && (
          <div className="dev-panel">
            <p><strong>Dev Mode</strong> — bypass login</p>
            <div className="dev-buttons">
              <button className="btn btn-sm btn-outline" onClick={() => handleDevLogin('coach')}>Login as Coach</button>
              <button className="btn btn-sm btn-outline" onClick={() => handleDevLogin('sport_admin')}>Login as Sport Admin</button>
              <button className="btn btn-sm btn-outline" onClick={() => handleDevLogin('cfo')}>Login as CFO</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
