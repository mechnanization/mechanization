import { assertNonResidentOccupancy } from './buildings.service';

/**
 * The unit matrix's half of the non-resident rule.
 *
 * The registration schema refuses a «غير مقيم في البلدة» record renting a شقة;
 * without this, «إضافة شخص إلى الوحدة» on the matrix would record exactly that,
 * and `claimOnFile` would then mint the card the form had refused. Both doors
 * have to say the same thing.
 */
const base = { unitCode: '0102', residence: 'NON_RESIDENT_OWNER' };

describe('assertNonResidentOccupancy', () => {
  it('lets a non-resident rent or occupy what nobody lives in', () => {
    for (const unitType of ['SHOP', 'OFFICE', 'CLINIC', 'WAREHOUSE']) {
      for (const role of ['TENANT', 'FREE_OCCUPANT', 'OWNER']) {
        expect(() => assertNonResidentOccupancy({ ...base, role, unitType })).not.toThrow();
      }
    }
  });

  it('refuses a non-resident as tenant or free occupant of a dwelling', () => {
    for (const unitType of ['APARTMENT', 'INDEPENDENT_HOUSE']) {
      for (const role of ['TENANT', 'FREE_OCCUPANT']) {
        expect(() => assertNonResidentOccupancy({ ...base, role, unitType })).toThrow('مسكن');
      }
    }
  });

  it('lets a non-resident own a dwelling, but not say they live in it', () => {
    expect(() =>
      assertNonResidentOccupancy({ ...base, role: 'OWNER', unitType: 'APARTMENT', unitStatus: 'SEASONAL' }),
    ).not.toThrow();
    expect(() =>
      assertNonResidentOccupancy({
        ...base,
        role: 'OWNER',
        unitType: 'APARTMENT',
        unitStatus: 'OWNER_OCCUPIED',
      }),
    ).toThrow('مسكن موسمي');
  });

  it('asks nothing of a household file', () => {
    expect(() =>
      assertNonResidentOccupancy({
        ...base,
        residence: 'RESIDENT',
        role: 'TENANT',
        unitType: 'APARTMENT',
        unitStatus: 'OWNER_OCCUPIED',
      }),
    ).not.toThrow();
  });
});
