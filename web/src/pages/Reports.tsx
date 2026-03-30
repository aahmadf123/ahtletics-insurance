import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { getSummary, exportCsv } from '../lib/api';
import type { InsuranceRequest } from '../types';
import { RequestStatusBadge } from '../components/RequestStatusBadge';

export function Reports() {
  const { user } = useAuth();

  const [data, setData] = useState<{
    requests: InsuranceRequest[];
    totals: { bySport: Record<string, number>; byTerm: Record<string, number>; byCoach: Record<string, number> };
  } | null>(null);

  const [filters, setFilters] = useState({ sport: '', term: '', status: '', coach: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');

  const load = () => {
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
    setLoading(true);
    getSummary(params)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  if (user?.role !== 'cfo') {
    return <div className="page"><p className="error">CFO access only.</p></div>;
  }

  const fmt = (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Financial Reports</h1>
        <button className="btn btn-outline" onClick={exportCsv}>Export CSV</button>
      </div>

      {/* Filters */}
      <div className="filter-bar">
        {(['sport', 'term', 'status', 'coach'] as const).map(key => (
          <input
            key={key}
            type="text"
            placeholder={`Filter by ${key}…`}
            value={filters[key]}
            onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))}
            onKeyDown={e => e.key === 'Enter' && load()}
          />
        ))}
        <button className="btn btn-primary" onClick={load}>Apply</button>
      </div>

      {error   && <p className="error">{error}</p>}
      {loading && <p>Loading…</p>}

      {data && (
        <>
          {/* Totals */}
          <div className="summary-grid">
            <SummaryCard title="Total by Sport" data={data.totals.bySport} fmt={fmt} />
            <SummaryCard title="Total by Term"  data={data.totals.byTerm}  fmt={fmt} />
            <SummaryCard title="Total by Coach" data={data.totals.byCoach} fmt={fmt} />
          </div>

          {/* Request table */}
          <h2 style={{ marginTop: 32 }}>All Requests ({data.requests.length})</h2>
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
                  <th>Coach</th>
                  <th>Date</th>
                </tr>
              </thead>
              <tbody>
                {data.requests.map(r => (
                  <tr key={r.id}>
                    <td>{r.studentName}</td>
                    <td><code>{r.rocketNumber}</code></td>
                    <td>{r.sport}</td>
                    <td>{r.term}</td>
                    <td>{fmt(r.premiumCost)}</td>
                    <td><RequestStatusBadge status={r.status} /></td>
                    <td>{r.coachEmail}</td>
                    <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryCard({ title, data, fmt }: {
  title: string;
  data: Record<string, number>;
  fmt: (n: number) => string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  return (
    <div className="summary-card">
      <h3>{title}</h3>
      {entries.length === 0 && <p>No data.</p>}
      <ul>
        {entries.map(([k, v]) => (
          <li key={k}><span>{k}</span> <strong>{fmt(v)}</strong></li>
        ))}
      </ul>
      {entries.length > 0 && (
        <div className="summary-total">Total: <strong>{fmt(total)}</strong></div>
      )}
    </div>
  );
}
