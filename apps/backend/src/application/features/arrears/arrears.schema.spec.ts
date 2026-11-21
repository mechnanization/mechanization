import {
  ARREARS_HEADER_TO_KEY,
  ARREARS_TEMPLATE_COLUMNS,
  ARREARS_TEMPLATE_COLUMN_KEYS,
  arrearsCellsFromHeaders,
  arrearsSingleLineSchema,
  exportArrearsTemplateSchema,
  importArrearsSchema,
  isDocumentNumber,
  parseArrearsAmount,
  parseArrearsDueDate,
  parseArrearsFeeType,
  parseArrearsRow,
  submitArrearsBatchSchema,
  writeOffBillSchema,
  formatDocumentNumber,
  type ArrearsTemplateCells,
} from '@mechanization/shared-schemas';

/**
 * The old-debts contract in `@mechanization/shared-schemas` (task 3,
 * docs/old-debts-plan.md §5): the template's columns, the row parser both apps
 * run, and the request schemas' refinements. Each case changes one thing from a
 * row or body that passes, so a failure can only be that thing.
 */

const KEY = '3f2a1c4e-5b6d-4e7f-8a9b-0c1d2e3f4a5b';
const OTHER_KEY = '7d6c5b4a-3e2f-4a1b-9c8d-7e6f5a4b3c2d';

const row = (cells: ArrearsTemplateCells = {}): ArrearsTemplateCells => ({
  rowKey: '3',
  fullName: 'أحمد علي حسن',
  propertyNumber: '420',
  unitCode: 'A-2',
  year: '2023',
  feeType: 'RENTAL_VALUE',
  principal: '1,500,000',
  ...cells,
});

describe('the template', () => {
  it('carries no رقم مرجعي, phone, identity number, residency or citizen id', () => {
    expect([...ARREARS_TEMPLATE_COLUMN_KEYS].sort()).toEqual(
      ['dueDate', 'feeType', 'feeTypeNote', 'fullName', 'note', 'oldReference', 'penalty', 'principal', 'propertyNumber', 'rowKey', 'unitCode', 'year'],
    );
  });

  it('maps every header back to its key, and drops a header it does not know', () => {
    for (const column of ARREARS_TEMPLATE_COLUMNS) expect(ARREARS_HEADER_TO_KEY[column.header]).toBe(column.key);
    expect(arrearsCellsFromHeaders({ ' السنة ': '2023', 'رقم الهاتف': '70123456' })).toEqual({ year: '2023' });
  });
});

describe('parseArrearsRow', () => {
  it('reads a principal and a penalty as two lines, with the digits folded', () => {
    const parsed = parseArrearsRow(row({ propertyNumber: '٤٢٠', penalty: '٢٠٠٬٠٠٠', year: '٢٠٢٢' }));
    expect(parsed).toMatchObject({
      kind: 'LINES',
      rowKey: 3,
      propertyNumber: '420',
      year: 2022,
      feeType: 'RENTAL_VALUE',
      lines: [
        { component: 'PRINCIPAL', amount: 1_500_000 },
        { component: 'PENALTY', amount: 200_000 },
      ],
    });
  });

  it('reads a fee type by its Arabic label, spelled loosely', () => {
    expect(parseArrearsRow(row({ feeType: ' رسم القيمه التأجيرية ' }))).toMatchObject({ kind: 'LINES', feeType: 'RENTAL_VALUE' });
  });

  it('reads a row with no year and no amount as checked, nothing owed', () => {
    expect(parseArrearsRow(row({ year: '', principal: '', feeType: '' }))).toEqual({ kind: 'BLANK', rowKey: 3 });
  });

  it('reads a year whose amounts are zero as nothing owed', () => {
    expect(parseArrearsRow(row({ principal: '0', penalty: '0' }))).toEqual({ kind: 'BLANK', rowKey: 3 });
  });

  it.each<[string, ArrearsTemplateCells, string, string]>([
    ['a year with both amounts empty', { principal: '' }, 'principal', 'AMOUNT_REQUIRED'],
    ['an amount with no year', { year: '' }, 'year', 'YEAR_REQUIRED'],
    ['a year that is not four digits', { year: '23' }, 'year', 'YEAR_INVALID'],
    ['a year before 1900', { year: '1850' }, 'year', 'YEAR_INVALID'],
    ['an amount that is not a number', { principal: 'مليون' }, 'principal', 'AMOUNT_INVALID'],
    ['an amount with three decimals', { principal: '10.125' }, 'principal', 'AMOUNT_INVALID'],
    ['a negative amount', { principal: '-5' }, 'principal', 'AMOUNT_INVALID'],
    ['no fee type', { feeType: '' }, 'feeType', 'FEE_TYPE_REQUIRED'],
    ['a fee type the list does not hold', { feeType: 'رسم البلدية' }, 'feeType', 'FEE_TYPE_UNKNOWN'],
    ['«رسم آخر» with no description', { feeType: 'رسم آخر' }, 'feeTypeNote', 'FEE_TYPE_NOTE_REQUIRED'],
    ['no رقم العقار', { propertyNumber: ' ' }, 'propertyNumber', 'PROPERTY_NUMBER_REQUIRED'],
    ['a due date that is no day', { dueDate: '31/02/2023' }, 'dueDate', 'DUE_DATE_INVALID'],
    ['a row key that is not a number', { rowKey: 'x7' }, 'rowKey', 'ROW_KEY_INVALID'],
    ['no row key and no name', { rowKey: '', fullName: '' }, 'fullName', 'NAME_REQUIRED'],
  ])('refuses %s, naming the cell', (_label, cells, column, issue) => {
    const parsed = parseArrearsRow(row(cells));
    expect(parsed.kind).toBe('INVALID');
    expect(parsed.kind === 'INVALID' && parsed.issues).toEqual([{ column, issue }]);
  });

  it('takes «رسم آخر» with its description, and a row with a name and no key', () => {
    expect(parseArrearsRow(row({ feeType: 'OTHER', feeTypeNote: 'رسم ترخيص' }))).toMatchObject({ kind: 'LINES', feeType: 'OTHER', feeTypeNote: 'رسم ترخيص' });
    expect(parseArrearsRow(row({ rowKey: '' }))).toMatchObject({ kind: 'LINES', rowKey: null, fullName: 'أحمد علي حسن' });
  });
});

