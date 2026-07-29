import type {
  User,
  InsuranceRequest,
  RequestDetail,
  SportProgram,
  SportAdmin,
  Coach,
  BulkSubmitPayload,
  ReportRow,
} from '../types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// Auth
export function getMe() {
  return request<User>('/auth/me');
}

export interface IdentityData {
  coaches: { sportId: string; sportName: string; gender: string; coachName: string }[];
  admins: { id: string; name: string; title: string }[];
  cfo: { id: string; name: string; title: string } | null;
}

export function getIdentities() {
  return request<IdentityData>('/auth/identities');
}

export function selectIdentity(role: string) {
  return request<User>('/auth/select', {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
}

export function login(email: string, password: string) {
  return request<User>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
}

export function register(data: { email: string; password: string; name: string; role: string; sportIds?: string[] }) {
  return request<{ message: string }>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function logout() {
  return request<void>('/auth/logout', { method: 'POST' });
}

export function changePassword(currentPassword: string, newPassword: string) {
  return request<{ ok: boolean }>('/auth/password', {
    method: 'PUT',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export function forgotPassword(email: string) {
  return request<{ message: string }>('/auth/forgot-password', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}

export function resetPassword(token: string, newPassword: string) {
  return request<{ ok: boolean }>('/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ token, newPassword }),
  });
}

// Sports
export function listSports() {
  return request<SportProgram[]>('/api/sports');
}

// Requests
export function listRequests(params?: Record<string, string>) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<InsuranceRequest[]>(`/api/requests${qs}`);
}

export function getRequest(id: string) {
  return request<RequestDetail>(`/api/requests/${id}`);
}

export function submitRequest(payload: BulkSubmitPayload) {
  return request<InsuranceRequest[]>('/api/requests', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function signRequest(id: string, coachName?: string) {
  return request<{ id: string; status: string }>(`/api/requests/${id}/sign`, {
    method: 'POST',
    body: JSON.stringify(coachName ? { coachName } : {}),
  });
}

export function bulkSignRequests(ids: string[], coachName?: string) {
  return request<{ signed: number; results: { id: string; status: string }[] }>('/api/requests/bulk-sign', {
    method: 'POST',
    body: JSON.stringify({ ids, coachName }),
  });
}

export function bulkDenyRequests(ids: string[], reason: string) {
  return request<{ denied: number; results: { id: string; status: string }[] }>('/api/requests/bulk-deny', {
    method: 'POST',
    body: JSON.stringify({ ids, reason }),
  });
}

export function bulkVoidRequests(ids: string[], reason: string) {
  return request<{ voided: number; results: { id: string; status: string }[] }>('/api/requests/bulk-void', {
    method: 'POST',
    body: JSON.stringify({ ids, reason }),
  });
}

export function bulkDeleteRequests(ids: string[]) {
  return request<{ deleted: number }>('/api/requests/bulk-delete', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

export function getRequestPdfUrl(id: string) {
  return `/api/requests/${id}/pdf`;
}

/** Deadline reminder as a calendar file, served here rather than emailed as an attachment. */
export function getRequestCalendarUrl(id: string) {
  return `/api/requests/${id}/calendar`;
}

export interface EmailLogEntry {
  id: string;
  toEmail: string;
  subject: string;
  template: string;
  providerId: string | null;
  status: 'sent' | 'failed' | 'skipped';
  error: string | null;
  createdAt: string;
}

/** Delivery log for one request. CFO and Super Admin only. */
export function listRequestEmails(id: string) {
  return request<EmailLogEntry[]>(`/api/requests/${id}/emails`);
}

export function voidRequest(id: string, reason: string) {
  return request<InsuranceRequest>(`/api/requests/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export function denyRequest(id: string, reason: string) {
  return request<{ id: string; status: string }>(`/api/requests/${id}/deny`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

export interface ResubmitOverrides {
  studentName?: string;
  rocketNumber?: string;
  studentEmail?: string;
  term?: string;
  fundingSource?: string;
  coachName?: string;
  coachEmail?: string;
}

export function resubmitRequest(id: string, overrides?: ResubmitOverrides) {
  return request<{ id: string; status: string; parentRequestId: string }>(`/api/requests/${id}/resubmit`, {
    method: 'POST',
    body: JSON.stringify(overrides ?? {}),
  });
}

export interface BulkImportRow {
  studentName: string;
  rocketNumber: string;
  email?: string;
  sport: string;
  term: string;
  fundingSource?: string;
  coachName?: string;
  coachEmail?: string;
}

export interface BulkImportResult {
  submitted: number;
  skippedCount: number;
  created: { id: string; studentName: string; rocketNumber: string }[];
  skipped: { row: number; studentName: string; reason: string }[];
}

export function bulkImportRequests(rows: BulkImportRow[]) {
  return request<BulkImportResult>('/api/requests/bulk', {
    method: 'POST',
    body: JSON.stringify({ rows }),
  });
}

export function deleteRequest(id: string) {
  return request<void>(`/api/requests/${id}`, { method: 'DELETE' });
}

// Reports
export function getReports(params?: Record<string, string>) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return request<ReportRow[]>(`/api/reports${qs}`);
}

export function getReportsCsvUrl(params?: Record<string, string>) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return `/api/reports/csv${qs}`;
}

// Reports — budget dashboard (2.3)
export interface BudgetSportRow {
  sportId: string;
  sportName: string;
  budgetCap: number | null;
  executedPremium: number;
  committedPremium: number;
  executedCount: number;
  projectedPremium: number;
  remaining: number | null;
  overBudget: boolean;
}

export function getBudgetReport() {
  return request<{ sports: BudgetSportRow[]; elapsedFraction: number }>('/api/reports/budget');
}

export function updateSportBudget(sportId: string, budgetCap: number | null) {
  return request<{ ok: boolean; budgetCap: number | null }>(`/api/admin/sports/${sportId}/budget`, {
    method: 'PUT',
    body: JSON.stringify({ budgetCap }),
  });
}

// Audit log (3.3)
export interface AuditEntry {
  id: string;
  requestId: string | null;
  action: string;
  actor: string;
  details: string | null;
  ipAddress: string | null;
  timestamp: string;
  studentName: string | null;
  rocketNumber: string | null;
  sportName: string | null;
}

export function listAudit(params?: Record<string, string>) {
  const clean = params ? Object.fromEntries(Object.entries(params).filter(([, v]) => v)) : {};
  const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
  return request<AuditEntry[]>(`/api/audit${qs}`);
}

export function getAuditCsvUrl(params?: Record<string, string>) {
  const clean = params ? Object.fromEntries(Object.entries(params).filter(([, v]) => v)) : {};
  const qs = Object.keys(clean).length ? '?' + new URLSearchParams(clean).toString() : '';
  return `/api/audit/csv${qs}`;
}

// Admin — system settings (Super Admin)
export interface AdminSettings {
  fromName: string;
  fromEmail: string;
  appBaseUrl: string;
  replyTo: string;
}

// Auth — first-run setup
export function getAuthStatus() {
  return request<{ setupRequired: boolean }>('/auth/status');
}

export function completeSetup(data: {
  email: string; password: string; name: string; role: string; sportId?: string;
}) {
  return request<User>('/auth/setup', { method: 'POST', body: JSON.stringify(data) });
}

export function getAdminSettings() {
  return request<AdminSettings>('/api/admin/settings');
}

export function updateAdminSettings(data: AdminSettings) {
  return request<{ ok: boolean } & AdminSettings>('/api/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// Admin — users
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  sportId?: string;
  sportIds?: string[]; // sport-admin assignments (4.6)
  mustChangePassword: number;
  status?: string;
  createdAt: string;
}

export function listUsers() {
  return request<AdminUser[]>('/api/admin/users');
}

export function createUser(data: {
  email: string;
  password: string;
  name: string;
  role: string;
  sportId?: string;
  sportIds?: string[];
}) {
  return request<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateUserSports(userId: string, sportIds: string[]) {
  return request<{ ok: boolean; sportIds: string[] }>(`/api/admin/users/${userId}/sports`, {
    method: 'PUT',
    body: JSON.stringify({ sportIds }),
  });
}

export function deleteUser(id: string) {
  return request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

export function approveUser(id: string) {
  return request<{ ok: boolean }>(`/api/admin/users/${id}/approve`, { method: 'PUT' });
}

export function rejectUser(id: string) {
  return request<{ ok: boolean }>(`/api/admin/users/${id}/reject`, { method: 'PUT' });
}

// Admin — sports & coaches
export interface SportInput {
  name: string;
  gender: string;
  headCoach?: string;
  headCoachEmail?: string;
  sportAdminId?: string | null;
}

export function listSportAdmins() {
  return request<SportAdmin[]>('/api/admin/sport-admins');
}

export function createSport(data: SportInput) {
  return request<SportProgram>('/api/admin/sports', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateSport(id: string, data: Partial<SportInput>) {
  return request<{ ok: boolean }>(`/api/admin/sports/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteSport(id: string) {
  return request<{ ok: boolean }>(`/api/admin/sports/${id}`, { method: 'DELETE' });
}

export function updateSportAdmin(sportId: string, adminId: string | null) {
  return request<{ ok: boolean }>(`/api/admin/sports/${sportId}`, {
    method: 'PUT',
    body: JSON.stringify({ adminId }),
  });
}

// Coaches (multi-staff per sport, 4.3)
export function listSportCoaches(sportId: string) {
  return request<Coach[]>(`/api/sports/${sportId}/coaches`);
}

export interface CoachInput {
  displayName: string;
  email: string;
  title?: string;
  isHeadCoach?: boolean;
  delegatedApproverEmail?: string | null;
  delegationExpiresAt?: string | null;
}

export function createCoach(sportId: string, data: CoachInput) {
  return request<Coach>(`/api/admin/sports/${sportId}/coaches`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateCoach(coachId: string, data: Partial<CoachInput>) {
  return request<{ ok: boolean }>(`/api/admin/coaches/${coachId}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteCoach(coachId: string) {
  return request<{ ok: boolean }>(`/api/admin/coaches/${coachId}`, { method: 'DELETE' });
}
