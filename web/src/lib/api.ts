import type {
  User,
  InsuranceRequest,
  RequestDetail,
  SportProgram,
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

export function selectIdentity(role: string, sportId?: string, adminId?: string) {
  return request<User>('/auth/select', {
    method: 'POST',
    body: JSON.stringify({ role, sportId, adminId }),
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

export function signRequest(id: string) {
  return request<{ id: string; status: string }>(`/api/requests/${id}/sign`, { method: 'POST' });
}

export function getRequestPdfUrl(id: string) {
  return `/api/requests/${id}/pdf`;
}

export function voidRequest(id: string, reason: string) {
  return request<InsuranceRequest>(`/api/requests/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
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

// Admin — users
export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: string;
  sportId?: string;
  mustChangePassword: number;
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
}) {
  return request<AdminUser>('/api/admin/users', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteUser(id: string) {
  return request<void>(`/api/admin/users/${id}`, { method: 'DELETE' });
}

// Admin — sports
export function updateSportAdmin(sportId: string, adminId: string | null) {
  return request<SportProgram>(`/api/admin/sports/${sportId}`, {
    method: 'PUT',
    body: JSON.stringify({ adminId }),
  });
}
