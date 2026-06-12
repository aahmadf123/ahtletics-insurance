import type { RequestStatus } from '../types';

const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING_COACH: 'Pending Head Coach',
  PENDING_APPROVAL: 'Pending Approval',
  EXECUTED: 'Executed',
  VOIDED: 'Voided',
  DENIED: 'Denied',
  EXPIRED: 'Expired',
};

interface StatusBadgeProps {
  status: RequestStatus;
  sportAdminSigned?: boolean;
  cfoSigned?: boolean;
}

function getPendingApprovalLabel(sportAdminSigned?: boolean, cfoSigned?: boolean): string {
  const needsSportAdmin = !sportAdminSigned;
  const needsCfo = !cfoSigned;
  if (needsSportAdmin && needsCfo) return 'Pending Approval';
  if (needsCfo) return 'Pending CFO';
  if (needsSportAdmin) return 'Pending Sport Admin';
  return 'Pending Approval';
}

export function StatusBadge({ status, sportAdminSigned, cfoSigned }: StatusBadgeProps) {
  const label =
    status === 'PENDING_APPROVAL'
      ? getPendingApprovalLabel(sportAdminSigned, cfoSigned)
      : STATUS_LABELS[status];

  return (
    <span className={`badge badge--${status.toLowerCase().replace(/_/g, '-')}`}>
      {label}
    </span>
  );
}
