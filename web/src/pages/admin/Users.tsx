import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../lib/auth';
import {
  listUsers, createUser, deleteUser, approveUser, rejectUser, listSports, updateUserSports,
  updateUser, resetUserPassword, setUserStatus,
} from '../../lib/api';
import type { AdminUser } from '../../lib/api';
import type { SportProgram } from '../../types';

export function AdminUsers() {
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const [newEmail, setNewEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState('coach');
  const [newSportId, setNewSportId] = useState('');
  const [newSportIds, setNewSportIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Per-user sport-assignment editing (4.6)
  const [editingSportsFor, setEditingSportsFor] = useState<string | null>(null);
  const [editSportIds, setEditSportIds] = useState<Set<string>>(new Set());
  const [savingSports, setSavingSports] = useState(false);

  // Identity editing. Name, email, and role used to be write-once, so a coach who changed
  // address or an administrator who was promoted had to be deleted and recreated — losing
  // their sport assignments in the process.
  const [editingUser, setEditingUser] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', email: '', role: '', sportId: '' });
  const [savingUser, setSavingUser] = useState(false);
  // Shown once, on screen, because the message carrying it may be quarantined.
  const [tempPassword, setTempPassword] = useState<{ name: string; password: string } | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const sportName = (id: string) => sports.find(s => s.id === id)?.name ?? id;
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  };

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([listUsers(), listSports()])
      .then(([u, s]) => { setUsers(u); setSports(s); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (user?.role !== 'cfo' && user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. CFO or Super Admin only.</p></div>;
  }

  const pendingUsers = users.filter(u => u.status === 'pending');
  const activeUsers = users.filter(u => u.status !== 'pending');

  const handleApprove = async (id: string, name: string) => {
    if (!confirm(`Approve account for "${name}"?`)) return;
    try {
      await approveUser(id);
      setUsers(prev => prev.map(u => u.id === id ? { ...u, status: 'active' } : u));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Approve failed');
    }
  };

  const handleReject = async (id: string, name: string) => {
    if (!confirm(`Reject account request for "${name}"? This cannot be undone.`)) return;
    try {
      await rejectUser(id);
      setUsers(prev => prev.map(u => u.id === id ? { ...u, status: 'rejected' } : u));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Reject failed');
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newRole === 'sport_admin' && newSportIds.size === 0) {
      setCreateError('Select at least one sport for this Sport Admin'); return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const created = await createUser({
        email: newEmail.trim(),
        password: newPassword,
        name: newName.trim(),
        role: newRole,
        sportId: newRole === 'coach' ? newSportId : undefined,
        sportIds: newRole === 'sport_admin' ? [...newSportIds] : undefined,
      });
      setUsers(prev => [...prev, created]);
      setShowForm(false);
      setNewEmail(''); setNewPassword(''); setNewName(''); setNewRole('coach'); setNewSportId(''); setNewSportIds(new Set());
    } catch (err: unknown) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const startEditUser = (u: AdminUser) => {
    setEditingUser(u.id);
    setDraft({ name: u.name, email: u.email, role: u.role, sportId: u.sportId ?? '' });
    setError('');
  };

  const handleSaveUser = async (id: string) => {
    setSavingUser(true);
    setError('');
    try {
      await updateUser(id, {
        name: draft.name.trim(), email: draft.email.trim(), role: draft.role,
        sportId: draft.role === 'coach' ? draft.sportId || null : undefined,
      });
      setEditingUser(null);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update account');
    } finally {
      setSavingUser(false);
    }
  };

  const handleResetPassword = async (u: AdminUser) => {
    if (!confirm(`Reset the password for ${u.name}? Any session they have open will end.`)) return;
    setBusyUser(u.id);
    setError('');
    try {
      const res = await resetUserPassword(u.id, 'temp');
      if (res.temporaryPassword) setTempPassword({ name: u.name, password: res.temporaryPassword });
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to reset password');
    } finally {
      setBusyUser(null);
    }
  };

  const handleToggleStatus = async (u: AdminUser) => {
    const next = (u.status ?? 'active') === 'active' ? 'inactive' : 'active';
    const warning = next === 'inactive'
      ? `Deactivate ${u.name}? They lose access immediately and stop receiving notifications. `
        + 'History is kept — prefer this to deleting.'
      : `Reactivate ${u.name}?`;
    if (!confirm(warning)) return;
    setBusyUser(u.id);
    setError('');
    try {
      await setUserStatus(u.id, next);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to change status');
    } finally {
      setBusyUser(null);
    }
  };

  const startEditSports = (u: AdminUser) => {
    setEditingSportsFor(u.id);
    setEditSportIds(new Set(u.sportIds ?? []));
    setError('');
  };

  const handleSaveSports = async (id: string) => {
    if (editSportIds.size === 0) { setError('Select at least one sport'); return; }
    setSavingSports(true);
    setError('');
    try {
      await updateUserSports(id, [...editSportIds]);
      setUsers(prev => prev.map(u => u.id === id ? { ...u, sportIds: [...editSportIds] } : u));
      setEditingSportsFor(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update sports');
    } finally {
      setSavingSports(false);
    }
  };

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete user "${name}"? This cannot be undone.`)) return;
    try {
      await deleteUser(id);
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>User Management</h1>
        <button className="btn btn-primary" onClick={() => setShowForm(s => !s)}>
          {showForm ? 'Cancel' : '+ Add User'}
        </button>
      </div>

      {showForm && (
        <form className="form-card" onSubmit={handleCreate}>
          <h2>New User</h2>
          <div className="field">
            <label>Full Name *</label>
            <input type="text" value={newName} onChange={e => setNewName(e.target.value)} required />
          </div>
          <div className="field">
            <label>Email *</label>
            <input type="email" value={newEmail} onChange={e => setNewEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label>Temporary Password *</label>
            <input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              required
              minLength={8}
            />
          </div>
          <div className="field">
            <label>Role *</label>
            <select value={newRole} onChange={e => setNewRole(e.target.value)}>
              <option value="coach">Coach</option>
              <option value="sport_admin">Sport Administrator</option>
              <option value="cfo">CFO</option>
              <option value="super_admin">Super Admin</option>
            </select>
          </div>
          {newRole === 'coach' && (
            <div className="field">
              <label>Sport *</label>
              <select value={newSportId} onChange={e => setNewSportId(e.target.value)} required>
                <option value="">— Select Sport —</option>
                {sports.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="field-hint">
                The coach joins this sport's roster automatically and appears on the
                request form's coach picker.
              </p>
            </div>
          )}
          {newRole === 'sport_admin' && (
            <div className="field">
              <label>Sports Administered * (select all that apply)</label>
              <div className="checkbox-grid">
                {sports.map(s => (
                  <label key={s.id} className={`checkbox-chip ${newSportIds.has(s.id) ? 'checkbox-chip--checked' : ''}`}>
                    <input type="checkbox" checked={newSportIds.has(s.id)} onChange={() => setNewSportIds(prev => toggle(prev, s.id))} />
                    <span>{s.name}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
          {createError && <p className="error">{createError}</p>}
          <button type="submit" className="btn btn-primary"
            disabled={creating || (newRole === 'coach' && !newSportId)}>
            {creating ? 'Creating…' : 'Create User'}
          </button>
        </form>
      )}

      {error && <p className="error">{error}</p>}

      {/* Pending Approvals Section */}
      {pendingUsers.length > 0 && (
        <div className="form-card" style={{ borderLeft: '4px solid #F5A800', marginBottom: '24px' }}>
          <h2>Pending Approvals ({pendingUsers.length})</h2>
          <p style={{ color: '#666', fontSize: '0.875rem', marginBottom: '12px' }}>
            These accounts were self-registered and are awaiting approval.
          </p>
          <div className="table-wrapper">
            <table className="data-table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Requested</th><th>Actions</th></tr>
              </thead>
              <tbody>
                {pendingUsers.map(u => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{u.email}</td>
                    <td><span className="badge">{u.role.replace(/_/g, ' ')}</span></td>
                    <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                    <td style={{ display: 'flex', gap: '8px' }}>
                      <button
                        className="btn btn-primary"
                        style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                        onClick={() => handleApprove(u.id, u.name)}
                      >
                        Approve
                      </button>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                        onClick={() => handleReject(u.id, u.name)}
                      >
                        Reject
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tempPassword && (
        <div className="form-card" style={{ borderLeft: '4px solid var(--gold, #FFC72C)' }}>
          <h2 style={{ marginTop: 0, fontSize: '1rem' }}>Temporary password for {tempPassword.name}</h2>
          <p className="field-hint" style={{ marginTop: 0 }}>
            Shown once. It has also been emailed, but university filtering may quarantine that
            message — which is the situation this exists for. They will be asked to choose their
            own password the first time they sign in.
          </p>
          <code style={{ fontSize: '1.05rem', padding: '.4rem .7rem', border: '1px solid var(--gray-200)', display: 'inline-block' }}>
            {tempPassword.password}
          </code>
          <div style={{ display: 'flex', gap: '.5rem', marginTop: '.75rem' }}>
            <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '.8rem' }}
              onClick={() => navigator.clipboard?.writeText(tempPassword.password)}>Copy</button>
            <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '.8rem' }}
              onClick={() => setTempPassword(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {loading ? <p className="muted">Loading…</p> : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Sports</th><th>Created</th><th></th></tr>
            </thead>
            <tbody>
              {activeUsers.map(u => (
                <tr key={u.id}>
                  <td>
                    {editingUser === u.id ? (
                      <input value={draft.name} onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}
                        style={{ width: '100%', minWidth: '120px' }} maxLength={150} />
                    ) : u.name}
                  </td>
                  <td>
                    {editingUser === u.id ? (
                      <input type="email" value={draft.email}
                        onChange={e => setDraft(d => ({ ...d, email: e.target.value }))}
                        style={{ width: '100%', minWidth: '160px' }} maxLength={200} />
                    ) : u.email}
                  </td>
                  <td>
                    {editingUser === u.id ? (
                      <div style={{ display: 'grid', gap: '4px' }}>
                        <select value={draft.role} onChange={e => setDraft(d => ({ ...d, role: e.target.value }))}>
                          <option value="coach">Coach</option>
                          <option value="sport_admin">Sport Admin</option>
                          <option value="cfo">CFO</option>
                          <option value="super_admin">Super Admin</option>
                        </select>
                        {draft.role === 'coach' && (
                          <select value={draft.sportId} onChange={e => setDraft(d => ({ ...d, sportId: e.target.value }))}>
                            <option value="">— Select Sport —</option>
                            {sports.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        )}
                      </div>
                    ) : <span className="badge">{u.role.replace(/_/g, ' ')}</span>}
                  </td>
                  <td>
                    <span className={`badge ${u.status === 'rejected' || u.status === 'inactive' ? 'badge--danger' : ''}`}>
                      {u.status ?? 'active'}
                    </span>
                  </td>
                  <td>
                    {u.role === 'sport_admin' ? (
                      editingSportsFor === u.id ? (
                        <div>
                          <div className="checkbox-grid" style={{ marginBottom: '.5rem' }}>
                            {sports.map(s => (
                              <label key={s.id} className={`checkbox-chip ${editSportIds.has(s.id) ? 'checkbox-chip--checked' : ''}`}>
                                <input type="checkbox" checked={editSportIds.has(s.id)} onChange={() => setEditSportIds(prev => toggle(prev, s.id))} />
                                <span>{s.name}</span>
                              </label>
                            ))}
                          </div>
                          <div style={{ display: 'flex', gap: '8px' }}>
                            <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: '.8rem' }}
                              onClick={() => handleSaveSports(u.id)} disabled={savingSports}>
                              {savingSports ? 'Saving…' : 'Save'}
                            </button>
                            <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '.8rem' }}
                              onClick={() => setEditingSportsFor(null)}>Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <span>
                          {u.sportIds && u.sportIds.length > 0
                            ? u.sportIds.map(sportName).join(', ')
                            : <span className="muted">None</span>}
                          {' '}
                          <button className="link" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--blue)' }}
                            onClick={() => startEditSports(u)}>Edit</button>
                        </span>
                      )
                    ) : (
                      sports.find(s => s.id === u.sportId)?.name ?? '—'
                    )}
                  </td>
                  <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                      {editingUser === u.id ? (
                        <>
                          <button className="btn btn-primary" style={{ padding: '4px 10px', fontSize: '.78rem' }}
                            onClick={() => handleSaveUser(u.id)}
                            disabled={savingUser || (draft.role === 'coach' && !draft.sportId)}>
                            {savingUser ? 'Saving...' : 'Save'}
                          </button>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '.78rem' }}
                            onClick={() => setEditingUser(null)}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '.78rem' }}
                            onClick={() => startEditUser(u)}>Edit</button>
                          <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '.78rem' }}
                            onClick={() => handleResetPassword(u)} disabled={busyUser === u.id}>
                            Reset password
                          </button>
                          {u.email !== user?.email && (
                            <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '.78rem' }}
                              onClick={() => handleToggleStatus(u)} disabled={busyUser === u.id}>
                              {(u.status ?? 'active') === 'active' ? 'Deactivate' : 'Reactivate'}
                            </button>
                          )}
                          {u.email !== user?.email && (
                            <button className="btn-remove" onClick={() => handleDelete(u.id, u.name)}>
                              Delete
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
