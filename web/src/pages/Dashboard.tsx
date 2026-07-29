import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { listRequests, listSports, bulkSignRequests, bulkDenyRequests, bulkVoidRequests, bulkDeleteRequests } from '../lib/api';
import { StatusBadge } from '../components/StatusBadge';
import { ReasonModal } from '../components/ReasonModal';
import { TERMS } from '../types';
import type { InsuranceRequest, SportProgram, RequestStatus } from '../types';

const ALL_STATUSES: RequestStatus[] = [
  'PENDING_COACH', 'PENDING_APPROVAL', 'EXECUTED', 'DENIED', 'VOIDED', 'EXPIRED',
];

const TERM_LABELS = TERMS.map(t => t.key);

const PAGE_SIZE = 50;

// Only terminal records can be bulk deleted. Deleting a live request destroys its audit
// rows mid-workflow; voiding is the correct way to stop one that is still in flight.
const DELETABLE_STATUSES: RequestStatus[] = ['EXECUTED', 'VOIDED', 'DENIED', 'EXPIRED'];

export function Dashboard() {
  const { user } = useAuth();
  const [requests, setRequests] = useState<InsuranceRequest[]>([]);
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');

  const [showBulkSignModal, setShowBulkSignModal] = useState(false);
  const [coachNameInput, setCoachNameInput] = useState('');

  // Which confirmation modal is open, replacing window.prompt / window.confirm.
  const [prompt, setPrompt] = useState<'deny' | 'void' | 'delete' | null>(null);
  const [modalError, setModalError] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState('');

  const [page, setPage] = useState(0);

  // Filters
  const [filterSport, setFilterSport] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterTerm, setFilterTerm] = useState('');
  const [filterCoach, setFilterCoach] = useState('');

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkSigning, setBulkSigning] = useState(false);
  const [bulkActing, setBulkActing] = useState(false);

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  // Ask for one row beyond the page so we know whether a next page exists without a
  // separate count query.
  const [hasMore, setHasMore] = useState(false);

  const fetchRequests = useCallback(() => {
    const params: Record<string, string> = {
      limit: String(PAGE_SIZE + 1),
      offset: String(page * PAGE_SIZE),
    };
    if (filterSport) params.sport = filterSport;
    if (filterStatus) params.status = filterStatus;
    if (filterTerm) params.term = filterTerm;
    if (filterCoach) params.coach = filterCoach;

    setLoading(true);
    listRequests(params)
      .then(rows => {
        setHasMore(rows.length > PAGE_SIZE);
        setRequests(rows.slice(0, PAGE_SIZE));
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [filterSport, filterStatus, filterTerm, filterCoach, page]);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  // A filter change makes the current offset meaningless.
  useEffect(() => {
    setPage(0);
    setSelectedIds(new Set());
  }, [filterSport, filterStatus, filterTerm, filterCoach]);

  // Clear the success banner on a timer, cancelling it if the component unmounts first.
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(''), 5000);
    return () => clearTimeout(t);
  }, [successMsg]);

  // Determine which filters to show
  const showSportFilter = user?.role === 'coach' || user?.role === 'cfo' || user?.role === 'super_admin';
  const showStatusFilter = true; // all roles
  const showTermFilter = user?.role === 'coach' || user?.role === 'cfo' || user?.role === 'super_admin';
  const showCoachFilter = user?.role === 'cfo' || user?.role === 'super_admin';

  // Determine role-based bulk actions.
  const canBulkSign = user?.role === 'coach' || user?.role === 'sport_admin' || user?.role === 'cfo' || user?.role === 'super_admin';
  const canBulkDeny = user?.role === 'coach' || user?.role === 'sport_admin' || user?.role === 'cfo' || user?.role === 'super_admin';
  const canBulkVoid = user?.role === 'super_admin';
  const canBulkDelete = user?.role === 'super_admin';

  const isApprovable = (r: InsuranceRequest): boolean => {
    if (!canBulkSign) return false;
    if (user?.role === 'coach') return r.status === 'PENDING_COACH';
    if (r.status !== 'PENDING_APPROVAL') return false;
    if (user?.role === 'sport_admin') return !r.sportAdminSigned;
    if (user?.role === 'cfo') return !r.cfoSigned;
    if (user?.role === 'super_admin') return !r.sportAdminSigned || !r.cfoSigned;
    return false;
  };

  const isDeniable = (r: InsuranceRequest): boolean => {
    if (!canBulkDeny) return false;
    if (user?.role === 'coach') return r.status === 'PENDING_COACH';
    if (user?.role === 'sport_admin' || user?.role === 'cfo') return r.status === 'PENDING_APPROVAL';
    if (user?.role === 'super_admin') return r.status === 'PENDING_COACH' || r.status === 'PENDING_APPROVAL';
    return false;
  };

  const isVoidable = (r: InsuranceRequest): boolean =>
    !!canBulkVoid && (r.status === 'PENDING_COACH' || r.status === 'PENDING_APPROVAL');

  // Previously returned true for every row, so "select all" swept up live requests and
  // one confirm dialog erased them along with their audit trail.
  const isDeletable = (r: InsuranceRequest): boolean =>
    !!canBulkDelete && DELETABLE_STATUSES.includes(r.status);

  const isRowSelectable = (r: InsuranceRequest): boolean => {
    return isApprovable(r) || isDeniable(r) || isVoidable(r) || isDeletable(r);
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
    if (user?.role === 'coach') {
      if (!showBulkSignModal) {
        setShowBulkSignModal(true);
        return;
      }
      if (!coachNameInput.trim()) {
        setError('Please enter your full name to sign.');
        return;
      }
    }
    setBulkSigning(true);
    setError('');
    try {
      const result = await bulkSignRequests([...selectedIds], user?.role === 'coach' ? coachNameInput.trim() : undefined);
      setSelectedIds(new Set());
      setShowBulkSignModal(false);
      setSuccessMsg(`Approved ${result.signed} request${result.signed !== 1 ? 's' : ''}.`);
      fetchRequests();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Bulk sign failed');
    } finally {
      setBulkSigning(false);
    }
  };

  const selectedRequests = requests.filter(r => selectedIds.has(r.id));
  const selectedApprovableIds = selectedRequests.filter(isApprovable).map(r => r.id);
  const selectedDeniableIds = selectedRequests.filter(isDeniable).map(r => r.id);
  const selectedVoidableIds = selectedRequests.filter(isVoidable).map(r => r.id);
  const selectedDeletableIds = selectedRequests.filter(isDeletable).map(r => r.id);

  const handleBulkDeny = async (reason: string) => {
    if (selectedDeniableIds.length === 0) return;
    setBulkActing(true);
    setModalError('');
    try {
      const result = await bulkDenyRequests(selectedDeniableIds, reason);
      setSelectedIds(new Set());
      setPrompt(null);
      setSuccessMsg(`Declined ${result.denied} request${result.denied !== 1 ? 's' : ''}.`);
      fetchRequests();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Bulk decline failed');
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkVoid = async (reason: string) => {
    if (selectedVoidableIds.length === 0) return;
    setBulkActing(true);
    setModalError('');
    try {
      const result = await bulkVoidRequests(selectedVoidableIds, reason);
      setSelectedIds(new Set());
      setPrompt(null);
      setSuccessMsg(`Voided ${result.voided} request${result.voided !== 1 ? 's' : ''}.`);
      fetchRequests();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Bulk void failed');
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedDeletableIds.length === 0) return;
    if (deleteConfirm.trim() !== String(selectedDeletableIds.length)) return;
    setBulkActing(true);
    setModalError('');
    try {
      const result = await bulkDeleteRequests(selectedDeletableIds);
      setSelectedIds(new Set());
      setPrompt(null);
      setDeleteConfirm('');
      setSuccessMsg(`Deleted ${result.deleted} request${result.deleted !== 1 ? 's' : ''}.`);
      fetchRequests();
    } catch (err: unknown) {
      setModalError(err instanceof Error ? err.message : 'Bulk delete failed');
    } finally {
      setBulkActing(false);
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
                  <td><StatusBadge status={r.status} sportAdminSigned={r.sportAdminSigned} cfoSigned={r.cfoSigned} /></td>
                  <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                  <td>
                    <Link to={`/request/${r.id}`} className="link">View</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="pager">
            <span className="muted">
              Showing {page * PAGE_SIZE + 1} to {page * PAGE_SIZE + requests.length}
              {hasMore ? '' : ` of ${page * PAGE_SIZE + requests.length}`}
            </span>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn btn-secondary"
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0 || loading}
              >
                Previous
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => setPage(p => p + 1)}
                disabled={!hasMore || loading}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      )}

      {prompt === 'deny' && (
        <ReasonModal
          title={`Decline ${selectedDeniableIds.length} request${selectedDeniableIds.length !== 1 ? 's' : ''}`}
          intro="The coach is emailed this reason and can correct the issue and resubmit."
          label="Reason for declining (required)"
          confirmLabel="Confirm decline"
          destructive
          busy={bulkActing}
          error={modalError}
          onConfirm={handleBulkDeny}
          onCancel={() => setPrompt(null)}
        />
      )}

      {prompt === 'void' && (
        <ReasonModal
          title={`Void ${selectedVoidableIds.length} request${selectedVoidableIds.length !== 1 ? 's' : ''}`}
          intro="Everyone named on the request is notified. Voiding is final; a voided request cannot be resubmitted."
          label="Reason for voiding (required)"
          confirmLabel="Confirm void"
          destructive
          busy={bulkActing}
          error={modalError}
          onConfirm={handleBulkVoid}
          onCancel={() => setPrompt(null)}
        />
      )}

      {prompt === 'delete' && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-title">
          <div className="form-card modal-card" style={{ maxWidth: '520px' }}>
            <h2 id="bulk-delete-title">Permanently delete {selectedDeletableIds.length} request{selectedDeletableIds.length !== 1 ? 's' : ''}</h2>
            <p className="muted" style={{ marginTop: 0 }}>
              This erases the requests and their signatures. A record of the deletion stays
              in the audit log, but the requests themselves cannot be recovered.
            </p>
            <div className="field">
              <label htmlFor="bulk-delete-confirm">
                Type <strong>{selectedDeletableIds.length}</strong> to confirm
              </label>
              <input
                id="bulk-delete-confirm"
                type="text"
                value={deleteConfirm}
                onChange={e => setDeleteConfirm(e.target.value)}
                autoFocus
              />
            </div>
            {modalError && <p className="error">{modalError}</p>}
            <div style={{ display: 'flex', gap: '12px' }}>
              <button
                className="btn btn-danger"
                onClick={handleBulkDelete}
                disabled={bulkActing || deleteConfirm.trim() !== String(selectedDeletableIds.length)}
              >
                {bulkActing ? 'Deleting…' : 'Delete permanently'}
              </button>
              <button className="btn btn-secondary" onClick={() => setPrompt(null)} disabled={bulkActing}>
                Cancel
              </button>
            </div>
          </div>
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
            {selectedApprovableIds.length > 0 && (
              <button
                className="btn btn-primary"
                onClick={handleBulkSign}
                disabled={bulkSigning || bulkActing}
                style={{ background: '#F5A800', color: '#1B2A4A', fontWeight: 700 }}
              >
                {bulkSigning ? 'Approving…' : `Bulk Approve (${selectedApprovableIds.length})`}
              </button>
            )}
            {selectedDeniableIds.length > 0 && (
              <button
                className="btn btn-secondary"
                onClick={() => { setModalError(''); setPrompt('deny'); }}
                disabled={bulkSigning || bulkActing}
                style={{ background: '#dc2626', color: '#fff', border: '1px solid #dc2626' }}
              >
                {`Bulk Decline (${selectedDeniableIds.length})`}
              </button>
            )}
            {selectedVoidableIds.length > 0 && (
              <button
                className="btn btn-secondary"
                onClick={() => { setModalError(''); setPrompt('void'); }}
                disabled={bulkSigning || bulkActing}
                style={{ background: '#6b7280', color: '#fff', border: '1px solid #6b7280' }}
              >
                {`Bulk Void (${selectedVoidableIds.length})`}
              </button>
            )}
            {selectedDeletableIds.length > 0 && (
              <button
                className="btn btn-secondary"
                onClick={() => { setModalError(''); setDeleteConfirm(''); setPrompt('delete'); }}
                disabled={bulkSigning || bulkActing}
                style={{ background: '#111827', color: '#fff', border: '1px solid #111827' }}
              >
                {`Bulk Delete (${selectedDeletableIds.length})`}
              </button>
            )}
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

      {showBulkSignModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="form-card" style={{ maxWidth: '480px', margin: '0 auto', width: '100%' }}>
            <h2>Confirm Bulk Signature</h2>
            <p>You are about to digitally sign <strong>{selectedIds.size} request{selectedIds.size !== 1 ? 's' : ''}</strong>.</p>
            {error && <p className="error" style={{ marginTop: '12px' }}>{error}</p>}
            <div className="field" style={{ marginTop: '16px' }}>
              <label>Please enter your full name to sign as Coach:</label>
              <input
                type="text"
                value={coachNameInput}
                onChange={e => setCoachNameInput(e.target.value)}
                placeholder="Your full name"
                maxLength={200}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button
                className="btn btn-primary"
                onClick={handleBulkSign}
                disabled={bulkSigning}
              >
                {bulkSigning ? 'Approving…' : 'Confirm & Sign All'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowBulkSignModal(false); setError(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
