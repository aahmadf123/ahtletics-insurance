import type { RequestStatus } from '../types';

const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING_COACH: 'Pending Coach',
  PENDING_APPROVAL: 'Pending Approval',
  EXECUTED: 'Executed',
  VOIDED: 'Voided',
  EXPIRED: 'Expired',
};

interface StatusBadgeProps {
  status: RequestStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span className={`badge badge--${status.toLowerCase().replace(/_/g, '-')}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}
