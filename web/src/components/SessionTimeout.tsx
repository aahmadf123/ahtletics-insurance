import { useEffect, useRef, useState, useCallback } from 'react';

const IDLE_MS = 15 * 60 * 1000;   // 15 minutes of inactivity before the warning
const COUNTDOWN_S = 60;            // 60-second grace period to respond
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'click'] as const;

/**
 * Auto-logout for idle sessions (3.4 — FERPA/HIPAA alignment for student health data).
 * Activity is tracked in memory only (Workers' sandbox blocks localStorage). After 15
 * minutes idle a modal warns with a 60-second countdown; on expiry the user is signed out.
 */
export function SessionTimeout({ onTimeout }: { onTimeout: () => void }) {
  const [warning, setWarning] = useState(false);
  const [remaining, setRemaining] = useState(COUNTDOWN_S);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimers = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (countdownTimer.current) clearInterval(countdownTimer.current);
  };

  const startIdleTimer = useCallback(() => {
    if (idleTimer.current) clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setWarning(true), IDLE_MS);
  }, []);

  // Reset the idle timer on any user activity, but only while the warning isn't showing.
  const onActivity = useCallback(() => {
    if (!warning) startIdleTimer();
  }, [warning, startIdleTimer]);

  useEffect(() => {
    startIdleTimer();
    ACTIVITY_EVENTS.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    return () => {
      ACTIVITY_EVENTS.forEach(e => window.removeEventListener(e, onActivity));
      clearTimers();
    };
  }, [onActivity, startIdleTimer]);

  // Drive the countdown once the warning appears.
  useEffect(() => {
    if (!warning) return;
    setRemaining(COUNTDOWN_S);
    countdownTimer.current = setInterval(() => {
      setRemaining(prev => {
        if (prev <= 1) {
          clearTimers();
          onTimeout();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (countdownTimer.current) clearInterval(countdownTimer.current); };
  }, [warning, onTimeout]);

  const stayActive = () => {
    setWarning(false);
    startIdleTimer();
  };

  if (!warning) return null;

  return (
    <div className="modal-overlay" role="alertdialog" aria-modal="true" aria-labelledby="session-timeout-title">
      <div className="form-card modal-card" style={{ maxWidth: '420px' }}>
        <h2 id="session-timeout-title">You've been inactive</h2>
        <p>
          For the security of student health information, you'll be signed out in{' '}
          <strong>{remaining}</strong> second{remaining !== 1 ? 's' : ''}.
        </p>
        <div style={{ display: 'flex', gap: '12px', marginTop: '16px' }}>
          <button className="btn btn-primary" onClick={stayActive}>Stay signed in</button>
          <button className="btn btn-secondary" onClick={onTimeout}>Sign out now</button>
        </div>
      </div>
    </div>
  );
}
