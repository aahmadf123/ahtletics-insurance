export function validateRocketNumber(value: string): boolean {
  return /^R\d{8}$/.test(value);
}

// Term deadlines: month is 1-based, day is 1-based.
// "Full Year" follows the Fall deadline (September 8). Multi-word term keys are
// matched against the leading words of the term string (see termKeyFor).
const DEADLINES: Record<string, { month: number; day: number }> = {
  Fall: { month: 9, day: 8 },
  'Spring/Summer': { month: 1, day: 26 },
  Summer: { month: 7, day: 1 },
  'Full Year': { month: 9, day: 8 },
};

/** Extract the term key (e.g. "Full Year" from "Full Year 2026") from a term string. */
function termKeyFor(term: string): string {
  // "Full Year 2026" → "Full Year"; everything else is a single leading word.
  if (term.startsWith('Full Year')) return 'Full Year';
  return term.split(' ')[0];
}

export function isBeforeDeadline(term: string): boolean {
  const termKey = termKeyFor(term); // e.g. "Fall" from "Fall 2025"
  const deadline = DEADLINES[termKey];
  if (!deadline) return false; // unknown term, reject
  const now = new Date();
  const yearToken = term.slice(termKey.length).trim().split(' ')[0];
  const year = parseInt(yearToken || String(now.getFullYear()), 10);
  const deadlineDate = new Date(year, deadline.month - 1, deadline.day, 23, 59, 59);
  return now <= deadlineDate;
}

export function getPremiumForTerm(term: string): number {
  const termKey = termKeyFor(term);
  const premiums: Record<string, number> = {
    Fall: 898.0,
    'Spring/Summer': 1394.0,
    Summer: 546.0,
    'Full Year': 2292.0, // Fall (898) + Spring/Summer (1394)
  };
  return premiums[termKey] ?? 0;
}

/** Deterministic ISO date (YYYY-MM-DD) for a term's submission deadline, for machine use (.ics). */
export function getSubmissionDeadlineISO(term: string): string {
  const termKey = termKeyFor(term);
  const deadline = DEADLINES[termKey];
  if (!deadline) return '';
  const year = term.slice(termKey.length).trim().split(' ')[0] || String(new Date().getFullYear());
  return `${year}-${String(deadline.month).padStart(2, '0')}-${String(deadline.day).padStart(2, '0')}`;
}

/** Get the submission deadline string for a given term (e.g. "Fall 2026" → "September 8, 2026") */
export function getSubmissionDeadline(term: string): string {
  const termKey = termKeyFor(term);
  const year = term.slice(termKey.length).trim().split(' ')[0] || String(new Date().getFullYear());
  const deadlineNames: Record<string, string> = {
    Fall: `September 8, ${year}`,
    'Spring/Summer': `January 26, ${year}`,
    Summer: `July 1, ${year}`,
    'Full Year': `September 8, ${year}`,
  };
  return deadlineNames[termKey] ?? `September 8, ${year}`;
}

export function newUUID(): string {
  return crypto.randomUUID();
}
