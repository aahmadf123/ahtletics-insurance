import { useEffect, useState, useCallback, Fragment } from 'react';
import { useAuth } from '../../lib/auth';
import {
  listSports, listSportAdmins, createSport, updateSport, deleteSport,
  listSportCoaches, createCoach, updateCoach, deleteCoach,
} from '../../lib/api';
import type { SportProgram, SportAdmin, Coach } from '../../types';

interface DraftFields {
  name: string;
  gender: string;
  sportAdminId: string;
}

const EMPTY_DRAFT: DraftFields = { name: '', gender: 'Mens', sportAdminId: '' };

const TITLES = ['Head Coach', 'Assistant Coach', 'Volunteer Coach', 'Other'];

interface CoachForm {
  id?: string;
  sportId: string;
  displayName: string;
  email: string;
  title: string;
  isHeadCoach: boolean;
  delegatedApproverEmail: string;
  delegationExpiresAt: string;
}

export function AdminSports() {
  const { user } = useAuth();
  const [sports, setSports] = useState<SportProgram[]>([]);
  const [admins, setAdmins] = useState<SportAdmin[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftFields>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const [showAdd, setShowAdd] = useState(false);
  const [newSport, setNewSport] = useState<DraftFields>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);

  // Coaches per sport (expand/collapse)
  const [expanded, setExpanded] = useState<string | null>(null);
  const [coachesBySport, setCoachesBySport] = useState<Record<string, Coach[]>>({});
  const [coachForm, setCoachForm] = useState<CoachForm | null>(null);
  const [savingCoach, setSavingCoach] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    Promise.all([listSports(), listSportAdmins()])
      .then(([s, a]) => { setSports(s); setAdmins(a); })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const loadCoaches = useCallback((sportId: string) => {
    listSportCoaches(sportId)
      .then(list => setCoachesBySport(prev => ({ ...prev, [sportId]: list })))
      .catch(err => setError(err.message));
  }, []);

  if (user?.role !== 'super_admin') {
    return <div className="page"><p className="error">Access denied. Super Admin only.</p></div>;
  }

  const adminName = (id?: string) => admins.find(a => a.id === id)?.name ?? '—';

  const toggleExpand = (sportId: string) => {
    if (expanded === sportId) { setExpanded(null); return; }
    setExpanded(sportId);
    if (!coachesBySport[sportId]) loadCoaches(sportId);
  };

  const startEdit = (s: SportProgram) => {
    setEditingId(s.id);
    setError('');
    setDraft({ name: s.name, gender: s.gender, sportAdminId: s.sportAdminId ?? '' });
  };

  const saveEdit = async (id: string) => {
    setSaving(true);
    setError('');
    try {
      await updateSport(id, {
        name: draft.name.trim(),
        gender: draft.gender.trim(),
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

  const handleDeleteSport = async (s: SportProgram) => {
    if (!confirm(`Delete "${s.name}"? This removes its coaches too and only works if it has no insurance requests.`)) return;
    setError('');
    try {
      await deleteSport(s.id);
      setSports(prev => prev.filter(x => x.id !== s.id));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // ── Coach modal ───────────────────────────────────────────────────────────
  const openAddCoach = (sportId: string) => {
    setError('');
    setCoachForm({
      sportId, displayName: '', email: '', title: 'Assistant Coach',
      isHeadCoach: false, delegatedApproverEmail: '', delegationExpiresAt: '',
    });
  };

  const openEditCoach = (co: Coach) => {
    setError('');
    setCoachForm({
      id: co.id,
      sportId: co.sportId,
      displayName: co.displayName,
      email: co.email,
      title: co.title || (co.isHeadCoach ? 'Head Coach' : 'Assistant Coach'),
      isHeadCoach: !!co.isHeadCoach,
      delegatedApproverEmail: co.delegatedApproverEmail ?? '',
      delegationExpiresAt: co.delegationExpiresAt ? co.delegationExpiresAt.slice(0, 10) : '',
    });
  };

  const saveCoach = async () => {
    if (!coachForm) return;
    if (!coachForm.displayName.trim()) { setError('Coach name is required'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(coachForm.email.trim())) { setError('A valid email is required'); return; }
    setSavingCoach(true);
    setError('');
    try {
      const payload = {
        displayName: coachForm.displayName.trim(),
        email: coachForm.email.trim(),
        title: coachForm.title,
        isHeadCoach: coachForm.isHeadCoach,
        delegatedApproverEmail: coachForm.delegatedApproverEmail.trim() || null,
        delegationExpiresAt: coachForm.delegationExpiresAt || null,
      };
      if (coachForm.id) await updateCoach(coachForm.id, payload);
      else await createCoach(coachForm.sportId, payload);
      loadCoaches(coachForm.sportId);
      refresh(); // head coach name/email + staff count may have changed
      setCoachForm(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save coach');
    } finally {
      setSavingCoach(false);
    }
  };

  const removeCoach = async (co: Coach) => {
    if (!confirm(`Remove ${co.displayName} from this sport?`)) return;
    setError('');
    try {
      await deleteCoach(co.id);
      loadCoaches(co.sportId);
      refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove coach');
    }
  };

  const adminOptions = (
    <>
      <option value="">— None —</option>
      {admins.map(a => <option key={a.id} value={a.id}>{a.name}{a.isCfo ? ' (CFO)' : ''}</option>)}
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
        Each sport has one Head Coach plus any number of staff coaches. Expand a sport to manage its
        roster. The Head Coach receives the first approval email; their name auto-fills on the request form.
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
              <select value={newSport.gender} onChange={e => setNewSport({ ...newSport, gender: e.target.value })}>
                <option value="Mens">Mens</option>
                <option value="Womens">Womens</option>
                <option value="Coed">Coed</option>
              </select>
            </div>
            <div className="field">
              <label>Sport Administrator</label>
              <select value={newSport.sportAdminId} onChange={e => setNewSport({ ...newSport, sportAdminId: e.target.value })}>
                {adminOptions}
              </select>
            </div>
          </div>
          <p className="field-hint" style={{ marginBottom: '.75rem' }}>Add the head coach and staff after creating the sport.</p>
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
                <th style={{ width: '32px' }}></th>
                <th>Sport</th><th>Gender</th><th>Head Coach</th>
                <th>Staff</th><th>Sport Admin</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sports.map(s => {
                const isEditing = editingId === s.id;
                const isExpanded = expanded === s.id;
                const coaches = coachesBySport[s.id] ?? [];
                const headCoach = coaches.find(c => c.isHeadCoach);
                const staff = coaches.filter(c => !c.isHeadCoach);
                return (
                  <Fragment key={s.id}>
                    {isEditing ? (
                      <tr key={s.id}>
                        <td></td>
                        <td><input type="text" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></td>
                        <td>
                          <select value={draft.gender} onChange={e => setDraft({ ...draft, gender: e.target.value })}>
                            <option value="Mens">Mens</option>
                            <option value="Womens">Womens</option>
                            <option value="Coed">Coed</option>
                          </select>
                        </td>
                        <td colSpan={2}><span className="muted">Manage via the roster ↴</span></td>
                        <td>
                          <select value={draft.sportAdminId} onChange={e => setDraft({ ...draft, sportAdminId: e.target.value })}>
                            {adminOptions}
                          </select>
                        </td>
                        <td style={{ display: 'flex', gap: '8px' }}>
                          <button className="btn btn-primary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                            onClick={() => saveEdit(s.id)} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
                          <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                            onClick={() => setEditingId(null)}>Cancel</button>
                        </td>
                      </tr>
                    ) : (
                      <tr key={s.id}>
                        <td>
                          <button className="expand-toggle" onClick={() => toggleExpand(s.id)} aria-label="Toggle coaches" aria-expanded={isExpanded}>
                            {isExpanded ? '▾' : '▸'}
                          </button>
                        </td>
                        <td style={{ fontWeight: 500 }}>{s.name}</td>
                        <td>{s.gender}</td>
                        <td>
                          {s.headCoach
                            ? <span>{s.headCoach}{s.headCoachEmail ? <><br /><span className="muted" style={{ fontSize: '.8rem' }}>{s.headCoachEmail}</span></> : null}</span>
                            : <span className="muted">— none —</span>}
                        </td>
                        <td>{s.staffCount ? `${s.staffCount} staff` : <span className="muted">0</span>}</td>
                        <td>{adminName(s.sportAdminId)}</td>
                        <td style={{ display: 'flex', gap: '8px' }}>
                          <button className="btn btn-secondary" style={{ padding: '4px 12px', fontSize: '0.8rem' }}
                            onClick={() => startEdit(s)}>Edit</button>
                          <button className="btn-remove" onClick={() => handleDeleteSport(s)}>Delete</button>
                        </td>
                      </tr>
                    )}

                    {isExpanded && !isEditing && (
                      <tr key={`${s.id}-coaches`} className="coach-detail-row">
                        <td></td>
                        <td colSpan={6}>
                          <div className="coach-panel">
                            {!coachesBySport[s.id] ? (
                              <p className="muted">Loading coaches…</p>
                            ) : coaches.length === 0 ? (
                              <p className="muted">No coaches yet. Add the head coach to enable approval routing.</p>
                            ) : (
                              <table className="coach-list">
                                <tbody>
                                  {headCoach && (
                                    <CoachRow co={headCoach} onEdit={openEditCoach} onRemove={removeCoach} />
                                  )}
                                  {staff.map(co => (
                                    <CoachRow key={co.id} co={co} onEdit={openEditCoach} onRemove={removeCoach} />
                                  ))}
                                </tbody>
                              </table>
                            )}
                            <button className="btn btn-secondary" style={{ marginTop: '.75rem' }}
                              onClick={() => openAddCoach(s.id)}>+ Add Coach</button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {coachForm && (
        <div className="modal-overlay" onClick={() => setCoachForm(null)}>
          <div className="form-card modal-card" onClick={e => e.stopPropagation()}>
            <h2>{coachForm.id ? 'Edit Coach' : 'Add Coach'}</h2>
            <div className="field">
              <label>Display Name *</label>
              <input type="text" value={coachForm.displayName} autoFocus
                onChange={e => setCoachForm({ ...coachForm, displayName: e.target.value })} maxLength={150} />
            </div>
            <div className="field">
              <label>Email *</label>
              <input type="email" value={coachForm.email}
                onChange={e => setCoachForm({ ...coachForm, email: e.target.value })} placeholder="coach@utoledo.edu" maxLength={200} />
            </div>
            <div className="field">
              <label>Title</label>
              <select value={coachForm.title} onChange={e => setCoachForm({ ...coachForm, title: e.target.value })}>
                {TITLES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <label className={`checkbox-chip ${coachForm.isHeadCoach ? 'checkbox-chip--checked' : ''}`} style={{ marginBottom: '1rem' }}>
              <input type="checkbox" checked={coachForm.isHeadCoach}
                onChange={e => setCoachForm({ ...coachForm, isHeadCoach: e.target.checked, title: e.target.checked ? 'Head Coach' : coachForm.title })} />
              <span>Is Head Coach? (only one per sport — toggling reassigns)</span>
            </label>

            {coachForm.isHeadCoach && (
              <fieldset className="fieldset" style={{ marginBottom: '1rem' }}>
                <legend>Out-of-Office Delegation (optional)</legend>
                <p className="field-hint" style={{ marginBottom: '.5rem' }}>
                  While traveling, route this coach's approvals to a delegate until the expiry date.
                </p>
                <div className="athlete-row-fields">
                  <div className="field">
                    <label>Delegate Email</label>
                    <input type="email" value={coachForm.delegatedApproverEmail}
                      onChange={e => setCoachForm({ ...coachForm, delegatedApproverEmail: e.target.value })} placeholder="delegate@utoledo.edu" />
                  </div>
                  <div className="field">
                    <label>Delegation Expires</label>
                    <input type="date" value={coachForm.delegationExpiresAt}
                      onChange={e => setCoachForm({ ...coachForm, delegationExpiresAt: e.target.value })} />
                  </div>
                </div>
              </fieldset>
            )}

            {error && <p className="error">{error}</p>}
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn btn-primary" onClick={saveCoach} disabled={savingCoach}>
                {savingCoach ? 'Saving…' : coachForm.id ? 'Save Coach' : 'Add Coach'}
              </button>
              <button className="btn btn-secondary" onClick={() => setCoachForm(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Date-only expiries (YYYY-MM-DD) stay active through the end of that day — mirrors the Worker.
function isDelegationActive(co: Coach): boolean {
  if (!co.delegatedApproverEmail || !co.delegationExpiresAt) return false;
  const s = co.delegationExpiresAt;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(s) ? Date.parse(`${s}T00:00:00Z`) + 86_400_000 : Date.parse(s);
  return !isNaN(ms) && ms > Date.now();
}

function CoachRow({ co, onEdit, onRemove }: { co: Coach; onEdit: (c: Coach) => void; onRemove: (c: Coach) => void }) {
  const delegationActive = isDelegationActive(co);
  return (
    <tr>
      <td style={{ width: '120px' }}>
        <span className={`badge ${co.isHeadCoach ? 'badge--cfo' : 'badge--coach'}`}>
          {co.isHeadCoach ? 'Head Coach' : (co.title || 'Staff')}
        </span>
      </td>
      <td style={{ fontWeight: 500 }}>{co.displayName}</td>
      <td>{co.email}</td>
      <td>{delegationActive ? <span className="badge badge--pending-approval" title={`Until ${co.delegationExpiresAt}`}>Delegated</span> : null}</td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <button className="btn btn-secondary" style={{ padding: '3px 10px', fontSize: '.78rem', marginRight: '6px' }} onClick={() => onEdit(co)}>Edit</button>
        <button className="btn-remove" onClick={() => onRemove(co)}>Remove</button>
      </td>
    </tr>
  );
}
