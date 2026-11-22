import { describe, expect, it } from 'vitest';
import type { ArrearsReport } from '@mechanization/shared-schemas';
import { arrearsReportCsv, arrearsReportFilename, coveragePercent } from './arrears-report';

const report = (rows: ArrearsReport['rows']): ArrearsReport => ({
  cutoffYear: 2026,
  rows,
  years: [],
  coverage: { checked: 0, total: 0 },
  collections: [],
  batches: [],
  totals: { billedCount: 0, billed: 0, collected: 0, cancelled: 0, writtenOff: 0, owed: 0, waitingCount: 0, waiting: 0 },
});

const text = {
  header: {
    year: 'السنة',
    fee: 'الرسم',
    billedCount: 'عدد الفواتير',
    billed: 'المفوتر',
    collected: 'المحصّل',
    cancelled: 'الملغى',
    writtenOff: 'المشطوب',
    owed: 'المتبقي',
    waitingCount: 'عدد بانتظار المطابقة',
    waiting: 'بانتظار المطابقة',
  },
  feeName: (feeType: string) => (feeType === 'CLEANING' ? 'رسم النظافة' : feeType),
};

const row = (over: Partial<ArrearsReport['rows'][number]> = {}): ArrearsReport['rows'][number] => ({
  year: 2023,
  feeType: 'CLEANING',
  billedCount: 2,
  billed: 750_000,
  collected: 500_000,
  cancelled: 50_000,
  writtenOff: 0,
  owed: 200_000,
  waitingCount: 1,
  waiting: 80_000,
  ...over,
});

describe('coveragePercent', () => {
  it('rounds to a whole percent', () => {
    expect(coveragePercent(1, 3)).toBe(33);
    expect(coveragePercent(2, 3)).toBe(67);
    expect(coveragePercent(5, 5)).toBe(100);
  });

  it('is 0 with no citizens, and never above 100', () => {
    expect(coveragePercent(0, 0)).toBe(0);
    expect(coveragePercent(3, 0)).toBe(0);
    expect(coveragePercent(7, 5)).toBe(100);
  });
});

describe('arrearsReportCsv', () => {
  it('writes the header then one line per year × fee, in the order the server gave', () => {
    const lines = arrearsReportCsv(report([row(), row({ year: 2024, feeType: 'OTHER' })]), text).trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('السنة');
    expect(lines[1]).toContain('2023');
    expect(lines[1]).toContain('رسم النظافة');
    expect(lines[1]).toContain('750000');
    expect(lines[2]).toContain('2024');
  });

  it('carries no person: only the sums', () => {
    const csv = arrearsReportCsv(report([row()]), text);
    expect(csv).not.toMatch(/citizen|name|phone/i);
  });

  it('guards a fee name that Excel would read as a formula', () => {
    const csv = arrearsReportCsv(report([row({ feeType: 'OTHER' })]), { ...text, feeName: () => '=HYPERLINK("http://x")' });
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    expect(csv).toContain("'=HYPERLINK");
  });
});

describe('arrearsReportFilename', () => {
  it('is dated by the municipal day', () => {
    expect(arrearsReportFilename()).toMatch(/^arrears-report-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
