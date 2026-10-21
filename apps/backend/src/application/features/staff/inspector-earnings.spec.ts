import { cardsCreditedTo, COMMISSION_RATE, creditBillableUnits, filedByOf } from '@mechanization/shared-schemas';

/*
  What an inspector is paid for: one dollar per distinct unit he filed.

  Each case here is a way the old figure — `units.length` for a building,
  otherwise 1 — paid for something that was not a unit somebody filled. On
  production on 2026-09-22 they together inflated the bill from $430 to $505
  across six accounts.

  The ones that keep earning matter just as much. Only `RECORDED_IN_ERROR`
  withdraws credit; a tenancy that ended because the tenant moved out, or a
  flat that changed hands, was still surveyed and is still paid.
*/

const unit = (over: Partial<Parameters<typeof creditBillableUnits>[0][number]['units'][number]> = {}) => ({
  id: 'bu-1',
  unitId: 'census-1',
  unitType: 'APARTMENT',
  endReason: null,
  ...over,
});

const entry = (units: ReturnType<typeof unit>[], endReason: string | null = null) => ({
  endReason,
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

  it('does not pay for a unit recorded in error', () => {
    const seen = new Set<string>();
    const credited = creditBillableUnits(
      [
        entry([
          unit({ id: 'a', unitId: 'c1' }),
          unit({ id: 'b', unitId: 'c2', endReason: 'RECORDED_IN_ERROR' }),
        ]),
      ],
      seen,
    );
    expect(credited).toBe(1);
  });

  it('does not pay for units on a property entry recorded in error', () => {
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([unit()], 'RECORDED_IN_ERROR')], seen)).toBe(0);
    expect(seen.size).toBe(0);
  });

  it('keeps paying for a tenancy that genuinely ended', () => {
    // The officer interviewed the household. What the household did afterwards
    // is not something his pay should depend on.
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([unit({ endReason: 'MOVED_OUT' })])], seen)).toBe(1);
  });

  it('keeps paying after an ownership transfer', () => {
    const seen = new Set<string>();
    expect(
      creditBillableUnits([entry([unit({ endReason: 'OWNERSHIP_TRANSFERRED' })])], seen),
    ).toBe(1);
  });

  it('keeps paying for a row ended with no reason given', () => {
    const seen = new Set<string>();
    expect(creditBillableUnits([entry([unit({ endReason: null })])], seen)).toBe(1);
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

/*
  Who is paid for a line: the officer who filed it (0096), not the officer who
  registered the citizen.

  The case that found it (production, 2026-10-06): officer J registered a doctor
  as the tenant of a clinic. Officer H later visited the doctor's own building
  and recorded him as owner of a flat and a warehouse there. Both lines went
  onto J's registration — the doctor's file — and before 0096 both dollars went
  to J, who had never been to that building.
*/
describe('cardsCreditedTo', () => {
  const J = 'officer-j';
  const H = 'officer-h';
  const line = (id: string, unitId: string, filedById: string | null = null) =>
    unit({ id, unitId, filedById });
  const card = (id: string, units: ReturnType<typeof unit>[], filedRegistrationId: string | null = null) => ({
    id,
    endReason: null,
    filedRegistrationId,
    units,
  });
  type Registration = {
    id: string;
    createdById: string | null;
    properties: ReturnType<typeof card>[];
    movedCards?: ReturnType<typeof card>[];
  };
  const paid = (officerId: string, registrations: Registration[]) => {
    const seen = new Set<string>();
    for (const registration of registrations) creditBillableUnits(cardsCreditedTo(officerId, registration), seen);
    return seen.size * COMMISSION_RATE;
  };

  const doctorsFile = {
    id: 'reg-doctor',
    createdById: J,
    properties: [
      card('clinic', [line('clinic-line', 'clinic-0105')]),
      card('own-building', [line('flat-line', 'flat-0101', H), line('warehouse-line', 'warehouse-0001', H)]),
    ],
  };

  it('pays the officer who added a line to a file, not the officer who registered it', () => {
    expect(paid(H, [doctorsFile])).toBe(2);
    expect(paid(J, [doctorsFile])).toBe(1);
  });

  it('reads a line with no filer as the registration officer’s, as every line was before 0096', () => {
    expect(filedByOf({ filedById: null }, J)).toBe(J);
    expect(filedByOf({}, J)).toBe(J);
    expect(filedByOf({ filedById: H }, J)).toBe(H);
  });

  it('does not change anything when the registration’s own officer is named as the filer', () => {
    const explicit = { ...doctorsFile, properties: [card('clinic', [line('clinic-line', 'clinic-0105', J)])] };
    const implicit = { ...doctorsFile, properties: [card('clinic', [line('clinic-line', 'clinic-0105')])] };
    expect(paid(J, [explicit])).toBe(paid(J, [implicit]));
  });

  it('still pays an officer once for a flat he filed on two files', () => {
    // H registered the tenant of flat 0101 himself, then recorded its owner on J's file.
    const tenantsFile = { id: 'reg-tenant', createdById: H, properties: [card('tenancy', [line('t', 'flat-0101')])] };
    expect(paid(H, [tenantsFile, doctorsFile])).toBe(2);
  });

  it('credits a card a merge moved to the registration it was filed on, and a filed line to its filer', () => {
    const moved = card('moved', [line('kept', 'flat-a'), line('added', 'flat-b', H)], 'reg-old');
    const survivor = { id: 'reg-new', createdById: 'officer-k', properties: [moved] };
    const old = { id: 'reg-old', createdById: J, properties: [], movedCards: [moved] };
    expect(paid('officer-k', [survivor, old])).toBe(0);
    expect(paid(J, [survivor, old])).toBe(1);
    expect(paid(H, [survivor, old])).toBe(1);
  });
});
