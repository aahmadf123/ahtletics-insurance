// Term premiums, deadlines, and parsing live in shared/terms.ts so the Worker and the
// SPA cannot disagree about what a term costs or when it closes. Re-exported here so
// existing call sites keep working.
export {
  isBeforeDeadline,
  getPremiumForTerm,
  getSubmissionDeadline,
  getSubmissionDeadlineISO,
  termKeyFor,
  TERMS,
  type TermKey,
} from '../../../shared/terms';

export function validateRocketNumber(value: string): boolean {
  return /^R\d{8}$/.test(value);
}

export function newUUID(): string {
  return crypto.randomUUID();
}
