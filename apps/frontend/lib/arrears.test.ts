import { describe, expect, it } from 'vitest';
import type { ArrearsImportResult, ArrearsLineVerdict } from '@mechanization/shared-schemas';
import { dropsOf, lineKey, needsDecision, reconciles, undecidedLines, writeBlocker, type LineDecision } from './arrears';
import { buildArrearsTemplate, parseArrearsCsv } from './csv';

const line = (over: Partial<ArrearsLineVerdict> = {}): ArrearsLineVerdict => ({
  row: 1,
  rowKey: 1,
  name: 'علي خليل',
  propertyNumber: '1024',
  unitCode: null,
  year: 2023,
  feeType: 'RENTAL_VALUE',
  component: 'PRINCIPAL',
  amount: 100_000,
  status: 'KEEP',
  issues: [],
  dropReason: null,
  flags: {},
  ...over,
});

const result = (lines: ArrearsLineVerdict[], over: Partial<ArrearsImportResult> = {}): ArrearsImportResult => ({
  batchId: 'b',
  dryRun: true,
  cutoffYear: 2026,
  oldestKeptYear: 2021,
  lines,
  totals: {
    kept: { count: 0, amount: 0 },
    dropped: { count: 0, amount: 0 },
    prescribed: { count: 0, amount: 0 },
    unmatched: { count: 0, amount: 0 },
    refused: { count: lines.filter((entry) => entry.status === 'REFUSED').length },
    fileTotal: 0,
    controlTotal: null,
  },
  coverage: { citizens: 1, withLines: 1, checkedNothingOwed: 0, notInFile: 0 },
  written: null,
  ...over,
});

describe('needsDecision', () => {
  it('asks about a war-damaged unit, an archived file and a person not on the register', () => {
    expect(needsDecision(line({ flags: { war: { level: 'DESTROYED', habitable: false, assessedAt: '2025-01-01' } } }))).toBe(true);
    expect(needsDecision(line({ flags: { archived: true } }))).toBe(true);
    expect(needsDecision(line({ status: 'UNMATCHED', rowKey: null }))).toBe(true);
  });

  it('asks nothing of a plain line, a prescribed one or a refused one', () => {
    expect(needsDecision(line())).toBe(false);
    expect(needsDecision(line({ status: 'DROP', flags: { prescribed: true, archived: true } }))).toBe(false);
    expect(needsDecision(line({ status: 'REFUSED', issues: ['AMOUNT_INVALID'], flags: { archived: true } }))).toBe(false);
  });
});

describe('decisions', () => {
  const flagged = line({ row: 4, flags: { archived: true } });
  const penalty = line({ row: 4, component: 'PENALTY', flags: { archived: true } });

  it('keys a row’s principal and its penalty apart', () => {
    expect(lineKey(flagged)).not.toBe(lineKey(penalty));
  });

  it('counts a flagged line undecided until it is kept, or dropped with a reason', () => {
    const decisions = new Map<string, LineDecision>();
    expect(undecidedLines([flagged], decisions)).toHaveLength(1);
    decisions.set(lineKey(flagged), { choice: 'DROP', reason: 'ab' });
    expect(undecidedLines([flagged], decisions)).toHaveLength(1);
    decisions.set(lineKey(flagged), { choice: 'DROP', reason: 'الوحدة مدمّرة' });
    expect(undecidedLines([flagged], decisions)).toHaveLength(0);
    decisions.set(lineKey(flagged), { choice: 'KEEP' });
    expect(undecidedLines([flagged], decisions)).toHaveLength(0);
  });

  it('sends only the drops with a reason, trimmed, by row and component', () => {
    const decisions = new Map<string, LineDecision>([
      [lineKey(flagged), { choice: 'DROP', reason: '  الوحدة مدمّرة  ' }],
      [lineKey(penalty), { choice: 'KEEP' }],
    ]);
    expect(dropsOf([flagged, penalty], decisions)).toEqual([{ row: 4, component: 'PRINCIPAL', reason: 'الوحدة مدمّرة' }]);
  });
});

describe('writeBlocker', () => {
  it('holds the save while the cutoff is unset, a line is refused, or a flagged line is undecided', () => {
    expect(writeBlocker(result([line()], { cutoffYear: null }), new Map())).toBe('CUTOFF_NOT_SET');
    expect(writeBlocker(result([line({ status: 'REFUSED', issues: ['YEAR_INVALID'] })]), new Map())).toBe('REFUSED_ROWS');
    expect(writeBlocker(result([line({ flags: { archived: true } })]), new Map())).toBe('UNDECIDED');
    expect(writeBlocker(result([]), new Map())).toBe('NOTHING');
    expect(writeBlocker(result([line()]), new Map())).toBeNull();
  });
});

describe('reconciles', () => {
  it('holds the file’s sum to the pages’ total to the cent', () => {
    expect(reconciles(1_250_000.5, 1_250_000.5)).toBe(true);
    expect(reconciles(0.1 + 0.2, 0.3)).toBe(true);
    expect(reconciles(1_250_000, 1_249_999.99)).toBe(false);
    expect(reconciles(1_250_000, null)).toBe(false);
  });
});

describe('the arrears template', () => {
  it('writes the export’s rows under the template headers, with a BOM, and reads them back', () => {
    const csv = buildArrearsTemplate([
      { rowKey: 1, fullName: 'علي خليل', propertyNumber: '1024', unitCode: 'B1-3' },
      { rowKey: 2, fullName: '=HYPERLINK("x")', propertyNumber: null, unitCode: null },
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    // A name cannot run a formula in Excel.
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    const parsed = parseArrearsCsv(csv);
    expect(parsed.missingColumns).toEqual([]);
    expect(parsed.unknownHeaders).toEqual([]);
    expect(parsed.rows[0]).toEqual({ rowKey: '1', fullName: 'علي خليل', propertyNumber: '1024', unitCode: 'B1-3' });
  });

  it('reads Excel’s semicolons, keeps a blank row in the middle so rows keep their numbers, and drops trailing ones', () => {
    const text = '﻿رقم السطر;الاسم الكامل;رقم العقار;السنة;نوع الرسم;الأصل (ل.ل)\r\n1;علي;1024;2023;رسم النظافة;100000\r\n;;;;;\r\n2;سامي;1024;;;\r\n;;;;;\r\n';
    const parsed = parseArrearsCsv(text);
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.rows[1]).toEqual({});
    expect(parsed.rows[2]).toEqual({ rowKey: '2', fullName: 'سامي', propertyNumber: '1024' });
  });

  it('names the required columns a file lacks', () => {
    expect(parseArrearsCsv('الاسم الكامل,رقم العقار\nعلي,1024\n').missingColumns).toEqual([
      'رقم السطر',
      'السنة',
      'نوع الرسم',
      'الأصل (ل.ل)',
    ]);
  });
});
