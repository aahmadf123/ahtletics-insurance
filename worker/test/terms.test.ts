import { describe, it, expect } from 'vitest';
import {
  termKeyFor, termYearFor, getPremiumForTerm, isBeforeDeadline,
  getSubmissionDeadline, getSubmissionDeadlineISO, currentTermOptions,
} from '../../shared/terms';

describe('termKeyFor', () => {
  it('reads the multi-word Full Year key without splitting it', () => {
    expect(termKeyFor('Full Year 2026')).toBe('Full Year');
  });

  it('reads single-word keys, including the one containing a slash', () => {
    expect(termKeyFor('Fall 2026')).toBe('Fall');
    expect(termKeyFor('Spring/Summer 2027')).toBe('Spring/Summer');
    expect(termKeyFor('Summer 2027')).toBe('Summer');
  });
});

describe('termYearFor', () => {
  it('parses the year from the term string', () => {
    expect(termYearFor('Spring/Summer 2027')).toBe(2027);
    expect(termYearFor('Full Year 2026')).toBe(2026);
  });

  it('falls back to the current year when no year is present', () => {
    const now = new Date(2026, 6, 29);
    expect(termYearFor('Fall', now)).toBe(2026);
  });
});

describe('getPremiumForTerm', () => {
  it('prices each term', () => {
    expect(getPremiumForTerm('Fall 2026')).toBe(898);
    expect(getPremiumForTerm('Spring/Summer 2027')).toBe(1394);
    expect(getPremiumForTerm('Summer 2027')).toBe(546);
  });

  it('prices Full Year as Fall plus Spring/Summer', () => {
    expect(getPremiumForTerm('Full Year 2026'))
      .toBe(getPremiumForTerm('Fall 2026') + getPremiumForTerm('Spring/Summer 2027'));
  });

  it('returns zero for an unknown term rather than guessing', () => {
    expect(getPremiumForTerm('Winter 2026')).toBe(0);
  });
});

describe('isBeforeDeadline', () => {
  it('accepts a term on its deadline day and rejects it the next day', () => {
    expect(isBeforeDeadline('Fall 2026', new Date(2026, 8, 8, 12, 0))).toBe(true);
    expect(isBeforeDeadline('Fall 2026', new Date(2026, 8, 8, 23, 59, 59))).toBe(true);
    expect(isBeforeDeadline('Fall 2026', new Date(2026, 8, 9, 0, 0, 1))).toBe(false);
  });

  it('rejects unknown terms outright', () => {
    expect(isBeforeDeadline('Winter 2026', new Date(2026, 0, 1))).toBe(false);
  });

  it('follows the Fall deadline for Full Year', () => {
    expect(isBeforeDeadline('Full Year 2026', new Date(2026, 8, 8))).toBe(true);
    expect(isBeforeDeadline('Full Year 2026', new Date(2026, 8, 20))).toBe(false);
  });
});

describe('deadline formatting', () => {
  it('produces a machine-readable ISO date', () => {
    expect(getSubmissionDeadlineISO('Fall 2026')).toBe('2026-09-08');
    expect(getSubmissionDeadlineISO('Spring/Summer 2027')).toBe('2027-01-26');
    expect(getSubmissionDeadlineISO('Summer 2027')).toBe('2027-07-01');
  });

  it('produces a display date matching the ISO date', () => {
    expect(getSubmissionDeadline('Fall 2026')).toBe('September 8, 2026');
    expect(getSubmissionDeadline('Spring/Summer 2027')).toBe('January 26, 2027');
  });

  it('returns an empty ISO date for an unknown term rather than a wrong one', () => {
    expect(getSubmissionDeadlineISO('Winter 2026')).toBe('');
  });
});

describe('currentTermOptions', () => {
  // The regression this exists for: the form used to pin Spring/Summer to next year
  // unconditionally, so between January 1 and the January 26 deadline the still-open
  // current-year term could not be selected at all.
  it('offers the current year Spring/Summer while its deadline is still ahead', () => {
    const jan10 = new Date(2027, 0, 10);
    const springSummer = currentTermOptions(jan10).find(t => t.key === 'Spring/Summer');
    expect(springSummer?.value).toBe('Spring/Summer 2027');
    expect(springSummer?.open).toBe(true);
  });

  it('rolls Spring/Summer to next year once the deadline has passed', () => {
    const feb1 = new Date(2027, 1, 1);
    const springSummer = currentTermOptions(feb1).find(t => t.key === 'Spring/Summer');
    expect(springSummer?.value).toBe('Spring/Summer 2028');
  });

  it('rolls Fall forward after its September deadline', () => {
    const sept20 = new Date(2026, 8, 20);
    const fall = currentTermOptions(sept20).find(t => t.key === 'Fall');
    expect(fall?.value).toBe('Fall 2027');
  });

  it('keeps Fall on the current year on the deadline day itself', () => {
    const sept8 = new Date(2026, 8, 8, 9, 0);
    const fall = currentTermOptions(sept8).find(t => t.key === 'Fall');
    expect(fall?.value).toBe('Fall 2026');
    expect(fall?.open).toBe(true);
  });

  it('only offers terms the server will accept', () => {
    for (const now of [new Date(2026, 0, 5), new Date(2026, 6, 29), new Date(2026, 11, 20)]) {
      for (const option of currentTermOptions(now)) {
        expect(option.open).toBe(true);
        expect(isBeforeDeadline(option.value, now)).toBe(true);
      }
    }
  });

  it('labels each option with a deadline that matches its term', () => {
    const options = currentTermOptions(new Date(2026, 6, 29));
    const fall = options.find(t => t.key === 'Fall')!;
    expect(fall.deadline).toBe(getSubmissionDeadline(fall.value));
  });
});
