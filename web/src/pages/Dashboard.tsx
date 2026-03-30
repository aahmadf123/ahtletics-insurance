import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listRequests } from '../lib/api';
import { RequestStatusBadge } from '../components/RequestStatusBadge';
import type { InsuranceRequest } from '../types';

export function Dashboard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<InsuranceRequest[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  useEffect(() => {
    listRequests()
      .then(setRequests)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (!user) return null;

  const title = user.role === 'cfo'
    ? 'CFO Dashboard — All Requests'
    : user.role === 'sport_admin'
    ? 'Sport Administrator Dashboard'
    : 'Coach Dashboard';

  return (
    <div className="page">
      <div className="page-header">
        <h1>{title}</h1>
        {user.role === 'coach' && (
          <Link to="/request/new" className="btn btn-primary">+ New Insurance Request</Link>
        )}
      </div>

      {loading && <p>Loading requests…</p>}
      {error   && <p className="error">{error}</p>}

      {!loading && requests.length === 0 && (
        <div className="empty-state">
          <p>No requests found.</p>
          {user.role === 'coach' && (
            <Link to="/request/new" className="btn btn-primary">Submit Your First Request</Link>
          )}
        </div>
      )}

      {requests.length > 0 && (
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Student</th>
                <th>Rocket #</th>
                <th>Sport</th>
                <th>Term</th>
                <th>Premium</th>
                <th>Status</th>
                {user.role !== 'coach' && <th>Coach</th>}
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <tr key={r.id}>
                  <td>{r.studentName}</td>
                  <td><code>{r.rocketNumber}</code></td>
                  <td>{r.sport.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</td>
                  <td>{r.term}</td>
                  <td>${r.premiumCost.toFixed(2)}</td>
                  <td><RequestStatusBadge status={r.status} /></td>
                  {user.role !== 'coach' && <td>{r.coachEmail}</td>}
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td>
                    <Link to={`/request/${r.id}`} className="btn btn-sm btn-outline">
                      {(r.status === 'PENDING_SPORT_ADMIN' && user.role === 'sport_admin') ||
                       (r.status === 'PENDING_CFO' && user.role === 'cfo')
                        ? 'Review & Sign'
                        : 'View'}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
