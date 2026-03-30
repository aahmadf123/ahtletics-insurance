import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { getRequest, signRequest, voidRequest } from '../../lib/api';
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
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    getRequest(id)
      .then(setReq)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const handleSign = async () => {
    if (!id) return;
    setSigning(true);
    setError('');
    try {
      await signRequest(id);
      const updated = await getRequest(id);
      setReq(updated);
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
    (user?.role === 'cfo' && (req.status === 'PENDING_CFO' || (req.status === 'PENDING_SPORT_ADMIN' && req.sport === 'womens_softball')));

  const alreadySigned = req.signatures.some(s => s.signatoryEmail === user?.email);

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
            <dt>Email</dt><dd>{req.coachEmail}</dd>
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
                  <td>{sig.signatoryEmail}</td>
                  <td>{new Date(sig.timestamp).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {req.envelopeId && (
        <div className="form-card">
          <h2>DocuSign eSignature</h2>
          <p>This request is being signed via DocuSign. Signers will receive an email from DocuSign to review and sign the authorization document.</p>
          <dl className="detail-list">
            <dt>Envelope ID</dt><dd><code>{req.envelopeId}</code></dd>
            <dt>Status</dt><dd><StatusBadge status={req.status} /></dd>
          </dl>
        </div>
      )}

      {canSign && !alreadySigned && !req.envelopeId && (
        <div className="action-zone">
          <p className="action-note">
            By clicking below, you are applying your digital signature to this request.
          </p>
          <button
            className="btn btn-primary"
            onClick={handleSign}
            disabled={signing}
          >
            {signing ? 'Applying Signature…' : 'Apply My Signature'}
          </button>
        </div>
      )}

      {user?.role === 'cfo' && ['PENDING_SPORT_ADMIN', 'PENDING_CFO'].includes(req.status) && (
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