describe('the cell readers', () => {
  it('reads amounts as accountants type them', () => {
    expect(parseArrearsAmount('1 500 000')).toBe(1_500_000);
    expect(parseArrearsAmount('٣٥٠٫٥')).toBe(350.5);
    expect(parseArrearsAmount('0')).toBe(0);
    expect(parseArrearsAmount('1e6')).toBeNull();
    expect(parseArrearsAmount('1000000000000')).toBeNull();
  });

  it('reads a due date as YYYY-MM-DD or DD/MM/YYYY, and only a real day', () => {
    expect(parseArrearsDueDate('2023-3-31')).toBe('2023-03-31');
    expect(parseArrearsDueDate('٣١/١٢/٢٠٢٣')).toBe('2023-12-31');
    expect(parseArrearsDueDate('29/02/2023')).toBeNull();
    expect(parseArrearsDueDate('12/31/2023')).toBeNull();
  });

  it('reads a fee type by code or label, and nothing else', () => {
    expect(parseArrearsFeeType('cleaning')).toBe('CLEANING');
    expect(parseArrearsFeeType('رسم النظافة')).toBe('CLEANING');
    expect(parseArrearsFeeType('نظافة')).toBeNull();
  });
});

describe('the request schemas', () => {
  it('exports one zone or one building, never both or neither', () => {
    const body = { count: 50, clientRequestId: KEY };
    expect(exportArrearsTemplateSchema.safeParse({ ...body, zoneId: OTHER_KEY }).success).toBe(true);
    expect(exportArrearsTemplateSchema.safeParse({ ...body, buildingId: OTHER_KEY }).success).toBe(true);
    expect(exportArrearsTemplateSchema.safeParse(body).success).toBe(false);
    expect(exportArrearsTemplateSchema.safeParse({ ...body, zoneId: OTHER_KEY, buildingId: OTHER_KEY }).success).toBe(false);
    expect(exportArrearsTemplateSchema.safeParse({ ...body, zoneId: OTHER_KEY, count: 201 }).success).toBe(false);
  });

  it('imports rows keyed by the template, refusing an unknown column and an empty file', () => {
    expect(importArrearsSchema.parse({ rows: [row()] })).toMatchObject({ dryRun: false, startRow: 1, drops: [] });
    expect(importArrearsSchema.safeParse({ rows: [{ ...row(), phone: '70123456' }] }).success).toBe(false);
    expect(importArrearsSchema.safeParse({ rows: [] }).success).toBe(false);
  });

  it('takes a single line for a file or for a name in the books, not both, and never in dollars', () => {
    const line = { propertyNumber: '٤٢٠', year: 2023, feeType: 'CLEANING', component: 'PRINCIPAL', amount: 50_000, clientRequestId: KEY };
    expect(arrearsSingleLineSchema.parse({ ...line, citizenId: OTHER_KEY })).toMatchObject({ propertyNumber: '420', currency: 'LBP' });
    expect(arrearsSingleLineSchema.safeParse({ ...line, sourceName: 'سمير خليل' }).success).toBe(true);
    expect(arrearsSingleLineSchema.safeParse(line).success).toBe(false);
    expect(arrearsSingleLineSchema.safeParse({ ...line, citizenId: OTHER_KEY, sourceName: 'سمير' }).success).toBe(false);
    expect(arrearsSingleLineSchema.safeParse({ ...line, citizenId: OTHER_KEY, currency: 'USD' }).success).toBe(false);
    expect(arrearsSingleLineSchema.safeParse({ ...line, citizenId: OTHER_KEY, feeType: 'OTHER' }).success).toBe(false);
    expect(arrearsSingleLineSchema.safeParse({ ...line, citizenId: OTHER_KEY, amount: 0 }).success).toBe(false);
  });

  it('holds the control total and the write-off to what the database takes', () => {
    expect(submitArrearsBatchSchema.safeParse({ controlTotal: 0 }).success).toBe(true);
    expect(submitArrearsBatchSchema.safeParse({ controlTotal: -1 }).success).toBe(false);
    expect(submitArrearsBatchSchema.safeParse({ controlTotal: 10.005 }).success).toBe(false);
    const writeOff = { reason: 'عفو عام', decisionRef: 'قرار 12/2026', decisionDate: '2026-11-01' };
    expect(writeOffBillSchema.safeParse(writeOff).success).toBe(true);
    expect(writeOffBillSchema.safeParse({ ...writeOff, decisionRef: '  ' }).success).toBe(false);
    expect(writeOffBillSchema.safeParse({ ...writeOff, decisionDate: '2026-02-30' }).success).toBe(false);
  });
});

it('numbers an old-debt bill in its own «ARR-» book', () => {
  const number = formatDocumentNumber('ARREARS', '2611', 7);
  expect(number).toBe('ARR-2611-0007');
  expect(isDocumentNumber(number)).toBe(true);
  expect(isDocumentNumber('ARR-000007')).toBe(false);
});
