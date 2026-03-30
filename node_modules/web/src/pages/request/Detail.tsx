import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { getRequest, signRequest, voidRequest } from '../../lib/api';
import { RequestStatusBadge } from '../../components/RequestStatusBadge';
import type { InsuranceRequest, Signature } from '../../types';

export function RequestDetail() {
  const { id }       = useParams<{ id: string }>();
  const { user }     = useAuth();
  const navigate     = useNavigate();

  const [req, setReq]         = useState<InsuranceRequest & { signatures: Signature[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [signing, setSigning] = useState(false);
  const [voidReason, setVoidReason] = useState('');
  const [showVoid, setShowVoid]     = useState(false);

  const load = () => {
    if (!id) return;
    setLoading(true);
    getRequest(id)
      .then(r => setReq(r as InsuranceRequest & { signatures: Signature[] }))
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  };

  useEffect(load, [id]);

  if (loading) return <div className="page"><p>Loading…</p></div>;
  if (error)   return <div className="page"><p className="error">{error}</p></div>;
  if (!req)    return <div className="page"><p>Not found.</p></div>;

  const canSign =
    (user?.role === 'sport_admin' && req.status === 'PENDING_SPORT_ADMIN') ||
    (user?.role === 'cfo'         && req.status === 'PENDING_CFO');

  const canVoid = user?.role === 'cfo' &&
    !['EXECUTED', 'VOIDED', 'EXPIRED'].includes(req.status);

  const handleSign = async () => {
    setSigning(true);
    setError('');
    try {
      await signRequest(req.id);
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Signing failed');
    } finally {
      setSigning(false);
    }
  };

  const handleVoid = async () => {
    if (!voidReason.trim()) return;
    setError('');
    try {
      await voidRequest(req.id, voidReason);
      navigate('/dashboard');
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Void failed');
    }
  };

  const fmt = (n: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Request Detail</h1>
        <RequestStatusBadge status={req.status} />
      </div>

      <div className="detail-grid">
        <div className="detail-card">
          <h2>Student-Athlete Information</h2>
          <dl>
            <dt>Full Name</dt>       <dd>{req.studentName}</dd>
            <dt>Rocket Number</dt>   <dd><code>{req.rocketNumber}</code></dd>
            <dt>Sport</dt>           <dd>{req.sport.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}</dd>
            <dt>Term</dt>            <dd>{req.term}</dd>
            <dt>Premium Cost</dt>    <dd><strong>{fmt(req.premiumCost)}</strong></dd>
            <dt>Submitted By</dt>    <dd>{req.coachName} ({req.coachEmail})</dd>
            <dt>Submitted At</dt>    <dd>{new Date(req.createdAt).toLocaleString()}</dd>
          </dl>
        </div>

        <div className="detail-card">
          <h2>Signature History</h2>
          {req.signatures?.length === 0 && <p>No signatures yet.</p>}
          <ol className="sig-list">
            {req.signatures?.map(sig => (
              <li key={sig.id} className="sig-item">
                <div className="sig-role">{sig.signatoryRole}</div>
                <div className="sig-name">{sig.signatoryName}</div>
                <div className="sig-email">{sig.signatoryEmail}</div>
                <div className="sig-time">{new Date(sig.timestamp ?? '').toLocaleString()}</div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {canSign && (
        <div className="action-box">
          <h2>Apply Your Digital Signature</h2>
          <p>
            By clicking below, you confirm that you have reviewed this request and
            authorize the premium of <strong>{fmt(req.premiumCost)}</strong> to be
            charged to the program's operating budget for <strong>{req.term}</strong>.
            Your UToledo identity (authenticated via MFA) is cryptographically bound
            to this action.
          </p>
          <button className="btn btn-primary" onClick={handleSign} disabled={signing}>
            {signing ? 'Signing…' : 'Confirm & Apply Signature'}
          </button>
        </div>
      )}

      {canVoid && !showVoid && (
        <div style={{ marginTop: 24 }}>
          <button className="btn btn-danger btn-outline" onClick={() => setShowVoid(true)}>
            Void This Request
          </button>
        </div>
      )}

      {showVoid && (
        <div className="action-box action-box--danger">
          <h2>Void Request</h2>
          <p>Voiding this request is irreversible. A written reason is required.</p>
          <textarea
            value={voidReason}
            onChange={e => setVoidReason(e.target.value)}
            placeholder="Reason for voiding…"
            rows={3}
            className="textarea"
          />
          <div className="btn-row">
            <button className="btn btn-danger" onClick={handleVoid} disabled={!voidReason.trim()}>
              Confirm Void
            </button>
            <button className="btn btn-outline" onClick={() => setShowVoid(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
