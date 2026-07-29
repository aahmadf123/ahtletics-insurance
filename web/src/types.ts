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
  | 'DENIED'
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
  denialReason?: string;
  parentRequestId?: string;
  // Derived approval flags (parallel approval model)
  sportAdminSigned?: boolean;
  cfoSigned?: boolean;
  headCoachSigned?: boolean;
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
  headCoachEmail?: string;
  sportAdminId?: string;
  sportAdminName?: string;
  sportAdminEmail?: string;
  budgetCap?: number | null;
  staffCount?: number; // number of non-head staff coaches
}

export interface Coach {
  id: string;
  displayName: string;
  email: string;
  sportId: string;
  title?: string;
  isHeadCoach: number; // 0 | 1
  delegatedApproverEmail?: string | null;
  delegationExpiresAt?: string | null;
}

export interface SportAdmin {
  id: string;
  name: string;
  title: string;
  email: string;
  isCfo: number;
}

// Term premiums and deadlines come from shared/terms.ts, which the Worker uses too.
// They were previously duplicated here and would drift the first time a rate changed.
export { currentTermOptions, TERMS, getPremiumForTerm, type TermOption, type TermKey } from '../../shared/terms';

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
  coachName?: string;
  parentRequestId?: string;
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
