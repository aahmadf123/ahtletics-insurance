import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { getRequest, voidRequest, signRequest, getRequestPdfUrl } from '../../lib/api';
import { StatusBadge } from '../../components/StatusBadge';
import type { RequestDetail } from '../../types';

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
  const [showConfirmSign, setShowConfirmSign] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);
  const [signSuccess, setSignSuccess] = useState<{ name: string; timestamp: string } | null>(null);
  const [error, setError] = useState('');

  const loadRequest = () => {
    if (!id) return;
    setLoading(true);
    getRequest(id)
      .then(setReq)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  };

  useEffect(loadRequest, [id]);

  const handleSign = async () => {
    if (!id) return;
    setSigning(true);
    setError('');
    try {
      await signRequest(id);
      setShowConfirmSign(false);
      setSignSuccess({
        name: user?.name ?? 'Unknown',
        timestamp: new Date().toLocaleString(),
      });
      loadRequest();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Signing failed');
    } finally {
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

  if (loading) return <div className="page"><p className="muted">Loading…</p></div>;
  if (!req) return <div className="page"><p className="error">{error || 'Request not found.'}</p></div>;

  const canSign =
    (user?.role === 'sport_admin' && req.status === 'PENDING_SPORT_ADMIN') ||
    (user?.role === 'cfo' && req.status === 'PENDING_CFO') ||
    (user?.role === 'super_admin' && (req.status === 'PENDING_SPORT_ADMIN' || req.status === 'PENDING_CFO'));

  const hasSomeSignatures = req.signatures.length > 0;

  return (
    <div className="page">
      <div className="page-header">
        <Link to="/dashboard" className="back-link">← Dashboard</Link>
        <StatusBadge status={req.status} />
      </div>

      <h1>Insurance Request — {req.studentName}</h1>

      <div className="detail-grid">
        <div className="form-card">
          <h2>Student-Athlete</h2>
          <dl className="detail-list">
            <dt>Full Name</dt><dd>{req.studentName}</dd>
            <dt>Rocket Number</dt><dd><code>{req.rocketNumber}</code></dd>
            <dt>Sport</dt><dd>{req.sportName ?? req.sport}</dd>
            <dt>Term</dt><dd>{req.term}</dd>
            <dt>Premium</dt><dd><strong>${req.premiumCost.toFixed(2)}</strong></dd>
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

      {signSuccess && (
        <div className="form-card" style={{ borderLeft: '4px solid #16a34a', background: '#f0fdf4' }}>
          <h2 style={{ color: '#16a34a' }}>✓ Signature Recorded</h2>
          <p>Signed by <strong>{signSuccess.name}</strong> at {signSuccess.timestamp}</p>
        </div>
      )}

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
              the <strong>{req.sportName ?? req.sport}</strong> operating budget.
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
                onClick={() => setShowConfirmSign(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {(user?.role === 'cfo' || user?.role === 'super_admin') && ['PENDING_SPORT_ADMIN', 'PENDING_CFO'].includes(req.status) && (
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
    </div>
  );
}
