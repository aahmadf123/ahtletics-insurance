export function validateRocketNumber(value: string): boolean {
  return /^R\d{8}$/.test(value);
}

// Term deadlines: month is 1-based, day is 1-based
const DEADLINES: Record<string, { month: number; day: number }> = {
  Fall: { month: 9, day: 8 },
  'Spring/Summer': { month: 1, day: 26 },
  Summer: { month: 7, day: 1 },
};

export function isBeforeDeadline(term: string): boolean {
  const termKey = term.split(' ')[0]; // e.g. "Fall" from "Fall 2025"
  const deadline = DEADLINES[termKey];
  if (!deadline) return false; // unknown term, reject
  const now = new Date();
  const year = parseInt(term.split(' ')[1] ?? String(now.getFullYear()), 10);
  const deadlineDate = new Date(year, deadline.month - 1, deadline.day, 23, 59, 59);
  return now <= deadlineDate;
}

export function getPremiumForTerm(term: string): number {
  const termKey = term.split(' ')[0];
  const premiums: Record<string, number> = {
    Fall: 898.0,
    'Spring/Summer': 1394.0,
    Summer: 546.0,
  };
  return premiums[termKey] ?? 0;
}

/** Get the submission deadline string for a given term (e.g. "Fall 2026" → "September 8, 2026") */
export function getSubmissionDeadline(term: string): string {
  const termKey = term.split(' ')[0];
  const year = term.split(' ')[1] ?? String(new Date().getFullYear());
  const deadlineNames: Record<string, string> = {
    Fall: `September 8, ${year}`,
    'Spring/Summer': `January 26, ${year}`,
    Summer: `July 1, ${year}`,
  };
  return deadlineNames[termKey] ?? `September 8, ${year}`;
}

export function newUUID(): string {
  return crypto.randomUUID();
}
