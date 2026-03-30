/** Validates Rocket Number format: letter R followed by exactly 8 digits. */
export function isValidRocketNumber(value: string): boolean {
  return /^R\d{8}$/.test(value);
}

/** Validates that a term string matches the expected pattern, e.g. "Fall 2025". */
export function isValidTerm(term: string): boolean {
  return /^(Fall|Spring\/Summer|Summer)\s\d{4}$/.test(term);
}

/** Validates an email looks like a UToledo address. */
export function isUToledoEmail(email: string): boolean {
  return /^[^@]+@utoledo\.edu$/i.test(email);
}

/** Sanitises a string for inclusion in SQL (defense-in-depth on top of Drizzle params). */
export function sanitiseText(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a string');
  return value.trim().slice(0, 512);
}
