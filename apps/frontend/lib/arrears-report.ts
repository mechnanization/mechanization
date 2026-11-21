import { municipalToday, type ArrearsFeeType, type ArrearsReport } from '@mechanization/shared-schemas';
import { buildCsv } from './csv';

/**
 * «تقرير المتأخرات» (old debts task 11, docs/old-debts-plan.md §8): what the
 * report screen and its CSV decide, pure, so they are tested without a browser.
 * Every figure is the server's; nothing here adds one up except the percentage.
 */

/** Citizens checked over all citizens, as a whole percent; 0 when there are none, never above 100. */
export function coveragePercent(checked: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((checked / total) * 100));
}

/** The words a CSV's header and its rows need, from the page's language. */
export interface ArrearsReportCsvText {
  header: {
    year: string;
    fee: string;
    billedCount: string;
    billed: string;
    collected: string;
    cancelled: string;
    writtenOff: string;
    owed: string;
    waitingCount: string;
    waiting: string;
  };
  feeName: (feeType: ArrearsFeeType) => string;
}

/**
 * The by-year-and-fee table as a CSV, one row per year × fee type. Sums only, so
 * it carries no citizen. Cells go through `csvCell`, which guards a formula
 * (`=`, `+`, `-`, `@`) a fee's description could start with when Excel opens it.
 */
export function arrearsReportCsv(report: ArrearsReport, text: ArrearsReportCsvText): string {
  const { header } = text;
  return buildCsv(
    [
      header.year,
      header.fee,
      header.billedCount,
      header.billed,
      header.collected,
      header.cancelled,
      header.writtenOff,
      header.owed,
      header.waitingCount,
      header.waiting,
    ],
    report.rows.map((row) => [
      row.year,
      text.feeName(row.feeType),
      row.billedCount,
      row.billed,
      row.collected,
      row.cancelled,
      row.writtenOff,
      row.owed,
      row.waitingCount,
      row.waiting,
    ]),
  );
}

/** `arrears-report-2026-11-21.csv`: the municipal day it was taken. */
export function arrearsReportFilename(): string {
  return `arrears-report-${municipalToday()}.csv`;
}
