import { describe, expect, it } from 'vitest';
import { getLabels, type BillArrearsView } from '@mechanization/shared-schemas';
import { arrearsFeeName, groupArrearsByYear, isArrearsBill, isArrearsPenalty, splitArrears } from './arrears-bill';

const line = (over: Partial<BillArrearsView> = {}): BillArrearsView => ({
  year: 2023,
  feeType: 'CLEANING',
  feeTypeNote: null,
  component: 'PRINCIPAL',
  propertyNumber: '1234',
  unitCode: null,
  oldReference: null,
  ...over,
});

describe('isArrearsBill', () => {
  it('trusts the server’s line and nothing else', () => {
    expect(isArrearsBill({ arrears: line() })).toBe(true);
    expect(isArrearsBill({ arrears: null })).toBe(false);
    // An older API sends no field at all: an «INV-» bill is never taken for an old debt.
    expect(isArrearsBill({})).toBe(false);
  });
});

describe('arrearsFeeName', () => {
  it('words a known fee in the page’s language', () => {
    expect(arrearsFeeName(line(), getLabels('ar'))).toBe('رسم النظافة');
    expect(arrearsFeeName(line(), getLabels('en'))).toBe('Cleaning fee');
  });

  it('says what «رسم آخر» was, when the accountant wrote it', () => {
    const other = line({ feeType: 'OTHER', feeTypeNote: ' رسم إشغال الرصيف ' });
    expect(arrearsFeeName(other, getLabels('ar'))).toBe('رسم إشغال الرصيف');
  });

  it('falls back to the label of «رسم آخر» when the note is blank, and to the code when it is unknown', () => {
    expect(arrearsFeeName(line({ feeType: 'OTHER', feeTypeNote: '  ' }), getLabels('ar'))).toBe('رسم آخر');
    expect(arrearsFeeName(line({ feeType: 'FIRE_SERVICE' as never }), getLabels('ar'))).toBe('FIRE_SERVICE');
  });
});

describe('isArrearsPenalty', () => {
  it('marks a penalty line only', () => {
    expect(isArrearsPenalty(line({ component: 'PENALTY' }))).toBe(true);
    expect(isArrearsPenalty(line())).toBe(false);
  });
});

describe('splitArrears', () => {
  it('separates old debts from current bills and keeps each list’s order', () => {
    const bills = [
      { id: 'a', arrears: null },
      { id: 'b', arrears: line() },
      { id: 'c' },
      { id: 'd', arrears: line({ year: 2021 }) },
    ];
    const { current, arrears } = splitArrears(bills);
    expect(current.map((bill) => bill.id)).toEqual(['a', 'c']);
    expect(arrears.map((bill) => bill.id)).toEqual(['b', 'd']);
  });

  it('puts every bill in `current` when none is an old debt', () => {
    const { current, arrears } = splitArrears([{ id: 'a' }, { id: 'b', arrears: null }]);
    expect(current).toHaveLength(2);
    expect(arrears).toEqual([]);
  });
});

describe('groupArrearsByYear', () => {
  it('groups by the debt’s year, the oldest first, the order a settlement pays', () => {
    const groups = groupArrearsByYear([
      { id: 'a', arrears: line({ year: 2024 }) },
      { id: 'b', arrears: line({ year: 2021 }) },
      { id: 'c', arrears: line({ year: 2024, component: 'PENALTY' }) },
    ]);
    expect(groups.map((group) => group.year)).toEqual([2021, 2024]);
    // A principal and its penalty stay in the order the server listed them.
    expect(groups[1]?.bills.map((bill) => bill.id)).toEqual(['a', 'c']);
  });

  it('leaves out a bill that is not an old debt', () => {
    expect(groupArrearsByYear([{ id: 'a', arrears: null }, { id: 'b' }])).toEqual([]);
  });
});
