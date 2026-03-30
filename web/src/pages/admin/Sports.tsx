import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth';
import { listAdminSports, listAdministrators, reassignSportAdmin } from '../../lib/api';
import type { SportProgram, SportAdministrator } from '../../types';

export function AdminSports() {
  const { user }   = useAuth();
  const [sports, setSports]     = useState<SportProgram[]>([]);
  const [admins, setAdmins]     = useState<SportAdministrator[]>([]);
  const [saving, setSaving]     = useState<string | null>(null);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');

  const load = () => {
    Promise.all([listAdminSports(), listAdministrators()])
      .then(([s, a]) => { setSports(s); setAdmins(a); })
      .catch(e => setError(e.message));
  };

  useEffect(load, []);

  if (user?.role !== 'cfo') {
    return <div className="page"><p className="error">CFO access only.</p></div>;
  }

  const handleChange = async (sportId: string, adminId: string) => {
    setSaving(sportId);
    setError('');
    setSuccess('');
    try {
      await reassignSportAdmin(sportId, adminId === '__none__' ? null : adminId);
      setSuccess('Assignment updated.');
      load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(null);
    }
  };

  const unassigned = sports.filter(s => !s.sportAdminId);

  return (
    <div className="page">
      <h1>Manage Sport-to-Administrator Assignments</h1>
      {unassigned.length > 0 && (
        <div className="alert alert--warning">
          <strong>{unassigned.length} sport(s) have no assigned administrator.</strong>{' '}
          Requests for these sports will escalate directly to the CFO.
          Assign administrators below.
        </div>
      )}

      {error   && <p className="error">{error}</p>}
      {success && <p className="success">{success}</p>}

      <div className="table-wrapper">
        <table className="table">
          <thead>
            <tr>
              <th>Sport</th>
              <th>Gender</th>
              <th>Head Coach</th>
              <th>Sport Administrator</th>
            </tr>
          </thead>
          <tbody>
            {sports.map(s => (
              <tr key={s.id}>
                <td>{s.name}</td>
                <td>{s.gender}</td>
                <td>{s.headCoach ?? '—'}</td>
                <td>
                  <select
                    value={s.sportAdminId ?? '__none__'}
                    onChange={e => handleChange(s.id, e.target.value)}
                    disabled={saving === s.id}
                  >
                    <option value="__none__">— Unassigned —</option>
                    {admins.map(a => (
                      <option key={a.id} value={a.id}>
                        {a.name}{a.isCfo ? ' (CFO)' : ''}
                      </option>
                    ))}
                  </select>
                  {saving === s.id && <span> Saving…</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
