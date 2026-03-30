import type { InsuranceRequest, SportProgram, SportAdministrator, SessionUser } from '../types';

const BASE = import.meta.env.VITE_API_URL ?? '';

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ─── Auth ──────────────────────────────────────────────────────────────────────
export const getMe = ()                          => apiFetch<SessionUser>('/auth/me');
export const logout = ()                         => apiFetch<{ ok: boolean }>('/auth/logout', { method: 'POST' });
export const devLogin = (email: string, displayName: string) =>
  apiFetch<{ ok: boolean; role: string }>('/auth/dev-login', {
    method: 'POST',
    body: JSON.stringify({ email, displayName }),
  });

// ─── Requests ─────────────────────────────────────────────────────────────────
export const listRequests = () =>
  apiFetch<InsuranceRequest[]>('/api/requests');

export const getRequest = (id: string) =>
  apiFetch<InsuranceRequest & { signatures: unknown[] }>(`/api/requests/${id}`);

export const submitRequest = (body: {
  studentName: string;
  rocketNumber: string;
  sport: string;
  term: string;
}) => apiFetch<{ id: string; status: string }>('/api/requests', {
  method: 'POST',
  body: JSON.stringify(body),
});

export const signRequest = (id: string) =>
  apiFetch<{ ok: boolean }>(`/api/requests/${id}/sign`, { method: 'POST' });

export const voidRequest = (id: string, reason: string) =>
  apiFetch<{ ok: boolean }>(`/api/requests/${id}/void`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });

// ─── Sports / Admin ───────────────────────────────────────────────────────────
export const listSports = () =>
  apiFetch<SportProgram[]>('/api/sports');

export const listAdminSports = () =>
  apiFetch<SportProgram[]>('/api/admin/sports');

export const listAdministrators = () =>
  apiFetch<SportAdministrator[]>('/api/admin/administrators');

export const reassignSportAdmin = (sportId: string, sportAdminId: string | null) =>
  apiFetch<{ ok: boolean }>(`/api/admin/sports/${sportId}`, {
    method: 'PUT',
    body: JSON.stringify({ sportAdminId }),
  });

// ─── Reports ──────────────────────────────────────────────────────────────────
export const getSummary = (params?: Record<string, string>) => {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  return apiFetch<{
    requests: InsuranceRequest[];
    totals: { bySport: Record<string, number>; byTerm: Record<string, number>; byCoach: Record<string, number> };
  }>(`/api/reports/summary${qs}`);
};

export const exportCsv = () => {
  window.location.href = `${BASE}/api/reports/export`;
};
