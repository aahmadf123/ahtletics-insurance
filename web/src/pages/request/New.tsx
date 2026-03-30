import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../lib/auth';
import { listSports, submitRequest } from '../../lib/api';
import { DisclaimerCheckboxes } from '../../components/DisclaimerCheckboxes';
import { PremiumDisplay } from '../../components/PremiumDisplay';
import { TERM_OPTIONS } from '../../types';
import type { SportProgram } from '../../types';

const CURRENT_YEAR = new Date().getFullYear();

const TERMS = TERM_OPTIONS.map(t => ({
  value: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  label: `${t.label} ${t.label === 'Fall' ? CURRENT_YEAR : CURRENT_YEAR + 1}`,
  premium: t.premium,
}));

const DEADLINES: Record<string, string> = {
  Fall: `September 8, ${CURRENT_YEAR}`,
  'Spring/Summer': `January 26, ${CURRENT_YEAR + 1}`,
  Summer: `July 1, ${CURRENT_YEAR + 1}`,
};

export function NewRequest() {
  const { user } = useAuth();
  const navigate  = useNavigate();

  const [sports, setSports]           = useState<SportProgram[]>([]);
  const [studentName, setStudentName] = useState('');
  const [rocketNumber, setRocketNumber] = useState('');
  const [sport, setSport]             = useState('');
  const [term, setTerm]               = useState('');
  const [disclaimerOk, setDisclaimerOk] = useState(false);
  const [submitting, setSubmitting]   = useState(false);
  const [error, setError]             = useState('');
  const [rocketError, setRocketError] = useState('');

  useEffect(() => {
    listSports().then(setSports).catch(console.error);
  }, []);

  if (user?.role !== 'coach') {
    return <div className="page"><p className="error">Only coaches can submit requests.</p></div>;
  }

  const selectedTerm = TERMS.find(t => t.value === term);
  const termKey = term.split(' ')[0];
  const deadline = DEADLINES[termKey] ?? '';

  const validateRocket = (val: string) => {
    if (val && !/^R\d{8}$/.test(val)) {
      setRocketError('Must be R followed by 8 digits (e.g. R12345678)');
    } else {
      setRocketError('');
    }
    setRocketNumber(val);
  };

  const canSubmit = studentName.trim() && !rocketError && /^R\d{8}$/.test(rocketNumber)
    && sport && term && disclaimerOk;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await submitRequest({ studentName: studentName.trim(), rocketNumber, sport, term });
      navigate(`/request/${res.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page">
      <h1>New Insurance Request</h1>
      <p className="page-subtitle">Complete all fields and check all three disclaimers before submitting.</p>

      <form className="form-card" onSubmit={handleSubmit}>
        <fieldset className="fieldset">
          <legend>Student-Athlete Information</legend>

          <div className="field">
            <label>Student-Athlete Full Name *</label>
            <input
              type="text"
              value={studentName}
              onChange={e => setStudentName(e.target.value)}
              placeholder="First Last"
              required
              maxLength={200}
            />
          </div>

          <div className="field">
            <label>Rocket Number *</label>
            <input
              type="text"
              value={rocketNumber}
              onChange={e => validateRocket(e.target.value.toUpperCase())}
              placeholder="R12345678"
              required
              maxLength={9}
            />
            {rocketError && <span className="field-error">{rocketError}</span>}
          </div>

          <div className="field">
            <label>Sport *</label>
            <select value={sport} onChange={e => setSport(e.target.value)} required>
              <option value="">Select a sport…</option>
              {sports.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Academic Term *</label>
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

        {term && (
          <fieldset className="fieldset">
            <legend>Required Acknowledgments</legend>
            <DisclaimerCheckboxes
              deadline={deadline}
              onChange={setDisclaimerOk}
            />
          </fieldset>
        )}

        {error && <p className="error">{error}</p>}

        <button
          type="submit"
          className="btn btn-primary btn-full"
          disabled={!canSubmit || submitting}
        >
          {submitting ? 'Submitting…' : 'Submit Request & Apply My Signature'}
        </button>
      </form>
    </div>
  );
}
