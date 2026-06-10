import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../../lib/auth';
import {
  listSports, listSportAdmins, createSport, updateSport, deleteSport,
} from '../../lib/api';
import type { SportProgram, SportAdmin } from '../../types';

interface DraftFields {
  name: string;
  gender: string;
  headCoach: string;
  headCoachEmail: string;
  sportAdminId: string;
}

const EMPTY_DRAFT: DraftFields = {
  name: '', gender: 'Mens', headCoach: '', headCoachEmail: '', sportAdminId: '',
};

export function AdminSports() {
  const { user } = useAuth();
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [admins, setAdmins] = useState<SportAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Row being edited (sport id) and its working values
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  // New-sport form
  const [showAdd, setShowAdd] = useState(false);
  const [newSport, setNewSport] = useState<DraftFields>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([listSports(), listSportAdmins()])
      .then(([s, a]) => { setSports(s); setAdmins(a); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  if (user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. Super Admin only.</p></div>;
  }

  const adminName = (id?: string) => admins.find(a => a.id === id)?.name ?? '—';

  const startEdit = (s: SportProgram) => {
    setEditingId(s.id);
    setError('');
    setDraft({
      name: s.name,
      gender: s.gender,
      headCoach: s.headCoach ?? '',
      headCoachEmail: s.headCoachEmail ?? '',
      sportAdminId: s.sportAdminId ?? '',
    });
  };

  const saveEdit = async (id: string) => {
    setSaving(true);
    setError('');
    try {
      await updateSport(id, {
        name: draft.name.trim(),
        gender: draft.gender.trim(),
        headCoach: draft.headCoach.trim(),
        headCoachEmail: draft.headCoachEmail.trim(),
        sportAdminId: draft.sportAdminId || null,
      });
      setEditingId(null);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      await createSport({
        name: newSport.name.trim(),
        gender: newSport.gender.trim(),
        headCoach: newSport.headCoach.trim() || undefined,
        headCoachEmail: newSport.headCoachEmail.trim() || undefined,
        sportAdminId: newSport.sportAdminId || null,
      });
      setShowAdd(false);
      setNewSport(EMPTY_DRAFT);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (s: SportProgram) => {
    if (!confirm(`Delete "${s.name}"? This only works if it has no insurance requests.`)) return;
    setError('');
    try {
      await deleteSport(s.id);
      setSports(prev => prev.filter(x => x.id !== s.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const adminOptions = (
    <>
      <option value="">— None —</option>
      {admins.map(a => (
        <option key={a.id} value={a.id}>{a.name}{a.isCfo ? ' (CFO)' : ''}</option>
      ))}
    </>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Sports &amp; Coaches</h1>
        <button className="btn btn-primary" onClick={() => setShowAdd(s => !s)}>
          {showAdd ? 'Cancel' : '+ Add Sport'}
        </button>
      </div>
      <p className="page-subtitle">
        Maintain each program's head coach and contact email. When a coach starts a request and
        picks their sport, this information is filled in automatically.
      </p>

      {error && <p className="error">{error}</p>}

      {showAdd && (
        <form className="form-card" onSubmit={handleCreate}>
          <h2>New Sport / Program</h2>
          <div className="athlete-row-fields">
            <div className="field">
              <label>Sport Name *</label>
              <input type="text" value={newSport.name}
                onChange={e => setNewSport({ ...newSport, name: e.target.value })} required maxLength={100} />
            </div>
            <div className="field">
              <label>Gender *</label>
              <select value={newSport.gender}
                onChange={e => setNewSport({ ...newSport, gender: e.target.value })}>
                <option value="Mens">Mens</option>
                <option value="Womens">Womens</option>
                <option value="Coed">Coed</option>
              </select>
            </div>
          </div>
          <div className="athlete-row-fields">
            <div className="field">
              <label>Head Coach Name</label>
              <input type="text" value={newSport.headCoach}
                onChange={e => setNewSport({ ...newSport, headCoach: e.target.value })} maxLength={150} />
            </div>
            <div className="field">
              <label>Head Coach Email</label>
              <input type="email" value={newSport.headCoachEmail}
                onChange={e => setNewSport({ ...newSport, headCoachEmail: e.target.value })}
                placeholder="coach@utoledo.edu" maxLength={200} />
            </div>
            <div className="field">
              <label>Sport Administrator</label>
              <select value={newSport.sportAdminId}
                onChange={e => setNewSport({ ...newSport, sportAdminId: e.target.value })}>
                {adminOptions}
              </select>
            </div>
          </div>
          <button type="submit" className="btn btn-primary" disabled={creating}>
            {creating ? 'Adding…' : 'Add Sport'}
          </button>
        </form>
      )}

      {loading ? <p className="muted">Loading…</p> : (
        <div className="table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Sport</th><th>Gender</th><th>Head Coach</th>
                <th>Coach Email</th><th>Sport Admin</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sports.map(s => editingId === s.id ? (
                <tr key={s.id}>
                  <td><input type="text" value={draft.name}
                    onChange={e => setDraft({ ...draft, name: e.target.value })} /></td>
                  <td>
                    <select value={draft.gender}
                      onChange={e => setDraft({ ...draft, gender: e.target.value })}>
                      <option value="Mens">Mens</option>
                      <option value="Womens">Womens</option>
                      <option value="Coed">Coed</option>
                    </select>
                  </td>
                  <td><input type="text" value={draft.headCoach}
                    onChange={e => setDraft({ ...draft, headCoach: e.target.value })} /></td>
                  <td><input type="email" value={draft.headCoachEmail}
                    onChange={e => setDraft({ ...draft, headCoachEmail: e.target.value })}
                    placeholder="coach@utoledo.edu" /></td>
                  <td>
                    <select value={draft.sportAdminId}
                      onChange={e => setDraft({ ...draft, sportAdminId: e.target.value })}>
                      {adminOptions}
                    </select>
                  </td>
                  <td style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                      onClick={() => saveEdit(s.id)} disabled={saving}>
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                      onClick={() => setEditingId(null)}>Cancel</button>
                  </td>
                </tr>
              ) : (
                <tr key={s.id}>
                  <td>{s.name}</td>
                  <td>{s.gender}</td>
                  <td>{s.headCoach || <span className="muted">—</span>}</td>
                  <td>{s.headCoachEmail || <span className="muted">—</span>}</td>
                  <td>{adminName(s.sportAdminId)}</td>
                  <td style={{ display: 'flex', gap: '8px' }}>
                    <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                      onClick={() => startEdit(s)}>Edit</button>
                    <button className="btn-remove" onClick={() => handleDelete(s)}>Delete</button>
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
