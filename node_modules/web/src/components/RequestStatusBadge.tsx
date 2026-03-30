import type { RequestStatus } from '../types';
import { STATUS_LABELS, STATUS_COLORS } from '../types';

export function RequestStatusBadge({ status }: { status: RequestStatus }) {
  const label = STATUS_LABELS[status] ?? status;
  const color = STATUS_COLORS[status] ?? '#6b7280';

  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: '9999px',
        fontSize: '0.8rem',
        fontWeight: 600,
        color: '#fff',
        background: color,
      }}
    >
      {label}
    </span>
  );
}
