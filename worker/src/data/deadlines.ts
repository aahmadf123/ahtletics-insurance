// Academic term premiums and enrollment deadlines (Anthem Student Advantage).
// Deadline month/day are applied against the YEAR extracted from the term string.

export const TERM_DATA = {
  'Fall': {
    label: 'Fall',
    premium: 898.00,
    coveragePeriod: 'August 11 – December 31',
    deadlineMonth: 9,  // September
    deadlineDay: 8,
  },
  'Spring/Summer': {
    label: 'Spring/Summer',
    premium: 1394.00,
    coveragePeriod: 'January 1 – August 10',
    deadlineMonth: 1,  // January
    deadlineDay: 26,
  },
  'Summer': {
    label: 'Summer',
    premium: 546.00,
    coveragePeriod: 'May 11 – August 10',
    deadlineMonth: 7,  // July
    deadlineDay: 1,
  },
} as const;

export type TermKey = keyof typeof TERM_DATA;

/** Returns the deadline Date for a term string like "Fall 2025". */
export function getTermDeadline(term: string): Date | null {
  const [termName, yearStr] = term.split(' ');
  const data = TERM_DATA[termName as TermKey];
  if (!data) return null;
  const year = parseInt(yearStr, 10);
  if (isNaN(year)) return null;
  return new Date(year, data.deadlineMonth - 1, data.deadlineDay, 23, 59, 59);
}

/** True if the current UTC time is past the enrollment deadline. */
export function isDeadlinePassed(term: string): boolean {
  const deadline = getTermDeadline(term);
  if (!deadline) return true;
  return Date.now() > deadline.getTime();
}

/** Returns the premium cost for a given term key ("Fall", "Spring/Summer", "Summer"). */
export function getPremiumForTerm(term: string): number | null {
  const termName = term.split(' ')[0] as TermKey;
  return TERM_DATA[termName]?.premium ?? null;
}

/** List of available academic terms for the current/upcoming enrollment cycle. */
export function getAvailableTerms(currentYear: number): string[] {
  return [
    `Fall ${currentYear}`,
    `Spring/Summer ${currentYear + 1}`,
    `Summer ${currentYear + 1}`,
  ];
}
