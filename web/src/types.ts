export type UserRole = 'coach' | 'sport_admin' | 'cfo' | 'super_admin';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  sportId?: string; // for coaches: their assigned sport
  mustChangePassword?: number;
  status?: string; // 'active' | 'pending' | 'rejected'
}

export type RequestStatus =
  | 'PENDING_COACH'
  | 'PENDING_APPROVAL'
  | 'EXECUTED'
  | 'VOIDED'
  | 'EXPIRED';

export type FundingSource = 'operating_budget' | 'foundation_account';

export const FUNDING_SOURCE_LABELS: Record<FundingSource, string> = {
  operating_budget: 'Operating Budget',
  foundation_account: 'Foundation Account',
};

export function fundingSourceLabel(source?: string): string {
  return FUNDING_SOURCE_LABELS[(source as FundingSource)] ?? 'Operating Budget';
}

export interface InsuranceRequest {
  id: string;
  studentName: string;
  rocketNumber: string;
  studentEmail?: string;
  sport: string;
  sportName?: string;
  term: string;
  premiumCost: number;
  fundingSource: FundingSource;
  status: RequestStatus;
  coachEmail?: string;
  coachName: string;
  createdAt: string;
  // Derived approval flags (parallel approval model)
  sportAdminSigned?: boolean;
  cfoSigned?: boolean;
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
  firstName: string;
  lastName: string;
  rocketNumber: string;
  email: string;
  rocketError?: string;
  emailError?: string;
}

export interface BulkSubmitPayload {
  athletes: { studentName: string; rocketNumber: string; email?: string }[];
  term: string;
  sport: string;
  fundingSource: FundingSource;
  coachEmail?: string;
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
  fundingSource: FundingSource;
  status: RequestStatus;
  createdAt: string;
}
