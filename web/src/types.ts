// Shared TypeScript types for the frontend

export type RequestStatus =
  | 'PENDING_SPORT_ADMIN'
  | 'PENDING_CFO'
  | 'EXECUTED'
  | 'VOIDED'
  | 'EXPIRED';

export interface InsuranceRequest {
  id: string;
  studentName: string;
  rocketNumber: string;
  sport: string;
  term: string;
  premiumCost: number;
  status: RequestStatus;
  workflowInstanceId: string | null;
  coachEmail: string;
  coachName: string;
  createdAt: string;
  signatures?: Signature[];
}

export interface Signature {
  id: string;
  requestId: string;
  signatoryRole: string;
  signatoryEmail: string;
  signatoryName: string;
  ipAddress: string;
  timestamp: string;
}

export interface SportProgram {
  id: string;
  name: string;
  gender: string;
  headCoach?: string;
  sportAdminId?: string | null;
  adminName?: string | null;
  adminEmail?: string | null;
}

export interface SportAdministrator {
  id: string;
  name: string;
  title: string;
  email: string;
  isCfo: number;
}

export interface SessionUser {
  email: string;
  displayName: string;
  role: 'coach' | 'sport_admin' | 'cfo';
  adminSportIds?: string[];
}

export const TERM_OPTIONS = [
  { label: 'Fall',          premium: 898.00  },
  { label: 'Spring/Summer', premium: 1394.00 },
  { label: 'Summer',        premium: 546.00  },
] as const;

export const STATUS_LABELS: Record<RequestStatus, string> = {
  PENDING_SPORT_ADMIN: 'Pending Sport Admin',
  PENDING_CFO:         'Pending CFO Approval',
  EXECUTED:            'Executed',
  VOIDED:              'Voided',
  EXPIRED:             'Expired',
};

export const STATUS_COLORS: Record<RequestStatus, string> = {
  PENDING_SPORT_ADMIN: '#f59e0b',
  PENDING_CFO:         '#3b82f6',
  EXECUTED:            '#22c55e',
  VOIDED:              '#6b7280',
  EXPIRED:             '#ef4444',
};
