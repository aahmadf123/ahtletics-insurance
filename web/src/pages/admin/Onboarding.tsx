import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { getOnboarding, type OnboardingState } from '../../lib/api';

/**
 * What still has to be configured before the portal can route anything.
 *
 * People are no longer seeded — administrators, coaches, and the CFO are entered here after
 * first sign-in, because anyone written into a migration cannot be corrected when they leave.
 * The cost is that a fresh deploy has sixteen sports and nobody attached to any of them: the
 * app is reachable but inert, requests submit and then sit unrouted, and nothing says why.
 * This page is that explanation, and it doubles as the turnover checklist later.
 */
export function AdminOnboarding() {
  const { user } = useAuth();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getOnboarding()
      .then(setState)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed to load setup status'))
      .finally(() => setLoading(false));
  }, []);

  if (user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. Super Admin only.</p></div>;
  }

  const steps = state ? [
    {
      done: state.settingsConfigured,
      title: 'Confirm the portal settings',
      body: 'The sending address, reply-to, and portal URL used in every notification.',
      to: '/admin/settings',
      cta: 'Open Settings',
      detail: null as string | null,
    },
    {
      done: state.cfoCount > 0,
      title: 'Add the CFO and your sport administrators',
      body: 'Approvers need accounts. They can also register themselves and be approved here, '
        + 'so you never have to type anyone else’s address.',
      to: '/admin/users',
      cta: 'Open Users',
      detail: state.cfoCount === 0
        ? 'No CFO account yet — no request can be finalized without one.'
        : `${state.cfoCount} CFO, ${state.sportAdminCount} sport administrator${state.sportAdminCount === 1 ? '' : 's'}.`,
    },
    {
      done: state.sportsWithoutAdmin.length === 0,
      title: 'Give every sport an administrator',
      body: 'The administrator is asked to approve each request for their sports.',
      to: '/admin/sports',
      cta: 'Open Sports',
      detail: state.sportsWithoutAdmin.length
        ? `Unassigned: ${state.sportsWithoutAdmin.map(s => s.name).join(', ')}`
        : null,
    },
    {
      done: state.sportsWithoutHeadCoach.length === 0,
      title: 'Give every sport a head coach with an email',
      body: 'The head coach is the first approval step. Without an address on file that step '
        + 'cannot be delivered and the request stalls.',
      to: '/admin/sports',
      cta: 'Open Sports',
      detail: state.sportsWithoutHeadCoach.length
        ? `Missing a routable head coach: ${state.sportsWithoutHeadCoach.map(s => s.name).join(', ')}`
        : null,
    },
  ] : [];

  return (
    <div className="page">
      <div className="page-header"><h1>Portal Setup</h1></div>
      <p className="page-subtitle">
        Work through these once. Anything still outstanding will stop requests from reaching
        the people who have to approve them.
      </p>

      {error && <p className="error">{error}</p>}
      {loading && <p className="muted">Loading…</p>}

      {state && (
        <>
          {state.complete ? (
            <p className="success" style={{ color: '#16a34a', fontWeight: 600 }}>
              Setup is complete. Every sport has an administrator and a routable head coach.
            </p>
          ) : (
            <p className="field-hint">
              {steps.filter(s => s.done).length} of {steps.length} done.
            </p>
          )}

          {state.mailMode !== 'live' && (
            <p className="field-hint" style={{ color: '#b45309', fontWeight: 600 }}>
              Outgoing mail is currently in {state.mailMode} mode, so nothing you do here will
              contact anyone until you switch it to Live in Settings. That is the safe order:
              finish the roster first, then turn mail on.
            </p>
          )}

          <div style={{ display: 'grid', gap: '1rem', marginTop: '1.25rem' }}>
            {steps.map((step, i) => (
              <div
                key={step.title}
                className="form-card"
                style={{
                  margin: 0, borderLeft: `4px solid ${step.done ? '#16a34a' : 'var(--gold, #FFC72C)'}`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '.6rem' }}>
                  <span style={{ fontWeight: 700, color: step.done ? '#16a34a' : 'var(--blue)' }}>
                    {step.done ? '✓' : i + 1}
                  </span>
                  <h2 style={{ margin: 0, fontSize: '1rem' }}>{step.title}</h2>
                </div>
                <p className="field-hint" style={{ marginTop: '.4rem' }}>{step.body}</p>
                {step.detail && (
                  <p className={step.done ? 'field-hint' : 'field-error'} style={{ marginTop: '.2rem' }}>
                    {step.detail}
                  </p>
                )}
                <Link className="btn btn-secondary" to={step.to} style={{ marginTop: '.6rem', display: 'inline-block' }}>
                  {step.cta}
                </Link>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
