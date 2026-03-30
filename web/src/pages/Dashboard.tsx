import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listRequests } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import type { InsuranceRequest } from '../types';

export function Dashboard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<InsuranceRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    listRequests()
      .then(setRequests)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard</h1>
        {user?.role === 'coach' && (
          <Link to="/request/new" className="btn btn-primary">
            + New Request
          </Link>
        )}
        {user?.role === 'cfo' && (
          <Link to="/reports" className="btn btn-secondary">
            Financial Reports
          </Link>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {requests.length === 0 ? (
        <div className="empty-state">
          <p>No insurance requests found.</p>
          {user?.role === 'coach' && (
            <Link to="/request/new" className="btn btn-primary">Submit Your First Request</Link>
          )}
        </div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Student-Athlete</th>
                <th>Rocket #</th>
                <th>Sport</th>
                <th>Term</th>
                <th>Premium</th>
                {user?.role !== 'coach' && <th>Coach</th>}
                <th>Status</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id}>
                  <td>{r.studentName}</td>
                  <td><code>{r.rocketNumber}</code></td>
                  <td>{r.sportName ?? r.sport}</td>
                  <td>{r.term}</td>
                  <td>${r.premiumCost.toFixed(2)}</td>
                  {user?.role !== 'coach' && <td>{r.coachName}</td>}
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td>
                    <Link to={`/request/${r.id}`} className="link">View</Link>
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
