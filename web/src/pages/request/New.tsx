import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { listSports, submitRequest } from '../../lib/api';
import { DisclaimerCheckboxes } from '../../components/DisclaimerCheckboxes';
import { PremiumDisplay } from '../../components/PremiumDisplay';
import { TERM_OPTIONS } from '../../types';
import type { SportProgram, AthleteEntry } from '../../types';

const CURRENT_YEAR = new Date().getFullYear();

const TERMS = TERM_OPTIONS.map(t => ({
  value: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  label: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  premium: t.premium,
  termKey: t.label,
}));

const DEADLINES: Record<string, string> = {
  Fall: `September 8, ${CURRENT_YEAR}`,
  'Spring/Summer': `January 26, ${CURRENT_YEAR + 1}`,
  Summer: `July 1, ${CURRENT_YEAR + 1}`,
};

function emptyAthlete(sportId?: string): AthleteEntry {
  return { studentName: '', rocketNumber: '', sport: sportId ?? '' };
}

function validateRocket(val: string): string {
  if (val && !/^R\d{8}$/.test(val)) return 'Must be R followed by 8 digits (e.g. R12345678)';
  return '';
}

export function NewRequest() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [sports, setSports] = useState<SportProgram[]>([]);
  const [term, setTerm] = useState('');
  const [athletes, setAthletes] = useState<AthleteEntry[]>([emptyAthlete(user?.sportId)]);
  const [disclaimerOk, setDisclaimerOk] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const coachSportId = user?.sportId;

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  if (user?.role !== 'coach') {
    return <div className="page"><p className="error">Only coaches can submit requests.</p></div>;
  }

  const selectedTerm = TERMS.find(t => t.value === term);
  const termKey = term.split(' ')[0] as string;
  const deadline = DEADLINES[termKey] ?? '';

  const updateAthlete = (index: number, field: keyof AthleteEntry, value: string) => {
    setAthletes(prev => prev.map((a, i) => {
      if (i !== index) return a;
      const updated = { ...a, [field]: field === 'rocketNumber' ? value.toUpperCase() : value };
      if (field === 'rocketNumber') updated.rocketError = validateRocket(updated.rocketNumber);
      return updated;
    }));
  };

  const addAthlete = () => setAthletes(prev => [...prev, emptyAthlete(coachSportId)]);

  const removeAthlete = (index: number) => {
    if (athletes.length === 1) return;
    setAthletes(prev => prev.filter((_, i) => i !== index));
  };

  const athletesValid = athletes.every(
    a => a.studentName.trim() && /^R\d{8}$/.test(a.rocketNumber) && (coachSportId || a.sport) && !a.rocketError
  );
  const canSubmit = term && athletesValid && disclaimerOk;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const results = await submitRequest({
        athletes: athletes.map(a => ({
          studentName: a.studentName.trim(),
          rocketNumber: a.rocketNumber,
          sport: coachSportId || a.sport,
        })),
        term,
      });
      // For a single request with a DocuSign signing URL, redirect directly to DocuSign
      if (results.length === 1 && results[0].signingUrl) {
        window.location.href = results[0].signingUrl;
      } else if (results.length === 1) {
        navigate(`/request/${results[0].id}`);
      } else {
        navigate('/dashboard');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <h1>New Insurance Request</h1>
      <p className="page-subtitle">
        Complete all fields and check all three disclaimers. You will be redirected to DocuSign to
        apply your signature. You may add multiple athletes in a single submission.
      </p>

      <form className="form-card" onSubmit={handleSubmit}>
        {/* Term selection — shared across all athletes */}
        <fieldset className="fieldset">
          <legend>Academic Term</legend>
          <div className="field">
            <label>Term *</label>
            <select value={term} onChange={e => setTerm(e.target.value)} required>
              <option value="">Select a term…</option>
              {TERMS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          {selectedTerm && (
            <PremiumDisplay term={term} premium={selectedTerm.premium} />
          )}
        </fieldset>

        {/* Athlete rows */}
        <fieldset className="fieldset">
          <legend>Student-Athletes ({athletes.length})</legend>

          {athletes.map((athlete, index) => (
            <div key={index} className="athlete-row">
              <div className="athlete-row-header">
                <span className="athlete-index">Athlete #{index + 1}</span>
                {athletes.length > 1 && (
                  <button
                    type="button"
                    className="btn-remove"
                    onClick={() => removeAthlete(index)}
                    aria-label="Remove athlete"
                  >
                    ✕ Remove
                  </button>
                )}
              </div>

              <div className="athlete-row-fields">
                <div className="field">
                  <label>Full Name *</label>
                  <input
                    type="text"
                    value={athlete.studentName}
                    onChange={e => updateAthlete(index, 'studentName', e.target.value)}
                    placeholder="First Last"
                    required
                    maxLength={200}
                  />
                </div>

                <div className="field">
                  <label>Rocket Number *</label>
                  <input
                    type="text"
                    value={athlete.rocketNumber}
                    onChange={e => updateAthlete(index, 'rocketNumber', e.target.value)}
                    placeholder="R12345678"
                    required
                    maxLength={9}
                  />
                  {athlete.rocketError && (
                    <span className="field-error">{athlete.rocketError}</span>
                  )}
                </div>

                <div className="field">
                  <label>Sport *</label>
                  {coachSportId ? (
                    <>
                      <input
                        type="text"
                        value={sports.find(s => s.id === coachSportId)?.name ?? coachSportId}
                        disabled
                        className="field-disabled"
                      />
                      <input type="hidden" value={coachSportId} />
                    </>
                  ) : (
                    <select
                      value={athlete.sport}
                      onChange={e => updateAthlete(index, 'sport', e.target.value)}
                      required
                    >
                      <option value="">Select a sport…</option>
                      {sports.map(s => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                    </select>
                  )}
                </div>
              </div>
            </div>
          ))}

          <button type="button" className="btn btn-secondary btn-add-athlete" onClick={addAthlete}>
            + Add Another Athlete
          </button>
        </fieldset>

        {/* Disclaimers */}
        {term && (
          <fieldset className="fieldset">
            <legend>Required Acknowledgments</legend>
            <DisclaimerCheckboxes deadline={deadline} onChange={setDisclaimerOk} />
          </fieldset>
        )}

        {error && <p className="error">{error}</p>}

        <button
          type="submit"
          className="btn btn-primary btn-full"
          disabled={!canSubmit || submitting}
        >
          {submitting
            ? 'Submitting…'
            : athletes.length > 1
              ? `Submit ${athletes.length} Requests`
              : 'Submit Request & Sign via DocuSign'}
        </button>
      </form>
    </div>
  );
}
