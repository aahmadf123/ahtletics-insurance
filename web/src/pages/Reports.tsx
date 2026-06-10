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
  // allRows holds the full unfiltered dataset used for the top-level dashboard
  const [allRows, setAllRows] = useState<ReportRow[]>([]);
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
    // Load unfiltered data once for the aggregate dashboard
    getReports({}).then(setAllRows).catch(console.error);
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

  // ── Aggregate metrics (always over full dataset) ──────────────────────────
  const totalAll = allRows.length;
  const pendingCoachCount = allRows.filter(r => r.status === 'PENDING_COACH').length;
  const pendingApprovalCount = allRows.filter(r => r.status === 'PENDING_APPROVAL').length;
  const executedCount = allRows.filter(r => r.status === 'EXECUTED').length;
  const voidedCount = allRows.filter(r => r.status === 'VOIDED').length;
  const expiredCount = allRows.filter(r => r.status === 'EXPIRED').length;

  const totalCommittedPremium = allRows
    .filter(r => r.status === 'EXECUTED' || r.status === 'PENDING_APPROVAL')
    .reduce((sum, r) => sum + r.premiumCost, 0);
  const totalExecutedPremium = allRows
    .filter(r => r.status === 'EXECUTED')
    .reduce((sum, r) => sum + r.premiumCost, 0);

  const executionRate = totalAll > 0 ? Math.round((executedCount / totalAll) * 100) : 0;

  // ── Filtered metrics (for the table section) ─────────────────────────────
  const filteredTotal = rows.length;
  const filteredCommitted = rows
    .filter(r => r.status === 'EXECUTED' || r.status === 'PENDING_APPROVAL')
    .reduce((sum, r) => sum + r.premiumCost, 0);
  const filteredExecuted = rows
    .filter(r => r.status === 'EXECUTED')
    .reduce((sum, r) => sum + r.premiumCost, 0);

  const bySport = summarizeBySport(allRows);

  const csvParams: Record<string, string> = {};
  if (filterSport) csvParams.sport = filterSport;
  if (filterTerm) csvParams.term = filterTerm;
  if (filterStatus) csvParams.status = filterStatus;
  if (filterCoach) csvParams.coach = filterCoach;

  const hasFilters = !!(filterSport || filterTerm || filterStatus || filterCoach);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Financial Reports & Dashboard</h1>
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

      {/* ── Aggregate Pipeline Dashboard ─────────────────────────────────── */}
      <div className="cfo-dashboard-section">
        <h2 className="cfo-section-title">Overall Request Pipeline</h2>

        {/* Status pipeline cards */}
        <div className="cfo-pipeline">
          <div className="cfo-pipeline-card cfo-pipeline-card--pending-coach">
            <span className="cfo-pipeline-count">{pendingCoachCount}</span>
            <span className="cfo-pipeline-label">Pending Coach</span>
            <span className="cfo-pipeline-sub">Awaiting coach signature</span>
          </div>
          <div className="cfo-pipeline-arrow">→</div>
          <div className="cfo-pipeline-card cfo-pipeline-card--pending-approval">
            <span className="cfo-pipeline-count">{pendingApprovalCount}</span>
            <span className="cfo-pipeline-label">Pending Approval</span>
            <span className="cfo-pipeline-sub">Needs Sport Admin &amp; CFO</span>
          </div>
          <div className="cfo-pipeline-arrow">→</div>
          <div className="cfo-pipeline-card cfo-pipeline-card--executed">
            <span className="cfo-pipeline-count">{executedCount}</span>
            <span className="cfo-pipeline-label">Executed</span>
            <span className="cfo-pipeline-sub">Fully approved</span>
          </div>
        </div>

        {/* Summary stat cards */}
        <div className="summary-cards" style={{ marginTop: '1rem' }}>
          <div className="summary-card">
            <span className="summary-label">Total Requests</span>
            <span className="summary-value">{totalAll}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Committed Premium</span>
            <span className="summary-value">${totalCommittedPremium.toFixed(2)}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Executed Premium</span>
            <span className="summary-value executed">${totalExecutedPremium.toFixed(2)}</span>
          </div>
          <div className="summary-card">
            <span className="summary-label">Execution Rate</span>
            <span className="summary-value executed">{executionRate}%</span>
          </div>
          {voidedCount > 0 && (
            <div className="summary-card">
              <span className="summary-label">Voided</span>
              <span className="summary-value" style={{ color: '#dc3545' }}>{voidedCount}</span>
            </div>
          )}
          {expiredCount > 0 && (
            <div className="summary-card">
              <span className="summary-label">Expired</span>
              <span className="summary-value" style={{ color: '#6c757d' }}>{expiredCount}</span>
            </div>
          )}
        </div>
      </div>

      {/* ── By-Sport Dashboard ────────────────────────────────────────────── */}
      {bySport.length > 0 && (
        <div className="form-card">
          <h2>Breakdown by Sport</h2>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Sport</th>
                  <th style={{ textAlign: 'center' }}>Total</th>
                  <th style={{ textAlign: 'center' }}>Pending Coach</th>
                  <th style={{ textAlign: 'center' }}>Pending Approval</th>
                  <th style={{ textAlign: 'center' }}>Executed</th>
                  <th style={{ textAlign: 'center' }}>Voided</th>
                  <th style={{ textAlign: 'center' }}>Expired</th>
                  <th style={{ textAlign: 'right' }}>Committed Premium</th>
                  <th style={{ textAlign: 'right' }}>Executed Premium</th>
                </tr>
              </thead>
              <tbody>
                {bySport.map(s => (
                  <tr key={s.sportName}>
                    <td style={{ fontWeight: 500 }}>{s.sportName}</td>
                    <td style={{ textAlign: 'center' }}>{s.count}</td>
                    <td style={{ textAlign: 'center' }}>
                      {s.pendingCoach > 0
                        ? <span className="cfo-count-badge cfo-count-badge--coach">{s.pendingCoach}</span>
                        : <span className="cfo-count-zero">—</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {s.pendingApproval > 0
                        ? <span className="cfo-count-badge cfo-count-badge--approval">{s.pendingApproval}</span>
                        : <span className="cfo-count-zero">—</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {s.executedCount > 0
                        ? <span className="cfo-count-badge cfo-count-badge--executed">{s.executedCount}</span>
                        : <span className="cfo-count-zero">—</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {s.voidedCount > 0
                        ? <span className="cfo-count-badge cfo-count-badge--voided">{s.voidedCount}</span>
                        : <span className="cfo-count-zero">—</span>}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      {s.expiredCount > 0
                        ? <span className="cfo-count-badge cfo-count-badge--expired">{s.expiredCount}</span>
                        : <span className="cfo-count-zero">—</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>${s.committedPremium.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }} className="executed">${s.executedPremium.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 700 }}>
                  <td>Total</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.count, 0)}</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.pendingCoach, 0) || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.pendingApproval, 0) || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.executedCount, 0) || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.voidedCount, 0) || '—'}</td>
                  <td style={{ textAlign: 'center' }}>{bySport.reduce((n, s) => n + s.expiredCount, 0) || '—'}</td>
                  <td style={{ textAlign: 'right' }}>${bySport.reduce((n, s) => n + s.committedPremium, 0).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }} className="executed">${bySport.reduce((n, s) => n + s.executedPremium, 0).toFixed(2)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="filters form-card">
        <h2 style={{ marginBottom: '.75rem' }}>Request Details</h2>
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

      {/* Filtered summary strip */}
      {hasFilters && !loading && rows.length > 0 && (
        <div className="cfo-filtered-summary">
          <span><strong>{filteredTotal}</strong> request{filteredTotal !== 1 ? 's' : ''} match filters</span>
          <span>Committed: <strong>${filteredCommitted.toFixed(2)}</strong></span>
          <span>Executed: <strong>${filteredExecuted.toFixed(2)}</strong></span>
        </div>
      )}

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
