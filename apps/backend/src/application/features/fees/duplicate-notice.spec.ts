import { sameMonth, sameTarget, unconfirmed } from './duplicate-notice';

/** The pure parts of the duplicate notice guard (finding F11); the register's half is the integration spec. */
describe('sameTarget', () => {
  it('matches everyone with everyone', () => {
    expect(sameTarget({ targetType: 'ALL_CITIZENS' }, { targetType: 'ALL_CITIZENS' })).toBe(true);
  });

  it('never matches across target types', () => {
    expect(
      sameTarget({ targetType: 'ALL_CITIZENS' }, { targetType: 'BUILDING_CATEGORY', categories: ['SHOP'] }),
    ).toBe(false);
  });

  it('matches categories that share one, since its holders are billed by both', () => {
    const shops = { targetType: 'BUILDING_CATEGORY', categories: ['SHOP', 'WAREHOUSE'] };
    expect(sameTarget(shops, { targetType: 'BUILDING_CATEGORY', categories: ['WAREHOUSE'] })).toBe(true);
    expect(sameTarget(shops, { targetType: 'BUILDING_CATEGORY', categories: ['APARTMENT'] })).toBe(false);
  });

  it('matches one named citizen only with the same one, in any case', () => {
    const id = '3f2a0000-0000-4000-8000-000000000001';
    expect(
      sameTarget(
        { targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: id },
        { targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: id.toUpperCase() },
      ),
    ).toBe(true);
    expect(
      sameTarget(
        { targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: id },
        { targetType: 'INDIVIDUAL_CITIZEN', targetCitizenId: null },
      ),
    ).toBe(false);
  });
});

describe('sameMonth', () => {
  it('reads the month in UTC, as the period keys do', () => {
    expect(sameMonth(new Date('2026-11-01T00:00:00Z'), new Date('2026-11-30T23:59:59Z'))).toBe(true);
    expect(sameMonth(new Date('2026-11-30T23:59:59Z'), new Date('2026-12-01T00:00:00Z'))).toBe(false);
    expect(sameMonth(new Date('2025-11-15T00:00:00Z'), new Date('2026-11-15T00:00:00Z'))).toBe(false);
  });
});

describe('unconfirmed', () => {
  const duplicates = [{ id: 'aaaa-1' }, { id: 'bbbb-2' }];

  it('leaves the duplicates the request did not name', () => {
    expect(unconfirmed(duplicates, ['AAAA-1'])).toEqual([{ id: 'bbbb-2' }]);
  });

  it('leaves them all when nothing was confirmed', () => {
    expect(unconfirmed(duplicates)).toEqual(duplicates);
  });
});
