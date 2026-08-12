import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { listSports, listSportCoaches, submitRequest, bulkImportRequests, type BulkImportRow } from '../../lib/api';
import { PremiumDisplay } from '../../components/PremiumDisplay';
import { DisclaimerCheckboxes } from '../../components/DisclaimerCheckboxes';
import { currentTermOptions } from '../../types';
import type { SportProgram, Coach, AthleteEntry, FundingSource, RequestDetail } from '../../types';

function emptyAthlete(): AthleteEntry {
  return { firstName: '', lastName: '', rocketNumber: '', email: '' };
}

function validateRocket(val: string): string {
  if (val && !/^R\d{8}$/.test(val)) return 'Must be R followed by 8 digits (e.g. R12345678)';
  return '';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validateEmail(val: string): string {
  if (val && !EMAIL_RE.test(val)) return 'Enter a valid email address';
  return '';
}

// ── Minimal CSV parser (handles quoted fields, commas, CRLF) ──────────────────
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(c => c.trim() !== '')) rows.push(row); }
  return rows;
}

interface ParsedAthlete {
  studentName: string;
  rocketNumber: string;
  email: string;
  error?: string;
}

function rowsToAthletes(rows: string[][]): ParsedAthlete[] {
  if (rows.length === 0) return [];
  const header = rows[0].map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const col = (...names: string[]) => header.findIndex(h => names.includes(h));
  const iName = col('student_name', 'name', 'full_name', 'athlete');
  const iFirst = col('first_name', 'first');
  const iLast = col('last_name', 'last');
  const iRocket = col('rocket_number', 'rocket', 'rocket_#', 'student_id', 'ut_id');
  const iEmail = col('email', 'student_email');

  return rows.slice(1).map(r => {
    const name = iName >= 0
      ? (r[iName] ?? '').trim()
      : `${(r[iFirst] ?? '').trim()} ${(r[iLast] ?? '').trim()}`.trim();
    const rocketNumber = (iRocket >= 0 ? (r[iRocket] ?? '') : '').trim().toUpperCase();
    const email = (iEmail >= 0 ? (r[iEmail] ?? '') : '').trim();
    let error = '';
    if (!name) error = 'Missing name';
    else if (!/^R\d{8}$/.test(rocketNumber)) error = `Invalid Rocket # (${rocketNumber || 'blank'})`;
    else if (email && !EMAIL_RE.test(email)) error = 'Invalid email';
    return { studentName: name, rocketNumber, email, error };
  });
}

