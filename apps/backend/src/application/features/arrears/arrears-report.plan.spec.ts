import { arrearsReportBalances } from '@mechanization/shared-schemas';
import { assembleArrearsReport, batchSheetCode, type RawReportRow, type RawYearRow } from './arrears-report.plan';

const row = (over: Partial<RawReportRow> = {}): RawReportRow => ({
  year: 2023,
  feeType: 'CLEANING',
  billedCount: 2,
  billed: '1000000.00',
  collected: '400000.00',
  cancelled: '100000.00',
  writtenOff: '200000.00',
  owed: '300000.00',
  waitingCount: 0,
  waiting: '0.00',
  ...over,
});

const year = (over: Partial<RawYearRow> = {}): RawYearRow => ({ year: 2023, imported: '1000000.00', prescribed: '0.00', dropped: '0.00', ...over });

const base = {
  cutoffYear: 2026,
  rows: [] as RawReportRow[],
  years: [] as RawYearRow[],
  controlTotals: [] as Array<{ year: number; amount: number }>,
  coverage: { checked: 0, total: 0 },
  collections: [],
  batches: [],
  approvedBatchCount: 0,
};

describe('assembleArrearsReport', () => {
  it('keeps every pound of a bill in exactly one of four places', () => {
    const report = assembleArrearsReport({ ...base, rows: [row()] });
    expect(arrearsReportBalances(report.rows[0]!)).toBe(true);
    expect(arrearsReportBalances(report.totals)).toBe(true);
  });

  it('orders by year, then fee type in the contract’s order, a code it does not know last', () => {
    const report = assembleArrearsReport({
      ...base,
      rows: [
        row({ year: 2024, feeType: 'CLEANING' }),
        row({ year: 2022, feeType: 'OTHER' }),
        row({ year: 2022, feeType: 'RENTAL_VALUE' }),
        row({ year: 2022, feeType: 'FIRE_SERVICE' }),
        row({ year: 2022, feeType: 'CLEANING' }),
      ],
    });
    expect(report.rows.map((entry) => `${entry.year}-${entry.feeType}`)).toEqual([
      '2022-RENTAL_VALUE',
      '2022-CLEANING',
      '2022-OTHER',
      '2022-FIRE_SERVICE',
      '2024-CLEANING',
    ]);
  });

  it('sums the totals in cents, so a long column does not drift', () => {
    const tenth = row({ billed: '0.10', collected: '0.10', cancelled: '0', writtenOff: '0', owed: '0', billedCount: 1 });
    const report = assembleArrearsReport({ ...base, rows: Array.from({ length: 3 }, (_, index) => ({ ...tenth, feeType: ['CLEANING', 'RENTAL_VALUE', 'OTHER'][index]! })) });
    // 0.1 + 0.1 + 0.1 is 0.30000000000000004 in floating point.
    expect(report.totals.billed).toBe(0.3);
    expect(report.totals.billedCount).toBe(3);
  });

  it('counts lines still waiting for a file apart from the bills', () => {
    const report = assembleArrearsReport({ ...base, rows: [row({ waitingCount: 2, waiting: '75000.00' })] });
    expect(report.rows[0]).toMatchObject({ waitingCount: 2, waiting: 75_000, billed: 1_000_000 });
    expect(report.totals).toMatchObject({ waitingCount: 2, waiting: 75_000 });
  });
});

describe('the old books’ totals', () => {
  it('shows what is left to import against each year’s total', () => {
    const report = assembleArrearsReport({
      ...base,
      years: [year({ year: 2022, imported: '600000.00' }), year({ year: 2023, imported: '1000000.00' })],
      controlTotals: [
        { year: 2022, amount: 2_000_000 },
        { year: 2023, amount: 1_000_000 },
      ],
    });
    expect(report.years).toEqual([
      { year: 2022, imported: 600_000, prescribed: 0, dropped: 0, controlTotal: 2_000_000, remainingToImport: 1_400_000 },
      { year: 2023, imported: 1_000_000, prescribed: 0, dropped: 0, controlTotal: 1_000_000, remainingToImport: 0 },
    ]);
  });

  it('lists a year the books give a total for even when nothing of it is imported', () => {
    const report = assembleArrearsReport({ ...base, controlTotals: [{ year: 2019, amount: 500_000 }] });
    expect(report.years).toEqual([
      { year: 2019, imported: 0, prescribed: 0, dropped: 0, controlTotal: 500_000, remainingToImport: 500_000 },
    ]);
  });

  it('says nothing is left, never a negative, when more was imported than the books hold', () => {
    const report = assembleArrearsReport({
      ...base,
      years: [year({ imported: '1200000.00' })],
      controlTotals: [{ year: 2023, amount: 1_000_000 }],
    });
    expect(report.years[0]).toMatchObject({ imported: 1_200_000, remainingToImport: 0 });
  });

  it('has no remaining figure at all while no total is entered (open-decisions §23.4)', () => {
    const report = assembleArrearsReport({ ...base, years: [year()] });
    expect(report.years[0]).toMatchObject({ controlTotal: null, remainingToImport: null });
  });

  it('counts prescribed lines apart from the other drops', () => {
    const report = assembleArrearsReport({ ...base, years: [year({ prescribed: '90000.00', dropped: '10000.00' })] });
    expect(report.years[0]).toMatchObject({ prescribed: 90_000, dropped: 10_000 });
  });
});

describe('collections', () => {
  it('keeps the old debts’ collections apart from every other bill’s, by year and currency', () => {
    const report = assembleArrearsReport({
      ...base,
      collections: [
        { year: 2027, currency: 'LBP', arrears: '50000.00', other: '900000.00' },
        { year: 2026, currency: 'USD', arrears: '0.00', other: '40.00' },
        { year: 2026, currency: 'LBP', arrears: '25000.50', other: '100000.00' },
      ],
    });
    expect(report.collections).toEqual([
      { year: 2026, currency: 'LBP', arrears: 25_000.5, other: 100_000 },
      { year: 2026, currency: 'USD', arrears: 0, other: 40 },
      { year: 2027, currency: 'LBP', arrears: 50_000, other: 900_000 },
    ]);
  });
});

describe('batchSheetCode', () => {
  it('names a batch by the first eight characters of its id, upper case, as a batch has no number of its own', () => {
    expect(batchSheetCode('3f2a9c10-7b4e-4d55-9a31-0c1d2e3f4a5b')).toBe('3F2A9C10');
  });
});
