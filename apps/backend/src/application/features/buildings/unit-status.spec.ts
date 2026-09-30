import { feeBearerClass, settleUnitStatus, type UnitStatusFacts } from '@mechanization/shared-schemas';

/**
 * The one rule for «حالة الوحدة» (`settleUnitStatus`), on plain data.
 *
 * Each case is a shape production held on 2026-09-30, or the guard against
 * the obvious wrong fix for one. The database half — that every door calls the
 * rule and keeps the unit's «تعارض» case in step — is in
 * `unit-status.integration.spec.ts`.
 */

const facts = (over: Partial<UnitStatusFacts> = {}): UnitStatusFacts => ({
  current: null,
  standingVacancy: false,
  liveRoles: [],
  ownerStatements: [],
  ...over,
});

describe('settleUnitStatus — who is recorded decides', () => {
  it('makes a flat with a registered tenant «مؤجرة», whatever it said before', () => {
    // Z-5-257-A/0201: «موسمي» set on the matrix, a tenant filed four minutes later,
    // and the owner billed beside the tenant because the fill was empty-only.
    for (const current of ['SEASONAL', 'OWNER_OCCUPIED', 'UNDER_CONSTRUCTION', null]) {
      expect(settleUnitStatus(facts({ current, liveRoles: ['OWNER', 'TENANT'] }))).toEqual({
        status: 'RENTED',
        conflicts: [],
      });
    }
  });

  it('makes a flat lent to somebody «مشغولة بتسامح», and a tenant beside them still «مؤجرة»', () => {
    expect(settleUnitStatus(facts({ liveRoles: ['FREE_OCCUPANT'] })).status).toBe('FREE_OCCUPIED');
    expect(settleUnitStatus(facts({ liveRoles: ['FREE_OCCUPANT', 'TENANT'] })).status).toBe('RENTED');
  });

  it('lets a standing vacancy say «شاغرة», and flags anyone recorded inside it', () => {
    expect(settleUnitStatus(facts({ current: 'VACANT', standingVacancy: true }))).toEqual({
      status: 'VACANT',
      conflicts: [],
    });
    // A1-412-A/0101 held a standing vacancy over a null unit; the rule writes «شاغرة».
    expect(settleUnitStatus(facts({ current: null, standingVacancy: true })).status).toBe('VACANT');
    expect(
      settleUnitStatus(facts({ current: 'VACANT', standingVacancy: true, liveRoles: ['TENANT'] })).conflicts,
    ).toEqual([{ kind: 'VACANCY_WITH_OCCUPANT' }]);
  });

  it('keeps what a person last said when only owners are recorded', () => {
    // A deed is not residence (D2): an owner spell settles nothing on its own.
    for (const current of ['OWNER_OCCUPIED', 'SEASONAL', 'UNDER_CONSTRUCTION', 'VACANT', null]) {
      expect(settleUnitStatus(facts({ current, liveRoles: ['OWNER'] })).status).toBe(current);
    }
  });
});

describe('settleUnitStatus — what it puts to a person', () => {
  it('flags «مؤجرة» with no tenant registered — the owner exempt and nobody billed', () => {
    // 23 flats in production on 2026-09-30, e.g. A1-411-B/0102.
    expect(settleUnitStatus(facts({ current: 'RENTED', liveRoles: ['OWNER'] }))).toEqual({
      status: 'RENTED',
      conflicts: [{ kind: 'LET_WITHOUT_OCCUPANT', status: 'RENTED' }],
    });
    expect(settleUnitStatus(facts({ current: 'FREE_OCCUPIED' })).conflicts).toEqual([
      { kind: 'LET_WITHOUT_OCCUPANT', status: 'FREE_OCCUPIED' },
    ]);
  });

  it('flags an owner’s card that disagrees with the unit about who pays', () => {
    // X-78-A/0001: the card «مشغولة من المالك», the unit «شاغرة».
    expect(
      settleUnitStatus(facts({ current: 'VACANT', ownerStatements: ['OWNER_OCCUPIED'] })).conflicts,
    ).toEqual([{ kind: 'OWNER_STATEMENT_DIFFERS', stated: 'OWNER_OCCUPIED', status: 'VACANT' }]);
    // A card saying the owner lives in a flat a tenant is registered in.
    expect(
      settleUnitStatus(facts({ liveRoles: ['TENANT'], ownerStatements: ['OWNER_OCCUPIED'] })).conflicts,
    ).toEqual([{ kind: 'OWNER_STATEMENT_DIFFERS', stated: 'OWNER_OCCUPIED', status: 'RENTED' }]);
  });

  it('does not flag a difference that does not change who pays', () => {
    // «مؤجرة» against «مشغولة بتسامح»: somebody else bears it either way.
    expect(
      settleUnitStatus(facts({ liveRoles: ['TENANT'], ownerStatements: ['FREE_OCCUPIED'] })).conflicts,
    ).toEqual([]);
    // «موسمي» against «مشغولة من المالك»: the owner bears it either way.
    expect(
      settleUnitStatus(facts({ current: 'SEASONAL', ownerStatements: ['OWNER_OCCUPIED'] })).conflicts,
    ).toEqual([]);
    // «قيد الإنجاز» against «شاغرة»: nobody bears it either way.
    expect(
      settleUnitStatus(facts({ current: 'VACANT', standingVacancy: true, ownerStatements: ['UNDER_CONSTRUCTION'] }))
        .conflicts,
    ).toEqual([]);
  });

  it('does not flag an owner’s statement against a unit nobody has answered for', () => {
    // The card is then the only statement: billing reads it, and the sync carries it on.
    expect(settleUnitStatus(facts({ current: null, ownerStatements: ['VACANT'] })).conflicts).toEqual([]);
  });

  it('never treats a card that states nothing as a statement', () => {
    expect(settleUnitStatus(facts({ current: 'VACANT', ownerStatements: [null, null] })).conflicts).toEqual([]);
  });

  it('reports each differing statement once, however many co-owners filed it', () => {
    expect(
      settleUnitStatus(facts({ current: 'VACANT', ownerStatements: ['OWNER_OCCUPIED', 'OWNER_OCCUPIED'] }))
        .conflicts,
    ).toHaveLength(1);
  });
});

describe('feeBearerClass', () => {
  it('sorts every status into who bears the occupancy fee', () => {
    expect(feeBearerClass('OWNER_OCCUPIED')).toBe('OWNER');
    expect(feeBearerClass('SEASONAL')).toBe('OWNER');
    expect(feeBearerClass('RENTED')).toBe('OTHERS');
    expect(feeBearerClass('FREE_OCCUPIED')).toBe('OTHERS');
    expect(feeBearerClass('VACANT')).toBe('NOBODY');
    expect(feeBearerClass('UNDER_CONSTRUCTION')).toBe('NOBODY');
    expect(feeBearerClass(null)).toBeNull();
  });
});