export function NewRequest() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const resubmit = (location.state as { resubmit?: RequestDetail & { parentRequestId?: string } } | null)?.resubmit;

  const [sports, setSports] = useState<SportProgram[]>([]);
  const [term, setTerm] = useState('');
  const [sport, setSport] = useState('');
  const [fundingSource, setFundingSource] = useState<FundingSource>('operating_budget');
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [coachId, setCoachId] = useState('');
  const [coachName, setCoachName] = useState('');
  const [coachEmail, setCoachEmail] = useState('');
  const [mode, setMode] = useState<'manual' | 'bulk'>('manual');
  const [athletes, setAthletes] = useState<AthleteEntry[]>([emptyAthlete()]);
  const [csvAthletes, setCsvAthletes] = useState<ParsedAthlete[]>([]);
  const [csvFileName, setCsvFileName] = useState('');
  const [allAcknowledged, setAllAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [bulkSummary, setBulkSummary] = useState<string>('');

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  // Prefill from a denied request being fixed & resubmitted (1.5).
  useEffect(() => {
    if (!resubmit) return;
    setSport(resubmit.sport);
    setTerm(resubmit.term);
    setFundingSource((resubmit.fundingSource as FundingSource) ?? 'operating_budget');
    setCoachName(resubmit.coachName ?? '');
    setCoachEmail(resubmit.coachEmail ?? '');
    const parts = (resubmit.studentName ?? '').split(' ');
    setAthletes([{
      firstName: parts[0] ?? '',
      lastName: parts.slice(1).join(' '),
      rocketNumber: resubmit.rocketNumber ?? '',
      email: resubmit.studentEmail ?? '',
    }]);
  }, [resubmit]);

  // Load the registered coaches for the chosen sport so the coach can pick their name (1.2).
  useEffect(() => {
    if (!sport) { setCoaches([]); return; }
    listSportCoaches(sport)
      .then(list => {
        setCoaches(list);
        // Auto-select when the resubmit data matches a registered coach.
        const match = list.find(co => co.displayName === coachName || (!!co.email && co.email === coachEmail));
        if (match) { setCoachId(match.id); setCoachName(match.displayName); setCoachEmail(match.email); }
      })
      .catch(() => setCoaches([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport]);

  // Resolved fresh on each render so a page left open across a deadline does not keep
  // offering a term the server will now reject.
  const termOptions = useMemo(() => currentTermOptions(), []);
  const openTerms = termOptions.filter(t => t.open);

  const selectedTerm = termOptions.find(t => t.value === term);
  const deadline = selectedTerm?.deadline ?? '';
  const selectedSport = sports.find(s => s.id === sport);
  const premium = selectedTerm?.premium ?? 0;

  const updateAthlete = (index: number, field: keyof AthleteEntry, value: string) => {
    setAthletes(prev => prev.map((a, i) => {
      if (i !== index) return a;
      const updated = { ...a, [field]: field === 'rocketNumber' ? value.toUpperCase() : value };
      if (field === 'rocketNumber') updated.rocketError = validateRocket(updated.rocketNumber);
      if (field === 'email') updated.emailError = validateEmail(updated.email);
      return updated;
    }));
  };

  const selectSport = (sportId: string) => {
    setSport(sportId);
    setCoachId(''); setCoachName(''); setCoachEmail('');
  };

  const selectCoach = (id: string) => {
    setCoachId(id);
    const picked = coaches.find(co => co.id === id);
    if (picked) { setCoachName(picked.displayName); setCoachEmail(picked.email?.trim() ?? ''); }
    else { setCoachName(''); setCoachEmail(''); }
  };

  const addAthlete = () => setAthletes(prev => [...prev, emptyAthlete()]);
  const removeAthlete = (index: number) => {
    if (athletes.length === 1) return;
    setAthletes(prev => prev.filter((_, i) => i !== index));
  };

  const handleCsvFile = async (file: File) => {
    setCsvFileName(file.name);
    setError('');
    const text = await file.text();
    const parsed = rowsToAthletes(parseCsv(text));
    if (parsed.length === 0) setError('No data rows found in the CSV. Expected a header row plus one row per athlete.');
    setCsvAthletes(parsed);
  };

  // Identity is satisfied either by picking a registered coach, or — when a sport has no
  // coaches on file yet — by typing a name as a fallback. A valid email is required either
  // way: the server rejects a submission without one, because it is where the submitting
  // coach's own confirmation goes and what the authorization PDF records.
  const hasRegisteredCoaches = coaches.length > 0;
  const pickedCoach = coaches.find(co => co.id === coachId);
  // Locked only when the picked coach genuinely has an address. Every sport seeded before
  // this fix has coach rows with a blank email; locking on `!!coachId` alone made the field
  // permanently uneditable and empty, so requests submitted with no coach email at all.
  const coachEmailLocked = !!pickedCoach && !!pickedCoach.email?.trim();
  const coachNeedsEmail = !!pickedCoach && !pickedCoach.email?.trim();
  const coachIdentityValid =
    (hasRegisteredCoaches ? !!coachId : !!coachName.trim()) && EMAIL_RE.test(coachEmail);
  const coachEmailError = validateEmail(coachEmail);

  const athleteCount = mode === 'bulk' ? csvAthletes.filter(a => !a.error).length : athletes.length;

  const manualValid = athletes.every(
    a => a.firstName.trim() && a.lastName.trim() && /^R\d{8}$/.test(a.rocketNumber) && !a.rocketError && !a.emailError
  );
  const bulkValid = csvAthletes.length > 0 && csvAthletes.some(a => !a.error);
  const athletesValid = mode === 'bulk' ? bulkValid : manualValid;
  const canSubmit = !!term && !!sport && coachIdentityValid && athletesValid && allAcknowledged && !submitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    setBulkSummary('');
    try {
      if (mode === 'bulk') {
        const rows: BulkImportRow[] = csvAthletes.filter(a => !a.error).map(a => ({
          studentName: a.studentName,
          rocketNumber: a.rocketNumber,
          email: a.email || undefined,
          sport,
          term,
          fundingSource,
          coachName: coachName.trim() || undefined,
          coachEmail: coachEmail.trim() || undefined,
        }));
        const result = await bulkImportRequests(rows);
        if (result.skippedCount > 0) {
          setBulkSummary(`${result.submitted} submitted, ${result.skippedCount} skipped (${result.skipped.map(s => `${s.studentName}: ${s.reason}`).join('; ')})`);
          setSubmitting(false);
          if (result.submitted > 0) setTimeout(() => navigate('/dashboard'), 4000);
          return;
        }
        navigate('/dashboard');
      } else {
        const results = await submitRequest({
          athletes: athletes.map(a => ({
            studentName: `${a.firstName.trim()} ${a.lastName.trim()}`,
            rocketNumber: a.rocketNumber,
            email: a.email.trim() || undefined,
          })),
          term,
          sport,
          fundingSource,
          coachName: coachName.trim() || undefined,
          coachEmail: coachEmail.trim() || undefined,
          parentRequestId: resubmit?.parentRequestId,
        });
        if (results.length === 1) navigate(`/request/${results[0].id}`);
        else navigate('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Submission failed');
      setSubmitting(false);
    }
  };

  const csvValidCount = useMemo(() => csvAthletes.filter(a => !a.error).length, [csvAthletes]);

  if (user?.role !== 'coach') {
    return <div className="page"><p className="error">Only coaches can submit requests.</p></div>;
  }

  return (
    <div className="page">
      <h1>New Insurance Request</h1>
      <p className="page-subtitle">
        Complete all fields below. After submission, the request is routed to the Head Coach for approval,
        then to the Sport Administrator and CFO.
      </p>

      {resubmit && (
        <div className="action-zone" style={{ marginTop: 0, marginBottom: '1rem' }}>
          <strong>Resubmitting a denied request.</strong> Correct the issue below and submit — the new
          request will be linked to the original for the audit trail.
        </div>
      )}

      <form className="form-card" onSubmit={handleSubmit}>
        <fieldset className="fieldset">
          <legend>Program Information</legend>
          <div className="athlete-row-fields">
            <div className="field">
              <label>Sport *</label>
              <select value={sport} onChange={e => selectSport(e.target.value)} required>
                <option value="">Select a sport…</option>
                {sports.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.gender})</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Your Name *</label>
              {hasRegisteredCoaches ? (
                <select value={coachId} onChange={e => selectCoach(e.target.value)} required disabled={!sport}>
                  <option value="">Select your name…</option>
                  {coaches.map(co => (
                    <option key={co.id} value={co.id}>
                      {co.displayName}{co.isHeadCoach ? ' (Head Coach)' : co.title ? ` (${co.title})` : ''}
                      {co.email?.trim() ? '' : ' — email needed'}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={coachName}
                  onChange={e => setCoachName(e.target.value)}
                  placeholder={sport ? 'Your full name' : 'Select a sport first'}
                  disabled={!sport}
                  maxLength={150}
                />
              )}
              {sport && !hasRegisteredCoaches && (
                <span className="field-hint">No coaches are on file for this sport yet — enter your name and email.</span>
              )}
            </div>
            <div className="field">
              <label>Coach Email *</label>
              <input
                type="email"
                value={coachEmail}
                onChange={e => setCoachEmail(e.target.value)}
                placeholder="you@utoledo.edu"
                maxLength={200}
                readOnly={coachEmailLocked}
              />
              {coachNeedsEmail && !coachEmailError && (
                <span className="field-hint">
                  We don't have an email on file for you. Enter your address — your submission
                  confirmation goes there.
                </span>
              )}
              {coachEmailError && <span className="field-error">{coachEmailError}</span>}
            </div>
          </div>
          {selectedSport?.headCoach && selectedSport.headCoachEmail && (
            <span className="field-hint">
              Head Coach for {selectedSport.name}: {selectedSport.headCoach} — they will receive the approval request.
            </span>
          )}
          {selectedSport && !selectedSport.headCoachEmail && (
            // Without this the form claimed the head coach "will receive the approval
            // request" while the address it needed did not exist, and step 1 went nowhere.
            <span className="field-error">
              No head coach with an email address is on file for {selectedSport.name}. Your request
              will be submitted, but the approval request cannot be delivered until an
              administrator adds one.
            </span>
          )}
        </fieldset>

        {/* Funding source */}
        <fieldset className="fieldset">
          <legend>Funding Source *</legend>
          <p className="page-subtitle" style={{ marginTop: 0 }}>
            Choose which account the premium will be deducted from.
          </p>
          <div className="radio-group">
            <label className={`radio-option ${fundingSource === 'operating_budget' ? 'radio-option--checked' : ''}`}>
              <input type="radio" name="fundingSource" value="operating_budget"
                checked={fundingSource === 'operating_budget'} onChange={() => setFundingSource('operating_budget')} />
              <span>Operating Budget</span>
            </label>
            <label className={`radio-option ${fundingSource === 'foundation_account' ? 'radio-option--checked' : ''}`}>
              <input type="radio" name="fundingSource" value="foundation_account"
                checked={fundingSource === 'foundation_account'} onChange={() => setFundingSource('foundation_account')} />
              <span>Foundation Account</span>
            </label>
          </div>
        </fieldset>

        {/* Term selection */}
        <fieldset className="fieldset">
          <legend>Academic Term</legend>
          <div className="field">
            <label>Term *</label>
            <select value={term} onChange={e => setTerm(e.target.value)} required>
              <option value="">Select a term…</option>
              {/* Closed terms are omitted rather than shown and rejected with a 422
                  after the coach has filled in the whole form. */}
              {openTerms.map(t => (
                <option key={t.value} value={t.value}>
                  {t.label} — submit by {t.deadline}
                </option>
              ))}
            </select>
            {openTerms.length === 0 && (
              <span className="field-error">
                No term is currently open for submission. Contact the Athletics Business Office.
              </span>
            )}
            {selectedTerm && (
              <span className="field-hint">
                Requests for {selectedTerm.label} must be fully approved by {selectedTerm.deadline}.
              </span>
            )}
          </div>
          {selectedTerm && (
            <PremiumDisplay term={term} premium={premium} athleteCount={Math.max(1, athleteCount)} fundingSource={fundingSource} />
          )}
        </fieldset>

        {/* Mode toggle: manual vs bulk CSV (2.2) */}
        <fieldset className="fieldset">
          <legend>Student-Athletes</legend>
          <div className="radio-group" style={{ marginBottom: '1rem' }}>
            <label className={`radio-option ${mode === 'manual' ? 'radio-option--checked' : ''}`}>
              <input type="radio" name="mode" checked={mode === 'manual'} onChange={() => setMode('manual')} />
              <span>Enter manually</span>
            </label>
            <label className={`radio-option ${mode === 'bulk' ? 'radio-option--checked' : ''}`}>
              <input type="radio" name="mode" checked={mode === 'bulk'} onChange={() => setMode('bulk')} />
              <span>Bulk Import (CSV)</span>
            </label>
          </div>

          {mode === 'manual' ? (
            <>
              {athletes.map((athlete, index) => (
                <div key={index} className="athlete-row">
                  <div className="athlete-row-header">
                    <span className="athlete-index">Athlete #{index + 1}</span>
                    {athletes.length > 1 && (
                      <button type="button" className="btn-remove" onClick={() => removeAthlete(index)} aria-label="Remove athlete">
                        ✕ Remove
                      </button>
                    )}
                  </div>
                  <div className="athlete-row-fields">
                    <div className="field">
                      <label>First Name *</label>
                      <input type="text" value={athlete.firstName}
                        onChange={e => updateAthlete(index, 'firstName', e.target.value)} placeholder="First name" required maxLength={100} />
                    </div>
                    <div className="field">
                      <label>Last Name *</label>
                      <input type="text" value={athlete.lastName}
                        onChange={e => updateAthlete(index, 'lastName', e.target.value)} placeholder="Last name" required maxLength={100} />
                    </div>
                    <div className="field">
                      <label>Rocket Number *</label>
                      <input type="text" value={athlete.rocketNumber}
                        onChange={e => updateAthlete(index, 'rocketNumber', e.target.value)} placeholder="R12345678" required maxLength={9} />
                      {athlete.rocketError && <span className="field-error">{athlete.rocketError}</span>}
                    </div>
                    <div className="field">
                      <label>Student Email (optional)</label>
                      <input type="email" value={athlete.email}
                        onChange={e => updateAthlete(index, 'email', e.target.value)} placeholder="student@rockets.utoledo.edu" maxLength={200} />
                      {athlete.emailError && <span className="field-error">{athlete.emailError}</span>}
                    </div>
                  </div>
                </div>
              ))}
              <button type="button" className="btn btn-secondary btn-add-athlete" onClick={addAthlete}>
                + Add Another Athlete
              </button>
            </>
          ) : (
            <div className="athlete-row">
              <p className="field-hint" style={{ marginBottom: '.75rem' }}>
                Upload a CSV with columns: <code>student_name</code> (or <code>first_name</code>,&nbsp;
                <code>last_name</code>), <code>rocket_number</code>, and optional <code>email</code>.
                The Sport, Term, and Funding Source selected above apply to every athlete.
              </p>
              <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                {csvFileName || 'Choose CSV file…'}
                <input type="file" accept=".csv,text/csv" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleCsvFile(f); }} />
              </label>
              {csvAthletes.length > 0 && (
                <div className="table-wrapper" style={{ marginTop: '1rem' }}>
                  <p className="field-hint">{csvValidCount} of {csvAthletes.length} rows valid and ready to submit.</p>
                  <table className="data-table">
                    <thead><tr><th>Student-Athlete</th><th>Rocket #</th><th>Email</th><th>Status</th></tr></thead>
                    <tbody>
                      {csvAthletes.map((a, i) => (
                        <tr key={i} style={a.error ? { background: '#fff5f5' } : undefined}>
                          <td>{a.studentName || '—'}</td>
                          <td><code>{a.rocketNumber || '—'}</code></td>
                          <td>{a.email || '—'}</td>
                          <td>{a.error
                            ? <span className="badge badge--voided">{a.error}</span>
                            : <span className="badge badge--executed">Ready</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </fieldset>

        {/* Disclaimer checkboxes */}
        <fieldset className="fieldset">
          <legend>Required Acknowledgments</legend>
          <DisclaimerCheckboxes deadline={deadline} fundingSource={fundingSource} onChange={setAllAcknowledged} />
        </fieldset>

        {error && <p className="error">{error}</p>}
        {bulkSummary && <p className="success" style={{ color: '#16a34a', fontWeight: 600 }}>{bulkSummary}</p>}

        <button type="submit" className="btn btn-primary btn-full" disabled={!canSubmit}>
          {submitting
            ? 'Submitting…'
            : mode === 'bulk'
              ? `Submit ${csvValidCount} Request${csvValidCount !== 1 ? 's' : ''}`
              : athletes.length > 1
                ? `Submit ${athletes.length} Requests`
                : 'Submit Request'}
        </button>
      </form>
    </div>
  );
}
