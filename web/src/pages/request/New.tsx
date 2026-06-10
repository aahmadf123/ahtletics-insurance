import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { listSports, submitRequest } from '../../lib/api';
import { PremiumDisplay } from '../../components/PremiumDisplay';
import { DisclaimerCheckboxes } from '../../components/DisclaimerCheckboxes';
import { TERM_OPTIONS } from '../../types';
import type { SportProgram, AthleteEntry, FundingSource } from '../../types';

const CURRENT_YEAR = new Date().getFullYear();

const TERMS = TERM_OPTIONS.map(t => ({
  value: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  label: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  premium: t.premium,
  termKey: t.label,
  deadline: t.deadline,
}));

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

export function NewRequest() {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [sports, setSports] = useState<SportProgram[]>([]);
  const [term, setTerm] = useState('');
  const [sport, setSport] = useState('');
  const [fundingSource, setFundingSource] = useState<FundingSource>('operating_budget');
  const [coachEmail, setCoachEmail] = useState('');
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
      if (field === 'email') updated.emailError = validateEmail(updated.email);
      return updated;
    }));
  };

  // When a sport is picked, pre-fill the coach email the Super Admin maintains for that
  // program (coach can still override it).
  const selectSport = (sportId: string) => {
    setSport(sportId);
    const picked = sports.find(s => s.id === sportId);
    if (picked?.headCoachEmail) setCoachEmail(picked.headCoachEmail);
  };

  const selectedSport = sports.find(s => s.id === sport);

  const addAthlete = () => setAthletes(prev => [...prev, emptyAthlete()]);

  const removeAthlete = (index: number) => {
    if (athletes.length === 1) return;
    setAthletes(prev => prev.filter((_, i) => i !== index));
  };

  const coachEmailError = validateEmail(coachEmail);
  const athletesValid = athletes.every(
    a => a.firstName.trim() && a.lastName.trim() && /^R\d{8}$/.test(a.rocketNumber) && !a.rocketError && !a.emailError
  );
  const canSubmit = term && sport && athletesValid && allAcknowledged && !coachEmailError;

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
          email: a.email.trim() || undefined,
        })),
        term,
        sport,
        fundingSource,
        coachEmail: coachEmail.trim() || undefined,
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
        Complete all fields below. After submission, you will be prompted to sign the request(s).
        The request will then be routed to the Sport Administrator and CFO for approval.
      </p>

      <form className="form-card" onSubmit={handleSubmit}>
        <fieldset className="fieldset">
          <legend>Program Information</legend>
          <div className="athlete-row-fields">
            <div className="field">
              <label>Sport *</label>
              <select
                value={sport}
                onChange={e => selectSport(e.target.value)}
                required
              >
                <option value="">Select a sport…</option>
                {sports.map(s => (
                  <option key={s.id} value={s.id}>{s.name} ({s.gender})</option>
                ))}
              </select>
              {selectedSport?.headCoach && (
                <span className="field-hint">Head Coach: {selectedSport.headCoach}</span>
              )}
            </div>
            <div className="field">
              <label>Coach Email (optional)</label>
              <input
                type="email"
                value={coachEmail}
                onChange={e => setCoachEmail(e.target.value)}
                placeholder="you@utoledo.edu"
                maxLength={200}
              />
              {coachEmailError && <span className="field-error">{coachEmailError}</span>}
              <span className="field-hint">We'll email you a confirmation and the final approval notice.</span>
            </div>
          </div>
        </fieldset>

        {/* Funding source */}
        <fieldset className="fieldset">
          <legend>Funding Source *</legend>
          <p className="page-subtitle" style={{ marginTop: 0 }}>
            Choose which account the premium will be deducted from.
          </p>
          <div className="radio-group">
            <label className={`radio-option ${fundingSource === 'operating_budget' ? 'radio-option--checked' : ''}`}>
              <input
                type="radio"
                name="fundingSource"
                value="operating_budget"
                checked={fundingSource === 'operating_budget'}
                onChange={() => setFundingSource('operating_budget')}
              />
              <span>Operating Budget</span>
            </label>
            <label className={`radio-option ${fundingSource === 'foundation_account' ? 'radio-option--checked' : ''}`}>
              <input
                type="radio"
                name="fundingSource"
                value="foundation_account"
                checked={fundingSource === 'foundation_account'}
                onChange={() => setFundingSource('foundation_account')}
              />
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
              {TERMS.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
          {selectedTerm && (
            <PremiumDisplay
              term={term}
              premium={selectedTerm.premium}
              athleteCount={athletes.length}
              fundingSource={fundingSource}
            />
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

                <div className="field">
                  <label>Student Email (optional)</label>
                  <input
                    type="email"
                    value={athlete.email}
                    onChange={e => updateAthlete(index, 'email', e.target.value)}
                    placeholder="student@rockets.utoledo.edu"
                    maxLength={200}
                  />
                  {athlete.emailError && (
                    <span className="field-error">{athlete.emailError}</span>
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
          <DisclaimerCheckboxes deadline={deadline} fundingSource={fundingSource} onChange={setAllAcknowledged} />
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
