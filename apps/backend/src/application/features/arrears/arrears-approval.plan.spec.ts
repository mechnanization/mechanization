import { feeAssessmentSchema } from '@mechanization/shared-schemas';
import {
  approvalProblems,
  arrearsAssessment,
  arrearsBillTitle,
  arrearsDueDate,
  type StoredArrearsLine,
} from './arrears-approval.plan';

const line = (over: Partial<StoredArrearsLine> = {}): StoredArrearsLine => ({
  id: 'l1',
  citizenId: 'c1',
  propertyNumber: '420',
  unitCode: null,
  year: 2023,
  feeType: 'RENTAL_VALUE',
  feeTypeNote: null,
  component: 'PRINCIPAL',
  amount: 100_000,
  dueDate: null,
  decision: 'KEEP',
  ...over,
});
const ctx = { today: '2026-11-21', cutoffYear: 2026 as number | null, mergedAway: new Set<string>() };

describe('approvalProblems', () => {
  it('finds nothing wrong with a kept line that still passes', () => {
    expect(approvalProblems([line()], ctx)).toEqual([]);
  });

  it('asks again about the cutoff: unset, or moved down to the line’s year', () => {
    expect(approvalProblems([line()], { ...ctx, cutoffYear: null })).toEqual([{ lineId: 'l1', issue: 'CUTOFF_NOT_SET' }]);
    expect(approvalProblems([line({ year: 2023 })], { ...ctx, cutoffYear: 2023 })).toEqual([
      { lineId: 'l1', issue: 'YEAR_NOT_BEFORE_CUTOFF' },
    ]);
    expect(approvalProblems([line({ year: 2022 })], { ...ctx, cutoffYear: 2023 })).toEqual([]);
  });

  it('asks again about prescription: a debt stands through 31 December of its year + 5', () => {
    expect(approvalProblems([line({ year: 2021 })], { ...ctx, today: '2026-12-31' })).toEqual([]);
    expect(approvalProblems([line({ year: 2021 })], { ...ctx, today: '2027-01-01' })).toEqual([
      { lineId: 'l1', issue: 'PRESCRIBED_SINCE_IMPORT' },
    ]);
  });

  it('refuses a citizen folded into another file since the import', () => {
    expect(approvalProblems([line()], { ...ctx, mergedAway: new Set(['c1']) })).toEqual([
      { lineId: 'l1', issue: 'CITIZEN_MERGED_AWAY' },
    ]);
  });

  it('lists every problem of every line, not the first', () => {
    const problems = approvalProblems(
      [line({ id: 'a', year: 2019 }), line({ id: 'b', citizenId: 'c2' })],
      { ...ctx, mergedAway: new Set(['c2']) },
    );
    expect(problems).toEqual([
      { lineId: 'a', issue: 'PRESCRIBED_SINCE_IMPORT' },
      { lineId: 'b', issue: 'CITIZEN_MERGED_AWAY' },
    ]);
  });

  it('leaves a dropped line and a line waiting for a file alone: neither becomes a bill now', () => {
    const problems = approvalProblems(
      [line({ id: 'd', decision: 'DROP', year: 2010 }), line({ id: 'w', citizenId: null, year: 2010 })],
      { ...ctx, mergedAway: new Set(['c1']) },
    );
    expect(problems).toEqual([]);
  });
});

describe('the bill a line becomes', () => {
  it('is titled by its year and fee, and a penalty says so', () => {
    expect(arrearsBillTitle(line())).toBe('متأخرات 2023 — رسم القيمة التأجيرية');
    expect(arrearsBillTitle(line({ component: 'PENALTY' }))).toBe('متأخرات 2023 — رسم القيمة التأجيرية — غرامة');
  });

  it('names an «رسم آخر» by what the books called it', () => {
    expect(arrearsBillTitle(line({ feeType: 'OTHER', feeTypeNote: 'رسم المياه' }))).toBe('متأخرات 2023 — رسم المياه');
  });

  it('is due on its own date, else on the last day of its year, at midnight UTC', () => {
    expect(arrearsDueDate(line()).toISOString()).toBe('2023-12-31T00:00:00.000Z');
    expect(arrearsDueDate(line({ dueDate: '2023-06-15' })).toISOString()).toBe('2023-06-15T00:00:00.000Z');
  });

  it('carries a one-line FLAT assessment the contract reads, on its رقم العقار and unit', () => {
    const assessment = arrearsAssessment(line({ propertyNumber: '420', unitCode: 'B1-0003' }));
    expect(feeAssessmentSchema.safeParse(assessment).success).toBe(true);
    expect(assessment.basis).toBe('FLAT');
    expect(assessment.lines).toEqual([
      { propertyNumber: '420', propertyType: 'ARREARS', unitType: null, unitArea: null, unitCode: 'B1-0003' },
    ]);
  });

  it('has no unit id on its line, so it is never read as this period’s billing of a unit (D8)', () => {
    const [only] = arrearsAssessment(line({ unitCode: 'B1-0003' })).lines;
    expect(only).not.toHaveProperty('unitId');
  });
});
