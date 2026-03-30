import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { getIdentities } from '../lib/api';
import type { IdentityData } from '../lib/api';

export function Login() {
  const { selectIdentity } = useAuth();
  const navigate = useNavigate();

  const [identities, setIdentities] = useState<IdentityData | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [sportId, setSportId] = useState('');
  const [adminId, setAdminId] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [pageLoading, setPageLoading] = useState(true);

  useEffect(() => {
    getIdentities()
      .then(setIdentities)
      .catch(err => setError(err.message))
      .finally(() => setPageLoading(false));
  }, []);

  const getSelectedInfo = () => {
    if (!identities) return null;
    if (role === 'coach' && sportId) {
      const c = identities.coaches.find(x => x.sportId === sportId);
      return c ? { name: c.coachName, detail: `${c.sportName} (${c.gender})` } : null;
    }
    if (role === 'sport_admin' && adminId) {
      const a = identities.admins.find(x => x.id === adminId);
      return a ? { name: a.name, detail: a.title } : null;
    }
    if (role === 'cfo' && identities.cfo) {
      return { name: identities.cfo.name, detail: identities.cfo.title };
    }
    return null;
  };

  const canContinue = role && (
    (role === 'coach' && sportId) ||
    (role === 'sport_admin' && adminId) ||
    role === 'cfo'
  );

  const handleContinue = async () => {
    if (!canContinue) return;
    setError('');
    setLoading(true);
    try {
      await selectIdentity(
        role!,
        role === 'coach' ? sportId : undefined,
        role === 'sport_admin' ? adminId : undefined,
      );
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to enter portal');
    } finally {
      setLoading(false);
    }
  };

  const selected = getSelectedInfo();

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
        {pageLoading ? (
          <div className="auth-right-content">
            <div className="auth-loading">Loading portal…</div>
          </div>
        ) : (
          <div className="auth-right-content">
            <h2 className="auth-welcome">Welcome</h2>
            <p className="auth-instruction">Select your role to get started</p>

            <div className="auth-role-cards">
              {[
                { value: 'coach', label: 'Coach', desc: 'Submit insurance requests for your athletes' },
                { value: 'sport_admin', label: 'Sport Administrator', desc: 'Review and approve requests for your sports' },
                { value: 'cfo', label: 'CFO', desc: 'Final approval, reports & user management' },
              ].map(r => (
                <button
                  key={r.value}
                  type="button"
                  className={`auth-role-card ${role === r.value ? 'auth-role-card--active' : ''}`}
                  onClick={() => {
                    setRole(r.value);
                    setSportId('');
                    setAdminId('');
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

            {role === 'coach' && (
              <div className="auth-selector" style={{ animationDelay: '0s' }}>
                <label htmlFor="sport-select">Select your sport</label>
                <select
                  id="sport-select"
                  value={sportId}
                  onChange={e => setSportId(e.target.value)}
                >
                  <option value="">Choose a sport…</option>
                  {identities?.coaches.map(c => (
                    <option key={c.sportId} value={c.sportId}>
                      {c.sportName} ({c.gender}) — {c.coachName}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {role === 'sport_admin' && (
              <div className="auth-selector" style={{ animationDelay: '0s' }}>
                <label htmlFor="admin-select">Select your profile</label>
                <select
                  id="admin-select"
                  value={adminId}
                  onChange={e => setAdminId(e.target.value)}
                >
                  <option value="">Choose your name…</option>
                  {identities?.admins.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.name} — {a.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selected && (
              <div className="auth-identity-confirm">
                <div className="auth-identity-label">You'll enter as</div>
                <div className="auth-identity-name">{selected.name}</div>
                <div className="auth-identity-detail">{selected.detail}</div>
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
        )}
      </div>
    </div>
  );
}
