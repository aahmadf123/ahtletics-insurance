import type { RequestStatus } from '../types';

const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING_SPORT_ADMIN: 'Pending Sport Admin',
  PENDING_CFO: 'Pending CFO',
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
