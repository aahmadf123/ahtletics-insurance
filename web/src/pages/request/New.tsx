import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { listSports, submitRequest } from '../../lib/api';
import { PremiumDisplay } from '../../components/PremiumDisplay';
import { DisclaimerCheckboxes } from '../../components/DisclaimerCheckboxes';
import { TERM_OPTIONS } from '../../types';
import type { SportProgram, AthleteEntry } from '../../types';

const CURRENT_YEAR = new Date().getFullYear();

const TERMS = TERM_OPTIONS.map(t => ({
  value: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  label: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  premium: t.premium,
  termKey: t.label,
  deadline: t.deadline,
}));

function emptyAthlete(): AthleteEntry {
  return { firstName: '', lastName: '', rocketNumber: '' };
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
  const [coachName, setCoachName] = useState('');
  const [sport, setSport] = useState('');
  const [athletes, setAthletes] = useState<AthleteEntry[]>([emptyAthlete()]);
  const [allAcknowledged, setAllAcknowledged] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  if (user?.role !== 'coach') {
    return <div className="page"><p className="error">Only coaches can submit requests.</p></div>;
  }

  const selectedTerm = TERMS.find(t => t.value === term);
  const year = selectedTerm ? selectedTerm.value.split(' ').pop() : '';
  const deadline = selectedTerm ? `${selectedTerm.deadline}, ${year}` : '';

  const updateAthlete = (index: number, field: keyof AthleteEntry, value: string) => {
    setAthletes(prev => prev.map((a, i) => {
      if (i !== index) return a;
      const updated = { ...a, [field]: field === 'rocketNumber' ? value.toUpperCase() : value };
      if (field === 'rocketNumber') updated.rocketError = validateRocket(updated.rocketNumber);
      return updated;
    }));
  };

  const addAthlete = () => setAthletes(prev => [...prev, emptyAthlete()]);

  const removeAthlete = (index: number) => {
    if (athletes.length === 1) return;
    setAthletes(prev => prev.filter((_, i) => i !== index));
  };

  const athletesValid = athletes.every(
    a => a.firstName.trim() && a.lastName.trim() && /^R\d{8}$/.test(a.rocketNumber) && !a.rocketError
  );
  const canSubmit = term && coachName.trim() && sport && athletesValid && allAcknowledged;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const results = await submitRequest({
        athletes: athletes.map(a => ({
          studentName: `${a.firstName.trim()} ${a.lastName.trim()}`,
          rocketNumber: a.rocketNumber,
        })),
        term,
        coachName: coachName.trim(),
        sport,
      });
      if (results.length === 1) {
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
        Complete all fields below. Your signature is recorded automatically on submission.
        The request will then be routed to the Sport Administrator and CFO for approval.
      </p>

      <form className="form-card" onSubmit={handleSubmit}>
        {/* Coach Information */}
        <fieldset className="fieldset">
          <legend>Coach Information</legend>
          <div className="athlete-row-fields">
            <div className="field">
              <label>Coach Name *</label>
              <input
                type="text"
                value={coachName}
                onChange={e => setCoachName(e.target.value)}
                placeholder="Your full name"
                required
                maxLength={200}
              />
            </div>
            <div className="field">
              <label>Sport *</label>
              <select
                value={sport}
                onChange={e => setSport(e.target.value)}
                required
              >
                <option value="">Select a sport…</option>
                {sports.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.gender})</option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        {/* Term selection */}
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
            <PremiumDisplay term={term} premium={selectedTerm.premium} athleteCount={athletes.length} />
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
                  <label>First Name *</label>
                  <input
                    type="text"
                    value={athlete.firstName}
                    onChange={e => updateAthlete(index, 'firstName', e.target.value)}
                    placeholder="First name"
                    required
                    maxLength={100}
                  />
                </div>

                <div className="field">
                  <label>Last Name *</label>
                  <input
                    type="text"
                    value={athlete.lastName}
                    onChange={e => updateAthlete(index, 'lastName', e.target.value)}
                    placeholder="Last name"
                    required
                    maxLength={100}
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
              </div>
            </div>
          ))}

          <button type="button" className="btn btn-secondary btn-add-athlete" onClick={addAthlete}>
            + Add Another Athlete
          </button>
        </fieldset>

        {/* Disclaimer checkboxes */}
        <fieldset className="fieldset">
          <legend>Required Acknowledgments</legend>
          <DisclaimerCheckboxes deadline={deadline} onChange={setAllAcknowledged} />
        </fieldset>

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
              : 'Submit Request'}
        </button>
      </form>
    </div>
  );
}
