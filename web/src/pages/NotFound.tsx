import { Link } from 'react-router-dom';

/**
 * Unknown routes used to redirect silently to the dashboard or login, so a mistyped or
 * stale link looked like it had worked and quietly showed something else.
 */
export function NotFound({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="page">
      <div className="form-card" style={{ maxWidth: '560px', margin: '3rem auto' }}>
        <h1>Page not found</h1>
        <p className="muted">
          That address does not match anything in the portal. If you followed a link from
          an email, it may have been truncated by your mail client. Try opening it again
          from the dashboard.
        </p>
        <Link to={signedIn ? '/dashboard' : '/login'} className="btn btn-primary" style={{ textDecoration: 'none' }}>
          {signedIn ? 'Back to dashboard' : 'Go to sign in'}
        </Link>
      </div>
    </div>
  );
}
