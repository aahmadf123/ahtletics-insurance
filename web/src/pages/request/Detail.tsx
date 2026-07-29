import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import {
  getRequest, voidRequest, signRequest, getRequestPdfUrl, getRequestCalendarUrl,
  deleteRequest, denyRequest, listRequestEmails, type EmailLogEntry,
} from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import { fundingSourceLabel } from '../../types';
import type { RequestDetail } from '../../types';

/**
 * Shows what the portal tried to send about this request and what came back.
 *
 * University mail filtering silently quarantines these notifications, so an approval
 * stalling is usually a delivery question, not a workflow question. The copy-link button
 * makes the existing manual workaround (paste the link into a message the recipient will
 * actually see) a supported action rather than something done by hand.
 */
function DeliveryLog({ requestId }: { requestId: string }) {
  const [entries, setEntries] = useState<EmailLogEntry[] | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/request/${requestId}`;

  useEffect(() => {
    listRequestEmails(requestId)
      .then(setEntries)
      .catch(err => setError(err.message));
  }, [requestId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError('Could not copy automatically. Select the address above and copy it manually.');
    }
  };

  return (
    <div className="form-card">
      <h2>Notification Delivery</h2>
      <p className="muted" style={{ marginTop: 0 }}>
        University mail filtering can hold these messages without bouncing them. A status
        of Sent means the provider accepted it, not that it reached an inbox. If an
        approver says they never received it, send them the link directly.
      </p>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <code style={{ wordBreak: 'break-all', fontSize: '0.85rem' }}>{link}</code>
        <button className="btn btn-secondary" onClick={copyLink}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {entries === null ? (
        <p className="muted">Loading delivery history…</p>
      ) : entries.length === 0 ? (
        <p className="muted">No notifications have been sent for this request yet.</p>
      ) : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr><th>Sent</th><th>Recipient</th><th>Subject</th><th>Status</th></tr>
            </thead>
            <tbody>
              {entries.map(e => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleString()}</td>
                  <td>{e.toEmail}</td>
                  <td>{e.subject}</td>
                  <td>
                    <span className={`badge ${e.status === 'sent' ? 'badge--executed' : 'badge--voided'}`}>
                      {e.status}
                    </span>
                    {e.error && <div className="field-error">{e.error}</div>}
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

export function RequestDetail() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [req, setReq] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showVoidForm, setShowVoidForm] = useState(false);
  const [denying, setDenying] = useState(false);
  const [denyReason, setDenyReason] = useState('');
  const [showDenyForm, setShowDenyForm] = useState(false);
  const [showConfirmSign, setShowConfirmSign] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const [signedMessage, setSignedMessage] = useState('');
  const [coachNameInput, setCoachNameInput] = useState('');

  const loadRequest = () => {
    if (!id) return;
    setLoading(true);
    getRequest(id)
      .then(r => {
        setReq(r);
        // Pre-fill the coach's name (maintained per sport by the Super Admin) for signing.
        if (r.coachName) setCoachNameInput(prev => prev || r.coachName);
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadRequest, [id]);

  const handleSign = async () => {
    if (!id) return;
    if (user?.role === 'coach' && !coachNameInput.trim()) {
      setError('Please enter your full name to sign.');
      return;
    }
    setSigning(true);
    setError('');
    try {
      await signRequest(id, user?.role === 'coach' ? coachNameInput.trim() : undefined);
      setShowConfirmSign(false);
      setSigning(false);
      // Stay here and reload rather than bouncing to the dashboard. The signer needs to
      // see that the signature landed, what the status is now, and, once every approval
      // is in, the completed authorization form.
      setSignedMessage('Your signature has been recorded.');
      loadRequest();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Signing failed');
      setSigning(false);
    }
  };

  const handleVoid = async () => {
    if (!id || !voidReason.trim()) return;
    setVoiding(true);
    setError('');
    try {
      await voidRequest(id, voidReason.trim());
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Void failed');
    } finally {
      setVoiding(false);
    }
  };

  const handleDelete = async () => {
    if (!id) return;
    setDeleting(true);
    setError('');
    try {
      await deleteRequest(id);
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

  const handleDeny = async () => {
    if (!id || !denyReason.trim()) return;
    setDenying(true);
    setError('');
    try {
      await denyRequest(id, denyReason.trim());
      navigate('/dashboard');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Deny failed');
      setDenying(false);
    }
  };

  // Re-open the request form pre-populated with this request's data so the coach can
  // fix the issue and resubmit as a new, linked request (1.5).
  const handleResubmit = () => {
    if (!req) return;
    navigate('/request/new', { state: { resubmit: { ...req, parentRequestId: req.id } } });
  };

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!req) return <div className="page"><p className="error">{error || 'Request not found.'}</p></div>;

  // Parallel approval: Sport Admin and CFO may approve in any order; each can sign
  // only if their own approval is still outstanding.
  const awaitingApproval = req.status === 'PENDING_APPROVAL';
  const isPending = req.status === 'PENDING_COACH' || req.status === 'PENDING_APPROVAL';
  const canSign =
    (user?.role === 'coach' && req.status === 'PENDING_COACH') ||
    (user?.role === 'sport_admin' && awaitingApproval && !req.sportAdminSigned) ||
    (user?.role === 'cfo' && awaitingApproval && !req.cfoSigned) ||
    (user?.role === 'super_admin' && awaitingApproval && (!req.sportAdminSigned || !req.cfoSigned));

  // The head coach denies at their step; Sport Admin and CFO deny at approval;
  // Super Admin can deny while pending.
  // Denial requires a written reason (1.4).
  const canDeny =
    (user?.role === 'coach' && req.status === 'PENDING_COACH') ||
    ((user?.role === 'sport_admin' || user?.role === 'cfo') && awaitingApproval) ||
    (user?.role === 'super_admin' && isPending);

  const canResubmit = req.status === 'DENIED' && (user?.role === 'coach' || user?.role === 'super_admin');

  const hasSomeSignatures = req.signatures.length > 0;

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/dashboard" className="back-link">← Dashboard</Link>
        <StatusBadge status={req.status} sportAdminSigned={req.sportAdminSigned} cfoSigned={req.cfoSigned} />
      </div>

      <h1>Insurance Request: {req.studentName}</h1>

      {signedMessage && (
        <p className="success" style={{ color: '#16a34a', fontWeight: 600 }}>
          {signedMessage}{' '}
          {req.status === 'EXECUTED'
            ? 'All approvals are in and the request is executed.'
            : 'It now moves to the next approver.'}
        </p>
      )}

      {req.status === 'DENIED' && (
        <div className="action-zone action-zone--danger" style={{ marginTop: 0, marginBottom: '1rem' }}>
          <h2 style={{ marginTop: 0 }}>This request was denied</h2>
          {req.denialReason && (
            <p style={{ margin: '0 0 .75rem' }}><strong>Reason:</strong> {req.denialReason}</p>
          )}
          {canResubmit && (
            <>
              <p className="action-note">
                You can correct the issue and resubmit. A new request will be created and linked to this one for the audit trail.
              </p>
              <button className="btn btn-primary" onClick={handleResubmit}>Fix &amp; Resubmit</button>
            </>
          )}
        </div>
      )}

      <div className="detail-grid">
        <div className="form-card">
          <h2>Student-Athlete</h2>
          <dl className="detail-list">
            <dt>Full Name</dt><dd>{req.studentName}</dd>
            <dt>Rocket Number</dt><dd><code>{req.rocketNumber}</code></dd>
            <dt>Sport</dt><dd>{req.sportName ?? req.sport}</dd>
            <dt>Term</dt><dd>{req.term}</dd>
            <dt>Premium</dt><dd><strong>${req.premiumCost.toFixed(2)}</strong></dd>
            <dt>Funding Source</dt><dd>{fundingSourceLabel(req.fundingSource)}</dd>
          </dl>
        </div>

        <div className="form-card">
          <h2>Submission Info</h2>
          <dl className="detail-list">
            <dt>Coach</dt><dd>{req.coachName}</dd>
            {req.coachEmail && <><dt>Email</dt><dd>{req.coachEmail}</dd></>}
            <dt>Submitted</dt><dd>{new Date(req.createdAt).toLocaleString()}</dd>
            {req.sportAdminName && <><dt>Sport Admin</dt><dd>{req.sportAdminName}</dd></>}
          </dl>
        </div>
      </div>

      <div className="form-card">
        <h2>Signature Audit Trail</h2>
        {req.signatures.length === 0 ? (
          <p className="muted">No signatures recorded yet.</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr><th>Role</th><th>Signatory</th><th>Email</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              {req.signatures.map(sig => (
                <tr key={sig.id}>
                  <td>{sig.signatoryRole}</td>
                  <td>{sig.signatoryName}</td>
                  <td>{sig.signatoryEmail || '—'}</td>
                  <td>{new Date(sig.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {hasSomeSignatures && (
        <div className="form-card">
          <h2>Authorization Document</h2>
          <p>View or download the Insurance Authorization Form with all recorded signatures.</p>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
            <button
              className="btn btn-secondary"
              onClick={() => setShowPdfPreview(true)}
            >
              Preview PDF
            </button>
            <a
              className="btn btn-primary"
              href={getRequestPdfUrl(req.id)}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-block', textDecoration: 'none' }}
            >
              Download PDF
            </a>
          </div>
        </div>
      )}

      {isPending && (
        <div className="form-card">
          <h2>Deadline Reminder</h2>
          <p className="muted" style={{ marginTop: 0 }}>
            Add the submission deadline for this request to your calendar. This used to be
            attached to the approval email, but calendar attachments from an unfamiliar
            sender are frequently held by university mail filtering.
          </p>
          <a
            className="btn btn-secondary"
            href={getRequestCalendarUrl(req.id)}
            style={{ display: 'inline-block', textDecoration: 'none' }}
          >
            Add deadline to calendar
          </a>
        </div>
      )}

      {(user?.role === 'cfo' || user?.role === 'super_admin') && <DeliveryLog requestId={req.id} />}

      {showPdfPreview && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000,
        }} onClick={() => setShowPdfPreview(false)}>
          <div style={{
            background: '#fff', borderRadius: '8px', width: '90vw', height: '90vh',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
          }} onClick={e => e.stopPropagation()}>
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '12px 16px', borderBottom: '1px solid #e5e7eb',
            }}>
              <strong>PDF Preview</strong>
              <button className="btn btn-secondary" onClick={() => setShowPdfPreview(false)}>
                Close
              </button>
            </div>
            <iframe
              src={getRequestPdfUrl(req.id)}
              style={{ flex: 1, border: 'none', width: '100%' }}
              title="PDF Preview"
            />
          </div>
        </div>
      )}

      {canSign && !showConfirmSign && (
        <div className="action-zone">
          <div className="form-card" style={{ borderLeft: '4px solid #F5A800' }}>
            <h2>Signature Confirmation</h2>
            <dl className="detail-list">
              <dt>Signatory</dt><dd>{user?.name} ({user?.role?.replace(/_/g, ' ')})</dd>
              <dt>Timestamp</dt><dd>{new Date().toLocaleString()}</dd>
            </dl>
            <p style={{ fontSize: '0.875rem', color: '#555', margin: '12px 0' }}>
              By clicking <strong>Approve &amp; Sign</strong>, you confirm that you have reviewed this
              request and authorize the deduction of <strong>${req.premiumCost.toFixed(2)}</strong> from
              the <strong>{req.sportName ?? req.sport}</strong> {fundingSourceLabel(req.fundingSource)}.
            </p>
            <button
              className="btn btn-primary"
              onClick={() => setShowConfirmSign(true)}
            >
              Approve &amp; Sign
            </button>
          </div>
        </div>
      )}

      {showConfirmSign && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center',
          justifyContent: 'center', zIndex: 2000,
        }}>
          <div className="form-card" style={{ maxWidth: '480px', margin: '0 auto' }}>
            <h2>Please confirm your signature</h2>
            <p>
              You are about to digitally sign this insurance request for <strong>{req.studentName}</strong>.
              This action cannot be undone.
            </p>
            {error && <p className="error" style={{ marginTop: '12px' }}>{error}</p>}
            {user?.role === 'coach' && (
              <div className="field" style={{ marginTop: '16px' }}>
                <label>Please enter your full name to sign as Coach:</label>
                <input
                  type="text"
                  value={coachNameInput}
                  onChange={e => setCoachNameInput(e.target.value)}
                  placeholder="Your full name"
                  maxLength={200}
                />
              </div>
            )}
            <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
              <button
                className="btn btn-primary"
                onClick={handleSign}
                disabled={signing}
              >
                {signing ? 'Signing…' : 'Confirm & Sign'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => { setShowConfirmSign(false); setError(''); }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {canDeny && (
        <div className="action-zone action-zone--danger">
          {!showDenyForm ? (
            <>
              <p className="action-note">
                If this request can't be approved as submitted, deny it with a reason. The coach will be notified and can fix &amp; resubmit.
              </p>
              <button className="btn btn-danger" onClick={() => setShowDenyForm(true)}>
                Deny This Request
              </button>
            </>
          ) : (
            <div className="void-form">
              <label htmlFor="deny-reason">Reason for denial (required)</label>
              <textarea
                id="deny-reason"
                value={denyReason}
                onChange={e => setDenyReason(e.target.value)}
                rows={3}
                placeholder="Explain what needs to be corrected…"
              />
              <div className="void-actions">
                <button className="btn btn-danger" onClick={handleDeny} disabled={denying || !denyReason.trim()}>
                  {denying ? 'Denying…' : 'Confirm Denial'}
                </button>
                <button className="btn btn-secondary" onClick={() => { setShowDenyForm(false); setDenyReason(''); }}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {(user?.role === 'cfo' || user?.role === 'super_admin') && (req.status === 'PENDING_APPROVAL' || req.status === 'PENDING_COACH') && (
        <div className="action-zone action-zone--danger">
          {!showVoidForm ? (
            <button className="btn btn-danger" onClick={() => setShowVoidForm(true)}>
              Void This Request
            </button>
          ) : (
            <div className="void-form">
              <label htmlFor="void-reason">Reason for voiding (required)</label>
              <textarea
                id="void-reason"
                value={voidReason}
                onChange={e => setVoidReason(e.target.value)}
                rows={3}
                placeholder="Describe why this request is being voided…"
              />
              <div className="void-actions">
                <button
                  className="btn btn-danger"
                  onClick={handleVoid}
                  disabled={voiding || !voidReason.trim()}
                >
                  {voiding ? 'Voiding…' : 'Confirm Void'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => { setShowVoidForm(false); setVoidReason(''); }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {user?.role === 'super_admin' && (
        <div className="action-zone action-zone--danger" style={{ marginTop: '1rem' }}>
          {!showConfirmDelete ? (
            <button className="btn btn-danger" onClick={() => setShowConfirmDelete(true)}>
              Permanently Delete Request
            </button>
          ) : (
            <div>
              <p style={{ marginBottom: '12px', fontWeight: 600 }}>
                Are you sure? This will permanently delete this request and all its signatures.
              </p>
              <div style={{ display: 'flex', gap: '12px' }}>
                <button
                  className="btn btn-danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setShowConfirmDelete(false)}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
