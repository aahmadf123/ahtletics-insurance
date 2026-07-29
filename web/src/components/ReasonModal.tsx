import { useState } from 'react';

interface Props {
  title: string;
  /** Sentence explaining what the reason will be used for. */
  intro: string;
  label: string;
  confirmLabel: string;
  /** Danger styling for destructive actions (deny, void). */
  destructive?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

const MAX_REASON = 500;

/**
 * Collects a written reason for an action that lands in the compliance audit log.
 *
 * Deny and void previously used window.prompt, which has no styling, no length limit,
 * no validation, and is suppressed outright by some browsers. The text it collected was
 * written straight into the audit trail.
 */
export function ReasonModal({
  title, intro, label, confirmLabel, destructive, busy, error, onConfirm, onCancel,
}: Props) {
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const tooLong = reason.length > MAX_REASON;
  const canConfirm = trimmed.length >= 3 && !tooLong && !busy;

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="reason-modal-title">
      <div className="form-card modal-card" style={{ maxWidth: '520px' }}>
        <h2 id="reason-modal-title">{title}</h2>
        <p className="muted" style={{ marginTop: 0 }}>{intro}</p>

        <div className="field">
          <label htmlFor="reason-modal-input">{label}</label>
          <textarea
            id="reason-modal-input"
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={4}
            maxLength={MAX_REASON + 50}
            placeholder="Explain what needs to change, in a sentence or two."
            autoFocus
          />
          <span className="field-hint">
            {trimmed.length < 3
              ? 'Enter at least a few words. This is recorded in the audit log and shown to the coach.'
              : `${reason.length} of ${MAX_REASON} characters`}
          </span>
          {tooLong && <span className="field-error">Please keep the reason under {MAX_REASON} characters.</span>}
        </div>

        {error && <p className="error">{error}</p>}

        <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
          <button
            className={`btn ${destructive ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onConfirm(trimmed)}
            disabled={!canConfirm}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
          <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
