import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { getReports, getReportsCsvUrl, listSports } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { summarizeBySport, exportReportXlsx } from '../lib/analytics';
import type { ReportRow, SportProgram, RequestStatus } from '../types';

const ALL_STATUSES: RequestStatus[] = [
  'PENDING_COACH', 'PENDING_APPROVAL', 'EXECUTED', 'VOIDED', 'EXPIRED',
];

export function Reports() {
  const { user } = useAuth();
  const [rows, setRows] = useState<ReportRow[]>([]);
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [filterSport, setFilterSport] = useState('');
  const [filterTerm, setFilterTerm] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterCoach, setFilterCoach] = useState('');

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  useEffect(() => {
    const params: Record<string, string> = {};
    if (filterSport) params.sport = filterSport;
    if (filterTerm) params.term = filterTerm;
    if (filterStatus) params.status = filterStatus;
    if (filterCoach) params.coach = filterCoach;

    setLoading(true);
    getReports(params)
      .then(setRows)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [filterSport, filterTerm, filterStatus, filterCoach]);

  if (user?.role !== 'cfo' && user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. CFO or Super Admin only.</p></div>;
  }

  const totalPremium = rows
    .filter(r => r.status === 'EXECUTED' || r.status === 'PENDING_APPROVAL')
    .reduce((sum, r) => sum + r.premiumCost, 0);

  const executedPremium = rows
    .filter(r => r.status === 'EXECUTED')
    .reduce((sum, r) => sum + r.premiumCost, 0);

  const bySport = summarizeBySport(rows);

  const csvParams: Record<string, string> = {};
  if (filterSport) csvParams.sport = filterSport;
  if (filterTerm) csvParams.term = filterTerm;
  if (filterStatus) csvParams.status = filterStatus;
  if (filterCoach) csvParams.coach = filterCoach;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Financial Reports</h1>
        <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => exportReportXlsx(rows)}
            disabled={rows.length === 0}
          >
            Export Excel
          </button>
          <a
            href={getReportsCsvUrl(csvParams)}
            className="btn btn-secondary"
            download="athletics-insurance-report.csv"
          >
            Export CSV
          </a>
        </div>
      </div>

      {/* Summary cards */}
      <div className="summary-cards">
        <div className="summary-card">
          <span className="summary-label">Total Requests</span>
          <span className="summary-value">{rows.length}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Committed Premium</span>
          <span className="summary-value">${totalPremium.toFixed(2)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Executed Premium</span>
          <span className="summary-value executed">${executedPremium.toFixed(2)}</span>
        </div>
        <div className="summary-card">
          <span className="summary-label">Executed Requests</span>
          <span className="summary-value executed">
            {rows.filter(r => r.status === 'EXECUTED').length}
          </span>
        </div>
      </div>

      {/* Totals by sport */}
      {bySport.length > 0 && (
        <div className="form-card">
          <h2>Totals by Sport</h2>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sport</th>
                  <th>Requests</th>
                  <th>Committed Premium</th>
                  <th>Executed Premium</th>
                  <th>Executed Requests</th>
                </tr>
              </thead>
              <tbody>
                {bySport.map(s => (
                  <tr key={s.sportName}>
                    <td>{s.sportName}</td>
                    <td>{s.count}</td>
                    <td>${s.committedPremium.toFixed(2)}</td>
                    <td className="executed">${s.executedPremium.toFixed(2)}</td>
                    <td>{s.executedCount}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>Total</td>
                  <td>{bySport.reduce((n, s) => n + s.count, 0)}</td>
                  <td>${bySport.reduce((n, s) => n + s.committedPremium, 0).toFixed(2)}</td>
                  <td className="executed">${bySport.reduce((n, s) => n + s.executedPremium, 0).toFixed(2)}</td>
                  <td>{bySport.reduce((n, s) => n + s.executedCount, 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="filters form-card">
        <div className="filter-row">
          <div className="field">
            <label>Sport</label>
            <select value={filterSport} onChange={e => setFilterSport(e.target.value)}>
              <option value="">All Sports</option>
              {sports.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Term</label>
            <input
              type="text"
              value={filterTerm}
              onChange={e => setFilterTerm(e.target.value)}
              placeholder="e.g. Fall 2025"
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">All Statuses</option>
              {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Coach (name or email)</label>
            <input
              type="text"
              value={filterCoach}
              onChange={e => setFilterCoach(e.target.value)}
              placeholder="Search coach…"
            />
          </div>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <div className="empty-state"><p>No records match the selected filters.</p></div>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Student-Athlete</th>
                <th>Rocket #</th>
                <th>Sport</th>
                <th>Term</th>
                <th>Coach</th>
                <th>Premium</th>
                <th>Status</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{r.studentName}</td>
                  <td><code>{r.rocketNumber}</code></td>
                  <td>{r.sportName}</td>
                  <td>{r.term}</td>
                  <td>{r.coachName}</td>
                  <td>${r.premiumCost.toFixed(2)}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
