import {
  ARREARS_FEE_TYPE,
  type ArrearsFeeType,
  type ArrearsReport,
  type ArrearsReportBatch,
  type ArrearsReportCollection,
  type ArrearsReportCoverage,
  type ArrearsReportRow,
  type ArrearsReportYear,
} from '@mechanization/shared-schemas';

/**
 * «تقرير المتأخرات» (task 11, docs/old-debts-plan.md §8), the rules without I/O:
 * how what the database summed becomes the report. The service reads and sums in
 * SQL; this orders, joins the old books' totals on, and finds the report's own
 * totals, in cents so no sum drifts.
 */

/** A SQL sum arrives as text (`numeric::text`), so no precision is lost on the way. */
const cents = (amount: string | number): number => Math.round(Number(amount) * 100);
const pounds = (sum: number): number => sum / 100;

/** One year × fee type of kept lines, as the query returns it. */
export interface RawReportRow {
  year: number;
  feeType: string;
  billedCount: number;
  billed: string;
  collected: string;
  cancelled: string;
  writtenOff: string;
  owed: string;
  waitingCount: number;
  waiting: string;
}

/** One year of every line the approved batches hold. */
export interface RawYearRow {
  year: number;
  imported: string;
  prescribed: string;
  dropped: string;
}

export interface RawCollectionRow {
  year: number;
  currency: string;
  arrears: string;
  other: string;
}

/** The fee types in the contract's order, then any code the contract does not know yet (the column is text), by name. */
function byFeeType(a: string, b: string): number {
  const order = ARREARS_FEE_TYPE as readonly string[];
  const ia = order.indexOf(a);
  const ib = order.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
}

export function assembleArrearsReport(input: {
  cutoffYear: number | null;
  rows: readonly RawReportRow[];
  years: readonly RawYearRow[];
  controlTotals: ReadonlyArray<{ year: number; amount: number }>;
  coverage: ArrearsReportCoverage;
  collections: readonly RawCollectionRow[];
  batches: readonly ArrearsReportBatch[];
}): ArrearsReport {
  const rows: ArrearsReportRow[] = [...input.rows]
    .sort((a, b) => a.year - b.year || byFeeType(a.feeType, b.feeType))
    .map((row) => ({
      year: row.year,
      feeType: row.feeType as ArrearsFeeType,
      billedCount: row.billedCount,
      billed: pounds(cents(row.billed)),
      collected: pounds(cents(row.collected)),
      cancelled: pounds(cents(row.cancelled)),
      writtenOff: pounds(cents(row.writtenOff)),
      owed: pounds(cents(row.owed)),
      waitingCount: row.waitingCount,
      waiting: pounds(cents(row.waiting)),
    }));

  // A year the books give a total for is listed even when nothing of it is imported yet:
  // that is exactly the year with everything «remaining to import».
  const imported = new Map(input.years.map((row) => [row.year, row]));
  const control = new Map(input.controlTotals.map((row) => [row.year, cents(row.amount)]));
  const yearNumbers = [...new Set([...imported.keys(), ...control.keys()])].sort((a, b) => a - b);
  const years: ArrearsReportYear[] = yearNumbers.map((year) => {
    const read = imported.get(year);
    const importedCents = cents(read?.imported ?? 0);
    const controlCents = control.get(year);
    return {
      year,
      imported: pounds(importedCents),
      prescribed: pounds(cents(read?.prescribed ?? 0)),
      dropped: pounds(cents(read?.dropped ?? 0)),
      controlTotal: controlCents === undefined ? null : pounds(controlCents),
      // Past the books' total means the books were mis-added or a line is wrong: shown as nothing left, never negative.
      remainingToImport: controlCents === undefined ? null : pounds(Math.max(0, controlCents - importedCents)),
    };
  });

  const sum = (pick: (row: ArrearsReportRow) => number) => pounds(rows.reduce((total, row) => total + cents(pick(row)), 0));
  const totals = {
    billedCount: rows.reduce((total, row) => total + row.billedCount, 0),
    billed: sum((row) => row.billed),
    collected: sum((row) => row.collected),
    cancelled: sum((row) => row.cancelled),
    writtenOff: sum((row) => row.writtenOff),
    owed: sum((row) => row.owed),
    waitingCount: rows.reduce((total, row) => total + row.waitingCount, 0),
    waiting: sum((row) => row.waiting),
  };

  const collections: ArrearsReportCollection[] = [...input.collections]
    .sort((a, b) => a.year - b.year || a.currency.localeCompare(b.currency))
    .map((row) => ({
      year: row.year,
      currency: row.currency,
      arrears: pounds(cents(row.arrears)),
      other: pounds(cents(row.other)),
    }));

  return { cutoffYear: input.cutoffYear, rows, years, coverage: input.coverage, collections, batches: [...input.batches], totals };
}

/** The sheet's code: a batch has no number of its own, so the first eight characters of its id name it. */
export function batchSheetCode(batchId: string): string {
  return batchId.replace(/-/g, '').slice(0, 8).toUpperCase();
}
