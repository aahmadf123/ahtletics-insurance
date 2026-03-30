import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useAuth } from '../lib/auth';
import { devLogin } from '../lib/api';

export function Login() {
  const { user, loading, reload } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && user) navigate('/dashboard');
  }, [user, loading, navigate]);

  const isDev = import.meta.env.DEV;

  const handleSamlLogin = () => {
    window.location.href = '/auth/login';
  };

  const handleDevLogin = async (role: string) => {
    const profiles: Record<string, { email: string; displayName: string }> = {
      coach:      { email: 'coach.test@utoledo.edu',                displayName: 'Test Coach' },
      sport_admin: { email: 'nicole.harris@utoledo.edu',             displayName: 'Nicole Harris' },
      cfo:        { email: 'melissa.deangelo@utoledo.edu',           displayName: 'Melissa DeAngelo' },
    };
    const p = profiles[role];
    if (!p) return;
    await devLogin(p.email, p.displayName);
    reload();
  };

  if (loading) return <div className="page-center">Loading…</div>;

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <span className="logo-ut large">UT</span>
          <h1>Athletics Insurance Portal</h1>
          <p>University of Toledo Student-Athlete Health Insurance Request System</p>
        </div>

        <button className="btn btn-primary btn-full" onClick={handleSamlLogin}>
          Sign in with UToledo SSO
        </button>
        <p className="login-mfa-note">
          Requires Microsoft Authenticator MFA — your identity is bound to this request.
        </p>

        {isDev && (
          <div className="dev-panel">
            <p><strong>Dev Mode</strong> — bypass SSO</p>
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
