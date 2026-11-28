import { changedUnitFields } from './buildings.service';
import { indexUnitTypes, type UnitTypeRow } from './unit-types';

/**
 * «نوع الوحدة» (migration 0109): what a unit is filed as, decided by its type.
 * The pure half — the database-backed behaviour is in
 * `unit-types.integration.spec.ts`.
 */
const type = (row: Partial<UnitTypeRow> & Pick<UnitTypeRow, 'id' | 'baseType'>): UnitTypeRow => ({
  nameAr: row.id,
  isSystem: false,
  isActive: true,
  ...row,
});

const SHOP = type({ id: 'sys-shop', baseType: 'SHOP', isSystem: true, nameAr: 'محل تجاري' });
const OFFICE = type({ id: 'sys-office', baseType: 'OFFICE', isSystem: true, nameAr: 'مكتب' });
const SCHOOL = type({ id: 'school', baseType: 'OFFICE', nameAr: 'مدرسة' });
const OFF = type({ id: 'water', baseType: 'OFFICE', nameAr: 'شركة مياه', isActive: false });
const index = indexUnitTypes([SHOP, OFFICE, SCHOOL, OFF]);

describe('resolving a unit’s type', () => {
  it('takes the unit type from the chosen type, never from the value beside it', () => {
    expect(index.resolve({ unitTypeId: 'school', unitType: 'SHOP' }, null)).toEqual({ unitTypeId: 'school', unitType: 'OFFICE' });
    expect(index.resolve({ unitTypeId: 'school' }, null)).toEqual({ unitTypeId: 'school', unitType: 'OFFICE' });
  });

  it('refuses a type that does not exist, with its code', () => {
    expect(() => index.resolve({ unitTypeId: 'nope', unitType: 'SHOP' }, null)).toThrow(
      expect.objectContaining({ code: 'UNIT_TYPE_NOT_FOUND' }),
    );
  });

  it('refuses a switched-off type on a new unit and keeps it on a unit that has it', () => {
    expect(() => index.resolve({ unitTypeId: 'water' }, null)).toThrow(
      expect.objectContaining({ code: 'UNIT_TYPE_INACTIVE', params: { name: 'شركة مياه' } }),
    );
    // Another unit's type does not excuse it.
    expect(() => index.resolve({ unitTypeId: 'water' }, { unitTypeId: 'school', unitType: 'OFFICE' })).toThrow(
      expect.objectContaining({ code: 'UNIT_TYPE_INACTIVE' }),
    );
    expect(index.resolve({ unitTypeId: 'water' }, { unitTypeId: 'water', unitType: 'OFFICE' })).toEqual({
      unitTypeId: 'water',
      unitType: 'OFFICE',
    });
  });

  it('files a unit sent with only a unit type under that base’s system type', () => {
    expect(index.resolve({ unitType: 'SHOP' }, null)).toEqual({ unitTypeId: 'sys-shop', unitType: 'SHOP' });
    // A base with no system type in this municipality is filed with no id rather than refused.
    expect(index.resolve({ unitType: 'CLINIC' }, null)).toEqual({ unitTypeId: null, unitType: 'CLINIC' });
  });

  it('keeps a custom type when its own base is sent again, and changes it when another base is sent', () => {
    const school = { unitTypeId: 'school', unitType: 'OFFICE' as const };
    expect(index.resolve({ unitType: 'OFFICE' }, school)).toBeNull();
    expect(index.resolve({ unitType: 'SHOP' }, school)).toEqual({ unitTypeId: 'sys-shop', unitType: 'SHOP' });
  });

  it('gives a unit with no type its base’s system type on the next save, and leaves a typed one alone', () => {
    expect(index.resolve({}, { unitTypeId: null, unitType: 'OFFICE' })).toEqual({ unitTypeId: 'sys-office', unitType: 'OFFICE' });
    expect(index.resolve({}, { unitTypeId: 'school', unitType: 'OFFICE' })).toBeNull();
    expect(index.resolve({}, null)).toBeNull();
  });

  it('is a change in the audit trail when only the type moves, since the base — what billing reads — does not', () => {
    const base = { unitType: 'OFFICE', unitTypeId: 'school' };
    expect(changedUnitFields(base, { ...base, unitTypeId: 'water' })).toEqual({
      before: { unitTypeId: 'school' },
      after: { unitTypeId: 'water' },
    });
    expect(changedUnitFields(base, { ...base })).toEqual({ before: {}, after: {} });
  });

  it('gives a floor block no type, and clears the type of a unit retyped into one', () => {
    expect(index.resolve({ unitType: 'PILOTIS' }, null)).toEqual({ unitTypeId: null, unitType: 'PILOTIS' });
    expect(index.resolve({ unitType: 'PILOTIS' }, { unitTypeId: 'sys-shop', unitType: 'SHOP' })).toEqual({
      unitTypeId: null,
      unitType: 'PILOTIS',
    });
    // Already a typeless floor block: nothing to write.
    expect(index.resolve({ unitType: 'PILOTIS' }, { unitTypeId: null, unitType: 'PILOTIS' })).toBeNull();
    expect(index.resolve({}, { unitTypeId: null, unitType: 'EMPTY_FLOOR' })).toBeNull();
  });
});
