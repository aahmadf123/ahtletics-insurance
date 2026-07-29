/**
 * Term definitions: premiums, submission deadlines, and the term-string parsing that
 * both the Worker and the SPA depend on.
 *
 * These numbers used to be written out twice, in worker/src/lib/validation.ts and in
 * web/src/types.ts. Two copies of a rate that changes every year is a drift waiting to
 * happen: the form would quote one premium and the server would record another. This
 * module is the only place they are defined.
 */

export type TermKey = 'Fall' | 'Spring/Summer' | 'Summer' | 'Full Year';

export interface TermDefinition {
  key: TermKey;
  premium: number;
  /** Submission deadline. Month is 1-based. */
  deadline: { month: number; day: number };
  /** Human-readable deadline without the year, e.g. "September 8". */
  deadlineLabel: string;
}

export const TERMS: TermDefinition[] = [
  { key: 'Fall', premium: 898.0, deadline: { month: 9, day: 8 }, deadlineLabel: 'September 8' },
  { key: 'Spring/Summer', premium: 1394.0, deadline: { month: 1, day: 26 }, deadlineLabel: 'January 26' },
  { key: 'Summer', premium: 546.0, deadline: { month: 7, day: 1 }, deadlineLabel: 'July 1' },
  // Full Year is Fall plus Spring/Summer and follows the Fall deadline.
  { key: 'Full Year', premium: 2292.0, deadline: { month: 9, day: 8 }, deadlineLabel: 'September 8' },
];

const BY_KEY = new Map<string, TermDefinition>(TERMS.map(t => [t.key, t]));

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Extract the term key from a term string, e.g. "Full Year 2026" gives "Full Year". */
export function termKeyFor(term: string): string {
  // "Full Year" is the only multi-word key; everything else is a single leading word.
  if (term.startsWith('Full Year')) return 'Full Year';
  return term.split(' ')[0];
}

/** Extract the year from a term string, falling back to the current year. */
export function termYearFor(term: string, now: Date = new Date()): number {
  const key = termKeyFor(term);
  const token = term.slice(key.length).trim().split(' ')[0];
  const parsed = parseInt(token, 10);
  return Number.isFinite(parsed) ? parsed : now.getFullYear();
}

export function getPremiumForTerm(term: string): number {
  return BY_KEY.get(termKeyFor(term))?.premium ?? 0;
}

/** The deadline instant for a term, or null when the term key is unknown. */
export function getDeadlineDate(term: string, now: Date = new Date()): Date | null {
  const def = BY_KEY.get(termKeyFor(term));
  if (!def) return null;
  const year = termYearFor(term, now);
  return new Date(year, def.deadline.month - 1, def.deadline.day, 23, 59, 59, 999);
}

export function isBeforeDeadline(term: string, now: Date = new Date()): boolean {
  const deadline = getDeadlineDate(term, now);
  if (!deadline) return false; // unknown term, reject
  return now.getTime() <= deadline.getTime();
}

/** Deterministic ISO date (YYYY-MM-DD) for a term's deadline, for machine use (.ics). */
export function getSubmissionDeadlineISO(term: string, now: Date = new Date()): string {
  const def = BY_KEY.get(termKeyFor(term));
  if (!def) return '';
  const year = termYearFor(term, now);
  return `${year}-${String(def.deadline.month).padStart(2, '0')}-${String(def.deadline.day).padStart(2, '0')}`;
}

/** Display deadline for a term, e.g. "Fall 2026" gives "September 8, 2026". */
export function getSubmissionDeadline(term: string, now: Date = new Date()): string {
  const def = BY_KEY.get(termKeyFor(term));
  const year = termYearFor(term, now);
  if (!def) return `${MONTH_NAMES[8]} 8, ${year}`; // Fall default, preserved from the original
  return `${MONTH_NAMES[def.deadline.month - 1]} ${def.deadline.day}, ${year}`;
}

export interface TermOption {
  /** Full term string used everywhere else, e.g. "Spring/Summer 2027". */
  value: string;
  label: string;
  key: TermKey;
  premium: number;
  /** Full deadline including year, e.g. "January 26, 2027". */
  deadline: string;
  /** False once the deadline has passed; the server rejects these with a 422. */
  open: boolean;
}

/**
 * The terms a coach can pick right now, each resolved to the correct academic year.
 *
 * The form used to hardcode Fall and Full Year to the current calendar year and the two
 * spring/summer terms to the next one. Between January 1 and the January 26 deadline
 * that made the still-open current-year Spring/Summer term unselectable, because the
 * dropdown had already rolled forward. Each term now takes the earliest year whose
 * deadline has not passed, so the option a coach needs is always the one offered.
 */
export function currentTermOptions(now: Date = new Date()): TermOption[] {
  return TERMS.map(def => {
    let year = now.getFullYear();
    const deadlineFor = (y: number) =>
      new Date(y, def.deadline.month - 1, def.deadline.day, 23, 59, 59, 999).getTime();
    if (deadlineFor(year) < now.getTime()) year += 1;

    const value = `${def.key} ${year}`;
    return {
      value,
      label: value,
      key: def.key,
      premium: def.premium,
      deadline: `${def.deadlineLabel}, ${year}`,
      open: deadlineFor(year) >= now.getTime(),
    };
  });
}
