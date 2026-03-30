export type UserRole = 'coach' | 'sport_admin' | 'cfo';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  sportId?: string; // for coaches: their assigned sport
  mustChangePassword?: number;
}

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
  sportName?: string;
  term: string;
  premiumCost: number;
  status: RequestStatus;
  coachEmail: string;
  coachName: string;
  createdAt: string;
}

export interface Signature {
  id: string;
  requestId: string;
  signatoryRole: 'COACH' | 'SPORT_ADMIN' | 'CFO';
  signatoryEmail: string;
  signatoryName: string;
  timestamp: string;
}

export interface RequestDetail extends InsuranceRequest {
  signatures: Signature[];
  sportAdminName?: string;
  sportAdminEmail?: string;
  envelopeId?: string;
}

export interface SportProgram {
  id: string;
  name: string;
  gender: string;
  headCoach?: string;
  sportAdminId?: string;
  sportAdminName?: string;
  sportAdminEmail?: string;
}

export interface TermOption {
  label: string;
  value: string;
  premium: number;
  deadline: string;
}

export const TERM_OPTIONS: TermOption[] = [
  { label: 'Fall', value: 'Fall', premium: 898.0, deadline: 'September 8' },
  { label: 'Spring/Summer', value: 'Spring/Summer', premium: 1394.0, deadline: 'January 26' },
  { label: 'Summer', value: 'Summer', premium: 546.0, deadline: 'July 1' },
];

export interface AthleteEntry {
  studentName: string;
  rocketNumber: string;
  sport: string;
  rocketError?: string;
}

export interface BulkSubmitPayload {
  athletes: { studentName: string; rocketNumber: string; sport: string }[];
  term: string;
}

export interface ReportRow {
  sport: string;
  sportName: string;
  term: string;
  coachName: string;
  coachEmail: string;
  studentName: string;
  rocketNumber: string;
  premiumCost: number;
  status: RequestStatus;
  createdAt: string;
}
