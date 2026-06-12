import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../lib/auth';
import { listAudit, getAuditCsvUrl, type AuditEntry } from '../lib/api';

const ACTIONS = ['SUBMITTED', 'HEAD_COACH_APPROVED', 'SIGNED', 'EXECUTED', 'DENIED', 'VOIDED', 'RESUBMITTED', 'REMINDER_SENT'];

function formatDetails(details: string | null): string {
  if (!details) return '';
  try {
    const obj = JSON.parse(details) as Record<string, unknown>;
    return Object.entries(obj).map(([k, v]) => `${k}: ${v}`).join(', ');
  } catch {
    return details;
  }
}

export function AuditLog() {
  const { user } = useAuth();
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const params = { actor, action, from, to };

  const refresh = useCallback(() => {
    setLoading(true);
    listAudit({ actor, action, from, to })
      .then(setEntries)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [actor, action, from, to]);

  useEffect(() => { refresh(); }, [refresh]);

  if (user?.role !== 'cfo' && user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. CFO or Super Admin only.</p></div>;
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Audit Log</h1>
        <a href={getAuditCsvUrl(params)} className="btn btn-secondary" download="audit-log.csv">
          Export CSV
        </a>
      </div>
      <p className="page-subtitle">
        A complete, read-only event history for compliance — who did what, when, and from which IP.
      </p>

      <div className="filters form-card">
        <div className="filter-row">
          <div className="field">
            <label>Actor (name or email)</label>
            <input type="text" value={actor} onChange={e => setActor(e.target.value)} placeholder="Search actor…" />
          </div>
          <div className="field">
            <label>Action</label>
            <select value={action} onChange={e => setAction(e.target.value)}>
              <option value="">All Actions</option>
              {ACTIONS.map(a => <option key={a} value={a}>{a.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="field">
            <label>From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : entries.length === 0 ? (
        <div className="empty-state"><p>No audit events match the selected filters.</p></div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Student</th>
                <th>Sport</th>
                <th>IP Address</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(e.timestamp.replace(' ', 'T') + 'Z').toLocaleString()}</td>
                  <td><span className="badge badge--audit">{e.action.replace(/_/g, ' ')}</span></td>
                  <td>{e.actor}</td>
                  <td>{e.studentName ?? '—'}{e.rocketNumber ? <> <code>{e.rocketNumber}</code></> : null}</td>
                  <td>{e.sportName ?? '—'}</td>
                  <td><code>{e.ipAddress ?? '—'}</code></td>
                  <td style={{ fontSize: '.8rem', color: '#555' }}>{formatDetails(e.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
