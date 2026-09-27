import { COMMISSION_RATE, creditBillableUnits } from '@mechanization/shared-schemas';

/*
  What an inspector is paid for: one dollar per distinct unit he filed.

  Each case here is a way the old figure — `units.length` for a building,
  otherwise 1 — paid for something that was not a unit somebody filled. On
  production on 2026-09-22 those four together inflated the bill from $430 to
  $505 across six accounts.
*/

const unit = (over: Partial<Parameters<typeof creditBillableUnits>[0][number]['units'][number]> = {}) => ({
  id: 'bu-1',
  unitId: 'census-1',
  unitType: 'APARTMENT',
  endedAt: null,
  ...over,
});

const entry = (units: ReturnType<typeof unit>[], endedAt: Date | string | null = null) => ({
  endedAt,
  units,
});

describe('creditBillableUnits', () => {
  it('counts one dollar per live unit', () => {
    const seen = new Set<string>();
    const credited = creditBillableUnits(
      [entry([unit({ id: 'a', unitId: 'c1' }), unit({ id: 'b', unitId: 'c2' })])],
      seen,
    );
    expect(credited).toBe(2);
    expect(seen.size).toBe(2);
    expect(credited * COMMISSION_RATE).toBe(2);
  });

  it('does not pay for a unit whose tenancy ended', () => {
    const seen = new Set<string>();
    const credited = creditBillableUnits(
      [entry([unit({ id: 'a', unitId: 'c1' }), unit({ id: 'b', unitId: 'c2', endedAt: new Date() })])],
      seen,
    );
    expect(credited).toBe(1);
  });

  it('does not pay for units on a property entry that ended', () => {
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([unit()], new Date())], seen)).toBe(0);
    expect(seen.size).toBe(0);
  });

  it('does not pay for structural floors', () => {
    // 0052 and 0054 keep «طابق أعمدة» and «طابق فارغ» out of the census's own
    // unit counts; a payment that included them would contradict that screen.
    const seen = new Set<string>();
    const credited = creditBillableUnits(
      [
        entry([
          unit({ id: 'a', unitId: 'c1', unitType: 'PILOTIS' }),
          unit({ id: 'b', unitId: 'c2', unitType: 'EMPTY_FLOOR' }),
          unit({ id: 'c', unitId: 'c3', unitType: 'APARTMENT' }),
        ]),
      ],
      seen,
    );
    expect(credited).toBe(1);
  });

  it('pays once for a flat that carries both an owner file and a tenant file', () => {
    // The commonest case on production: two registrations, two interviews, one
    // census unit. 36 flats were like this, and the old figure paid for 72.
    const seen = new Set<string>();
    const owner = creditBillableUnits([entry([unit({ id: 'owner-row', unitId: 'flat-7' })])], seen);
    const tenant = creditBillableUnits([entry([unit({ id: 'tenant-row', unitId: 'flat-7' })])], seen);

    expect(owner).toBe(1);
    expect(tenant).toBe(0);
    expect(seen.size).toBe(1);
  });

  it('credits the flat to whoever filed first', () => {
    const seen = new Set<string>();
    const first = creditBillableUnits([entry([unit({ id: 'first', unitId: 'flat-7' })])], seen);
    const second = creditBillableUnits([entry([unit({ id: 'second', unitId: 'flat-7' })])], seen);
    expect([first, second]).toEqual([1, 0]);
  });

  it('treats a record with no census link as its own unit', () => {
    // Two unlinked rows are two different flats as far as anything here can
    // tell. Merging them on a shared null would refuse to pay for real work.
    const seen = new Set<string>();
    const credited = creditBillableUnits(
      [entry([unit({ id: 'a', unitId: null }), unit({ id: 'b', unitId: null })])],
      seen,
    );
    expect(credited).toBe(2);
  });

  it('pays nothing for a property entry with no units — land, a tent, an empty building', () => {
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([])], seen)).toBe(0);
  });

  it('is unaffected by an unknown unit type, which stays occupiable', () => {
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([unit({ unitType: 'SOMETHING_NEW' })])], seen)).toBe(1);
  });
});
