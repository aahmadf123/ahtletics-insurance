import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listRequests, listSports, bulkSignRequests } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import type { InsuranceRequest, SportProgram, RequestStatus } from '../types';

const ALL_STATUSES: RequestStatus[] = [
  'PENDING_SPORT_ADMIN', 'PENDING_CFO', 'EXECUTED', 'VOIDED', 'EXPIRED',
];

const TERM_LABELS = ['Fall', 'Spring/Summer', 'Summer'];

export function Dashboard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<InsuranceRequest[]>([]);
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  // Filters
  const [filterSport, setFilterSport] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterTerm, setFilterTerm] = useState('');
  const [filterCoach, setFilterCoach] = useState('');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSigning, setBulkSigning] = useState(false);

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  const fetchRequests = useCallback(() => {
    const params: Record<string, string> = {};
    if (filterSport) params.sport = filterSport;
    if (filterStatus) params.status = filterStatus;
    if (filterTerm) params.term = filterTerm;
    if (filterCoach) params.coach = filterCoach;

    setLoading(true);
    listRequests(params)
      .then(setRequests)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [filterSport, filterStatus, filterTerm, filterCoach]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // Determine which filters to show
  const showSportFilter = user?.role === 'coach' || user?.role === 'cfo' || user?.role === 'super_admin';
  const showStatusFilter = true; // all roles
  const showTermFilter = user?.role === 'coach' || user?.role === 'cfo' || user?.role === 'super_admin';
  const showCoachFilter = user?.role === 'cfo' || user?.role === 'super_admin';

  // Determine which rows are selectable for bulk sign
  const canBulkSign = user?.role === 'sport_admin' || user?.role === 'cfo' || user?.role === 'super_admin';
  const getSelectableStatus = (): string | null => {
    if (user?.role === 'sport_admin') return 'PENDING_SPORT_ADMIN';
    if (user?.role === 'cfo') return 'PENDING_CFO';
    if (user?.role === 'super_admin') return null; // can sign any pending
    return null;
  };

  const isRowSelectable = (r: InsuranceRequest): boolean => {
    if (!canBulkSign) return false;
    if (user?.role === 'super_admin') return r.status === 'PENDING_SPORT_ADMIN' || r.status === 'PENDING_CFO';
    const expected = getSelectableStatus();
    return expected ? r.status === expected : false;
  };

  const selectableRequests = requests.filter(isRowSelectable);
  const allSelectableSelected = selectableRequests.length > 0 && selectableRequests.every(r => selectedIds.has(r.id));

  const toggleSelectAll = () => {
    if (allSelectableSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(selectableRequests.map(r => r.id)));
    }
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkSign = async () => {
    if (selectedIds.size === 0) return;
    setBulkSigning(true);
    setError('');
    try {
      const result = await bulkSignRequests([...selectedIds]);
      setSelectedIds(new Set());
      setSuccessMsg(`Successfully approved ${result.signed} request${result.signed !== 1 ? 's' : ''}.`);
      setTimeout(() => setSuccessMsg(''), 5000);
      fetchRequests();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Bulk sign failed');
    } finally {
      setBulkSigning(false);
    }
  };

  if (loading && requests.length === 0) return <div className="page"><p className="muted">Loading…</p></div>;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard</h1>
        {user?.role === 'coach' && (
          <Link to="/request/new" className="btn btn-primary">
            + New Request
          </Link>
        )}
        {(user?.role === 'cfo' || user?.role === 'super_admin') && (
          <Link to="/reports" className="btn btn-secondary">
            Financial Reports
          </Link>
        )}
      </div>

      {/* Filter bar */}
      <div className="filters form-card">
        <div className="filter-row">
          {showSportFilter && (
            <div className="field">
              <label>Sport</label>
              <select value={filterSport} onChange={e => setFilterSport(e.target.value)}>
                <option value="">All Sports</option>
                {sports.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          {showStatusFilter && (
            <div className="field">
              <label>Status</label>
              <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
                <option value="">All Statuses</option>
                {ALL_STATUSES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
          )}
          {showTermFilter && (
            <div className="field">
              <label>Term</label>
              <select value={filterTerm} onChange={e => setFilterTerm(e.target.value)}>
                <option value="">All Terms</option>
                {TERM_LABELS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          )}
          {showCoachFilter && (
            <div className="field">
              <label>Coach Name</label>
              <input
                type="text"
                value={filterCoach}
                onChange={e => setFilterCoach(e.target.value)}
                placeholder="Search coach…"
              />
            </div>
          )}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {successMsg && <p className="success" style={{ color: '#16a34a', fontWeight: 600, padding: '8px 0' }}>{successMsg}</p>}

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
                {canBulkSign && (
                  <th style={{ width: '40px' }}>
                    <input
                      type="checkbox"
                      checked={allSelectableSelected}
                      onChange={toggleSelectAll}
                      title="Select all"
                    />
                  </th>
                )}
                <th>Student-Athlete</th>
                <th>Rocket #</th>
                <th>Sport</th>
                <th>Term</th>
                <th>Premium</th>
                <th>Coach</th>
                <th>Status</th>
                <th>Submitted</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id}>
                  {canBulkSign && (
                    <td>
                      {isRowSelectable(r) ? (
                        <input
                          type="checkbox"
                          checked={selectedIds.has(r.id)}
                          onChange={() => toggleSelect(r.id)}
                        />
                      ) : null}
                    </td>
                  )}
                  <td>{r.studentName}</td>
                  <td><code>{r.rocketNumber}</code></td>
                  <td>{r.sportName ?? r.sport}</td>
                  <td>{r.term}</td>
                  <td>${r.premiumCost.toFixed(2)}</td>
                  <td>{r.coachName}</td>
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

      {/* Bulk approve sticky bar */}
      {selectedIds.size > 0 && (
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: '#1B2A4A', color: '#fff', padding: '12px 24px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          zIndex: 1000, boxShadow: '0 -2px 8px rgba(0,0,0,0.2)',
        }}>
          <span>{selectedIds.size} request{selectedIds.size !== 1 ? 's' : ''} selected</span>
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              className="btn btn-primary"
              onClick={handleBulkSign}
              disabled={bulkSigning}
              style={{ background: '#F5A800', color: '#1B2A4A', fontWeight: 700 }}
            >
              {bulkSigning ? 'Approving…' : 'Bulk Approve'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => setSelectedIds(new Set())}
              style={{ background: 'transparent', color: '#fff', border: '1px solid #fff' }}
            >
              Clear Selection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
