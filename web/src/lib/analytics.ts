import type { ReportRow } from '../types';
import { fundingSourceLabel } from '../types';

export interface SportSummary {
  sportName: string;
  count: number;
  pendingCoach: number;
  pendingApproval: number;
  executedCount: number;
  voidedCount: number;
  expiredCount: number;
  committedPremium: number;
  executedPremium: number;
}

/**
 * Aggregate report rows by sport. "Committed" mirrors the on-screen total:
 * EXECUTED plus still-pending (PENDING_APPROVAL); "Executed" counts only finalized requests.
 */
export function summarizeBySport(rows: ReportRow[]): SportSummary[] {
  const map = new Map<string, SportSummary>();
  for (const r of rows) {
    const key = r.sportName || r.sport || 'Unknown';
    let s = map.get(key);
    if (!s) {
      s = {
        sportName: key, count: 0,
        pendingCoach: 0, pendingApproval: 0,
        executedCount: 0, voidedCount: 0, expiredCount: 0,
        committedPremium: 0, executedPremium: 0,
      };
      map.set(key, s);
    }
    s.count += 1;
    if (r.status === 'PENDING_COACH') s.pendingCoach += 1;
    if (r.status === 'PENDING_APPROVAL') s.pendingApproval += 1;
    if (r.status === 'VOIDED') s.voidedCount += 1;
    if (r.status === 'EXPIRED') s.expiredCount += 1;
    if (r.status === 'EXECUTED' || r.status === 'PENDING_APPROVAL') s.committedPremium += r.premiumCost;
    if (r.status === 'EXECUTED') {
      s.executedPremium += r.premiumCost;
      s.executedCount += 1;
    }
  }
  return [...map.values()].sort((a, b) => a.sportName.localeCompare(b.sportName));
}

const CURRENCY = '"$"#,##0.00';

/**
 * Build and download a two-sheet workbook: a detail sheet (one row per request)
 * and a "Summary by Sport" sheet with a TOTAL row. `write-excel-file` is loaded
 * lazily so it is only pulled into the bundle when an export is triggered.
 */
export async function exportReportXlsx(rows: ReportRow[]): Promise<void> {
  // The objects + per-sheet schema multi-sheet form is supported at runtime but is
  // not covered by the library's TypeScript overloads, so we narrow it locally.
  const writeXlsxFile = (await import('write-excel-file/browser')).default as unknown as (
    data: unknown[][],
    options: { schema: unknown[][]; sheets: string[]; fileName: string },
  ) => Promise<void>;

  const detailSchema = [
    { column: 'Student-Athlete', type: String, value: (r: ReportRow) => r.studentName },
    { column: 'Rocket #', type: String, value: (r: ReportRow) => r.rocketNumber },
    { column: 'Sport', type: String, value: (r: ReportRow) => r.sportName || r.sport },
    { column: 'Term', type: String, value: (r: ReportRow) => r.term },
    { column: 'Funding Source', type: String, value: (r: ReportRow) => fundingSourceLabel(r.fundingSource) },
    { column: 'Coach', type: String, value: (r: ReportRow) => r.coachName },
    { column: 'Coach Email', type: String, value: (r: ReportRow) => r.coachEmail || '' },
    { column: 'Premium', type: Number, format: CURRENCY, value: (r: ReportRow) => r.premiumCost },
    { column: 'Status', type: String, value: (r: ReportRow) => r.status.replace(/_/g, ' ') },
    { column: 'Submitted', type: String, value: (r: ReportRow) => new Date(r.createdAt).toLocaleDateString() },
  ];

  const summary = summarizeBySport(rows);
  const totalRow: SportSummary = {
    sportName: 'TOTAL',
    count: summary.reduce((n, s) => n + s.count, 0),
    committedPremium: summary.reduce((n, s) => n + s.committedPremium, 0),
    executedPremium: summary.reduce((n, s) => n + s.executedPremium, 0),
    executedCount: summary.reduce((n, s) => n + s.executedCount, 0),
  };

  const summarySchema = [
    { column: 'Sport', type: String, value: (s: SportSummary) => s.sportName },
    { column: 'Requests', type: Number, value: (s: SportSummary) => s.count },
    { column: 'Committed Premium', type: Number, format: CURRENCY, value: (s: SportSummary) => s.committedPremium },
    { column: 'Executed Premium', type: Number, format: CURRENCY, value: (s: SportSummary) => s.executedPremium },
    { column: 'Executed Requests', type: Number, value: (s: SportSummary) => s.executedCount },
  ];

  await writeXlsxFile([rows, [...summary, totalRow]], {
    schema: [detailSchema, summarySchema],
    sheets: ['Detail', 'Summary by Sport'],
    fileName: 'athletics-insurance-report.xlsx',
  });
}
