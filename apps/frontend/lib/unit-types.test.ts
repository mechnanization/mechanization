import { describe, expect, it } from 'vitest';
import { getLabels, type UnitTypeView } from '@mechanization/shared-schemas';
import { chosenType, figuresByType, optionValueOf, unitTypeLabel, unitTypeOptions } from './unit-types';

const labels = getLabels('ar').unitType;
const en = getLabels('en').unitType;

const type = (row: Partial<UnitTypeView> & Pick<UnitTypeView, 'id' | 'nameAr' | 'baseType'>): UnitTypeView => ({
  nameEn: null,
  figureKey: null,
  isSystem: false,
  isActive: true,
  sortOrder: 100,
  unitCount: 0,
  ...row,
});

const SHOP = type({ id: 'sys-shop', nameAr: 'محل تجاري', nameEn: 'Commercial Shop', baseType: 'SHOP', isSystem: true, sortOrder: 50 });
const FLAT = type({ id: 'sys-flat', nameAr: 'شقة', baseType: 'APARTMENT', isSystem: true, sortOrder: 10 });
const HOUSE = type({ id: 'sys-house', nameAr: 'منزل مستقل', baseType: 'INDEPENDENT_HOUSE', isSystem: true, sortOrder: 20 });
const SCHOOL = type({ id: 'school', nameAr: 'مدرسة', nameEn: 'School', baseType: 'OFFICE' });
const WATER = type({ id: 'water', nameAr: 'شركة مياه', baseType: 'OFFICE', isActive: false });
const TYPES = [SCHOOL, SHOP, WATER, HOUSE, FLAT];

const offered = (extra: Partial<Parameters<typeof unitTypeOptions>[0]> = {}) =>
  unitTypeOptions({
    types: TYPES,
    locale: 'ar',
    unitTypeLabels: labels,
    fallback: ['APARTMENT', 'SHOP'],
    ...extra,
  });

describe('the options a unit-type picker offers', () => {
  it('lists the active types, system first and then by order, each carrying its id and its base', () => {
    expect(offered().map((option) => [option.label, option.unitType, option.unitTypeId])).toEqual([
      ['شقة', 'APARTMENT', 'sys-flat'],
      ['منزل مستقل', 'INDEPENDENT_HOUSE', 'sys-house'],
      ['محل تجاري', 'SHOP', 'sys-shop'],
      ['مدرسة', 'OFFICE', 'school'],
    ]);
  });

  it('leaves a type switched off out, unless the unit being edited already has it', () => {
    expect(offered().some((option) => option.value === 'water')).toBe(false);
    expect(offered({ current: { unitTypeId: 'water' } }).some((option) => option.value === 'water')).toBe(true);
  });

  it('takes out the bases a host does not offer, and names a type in the page’s language', () => {
    expect(offered({ omitBases: ['INDEPENDENT_HOUSE'] }).some((option) => option.unitType === 'INDEPENDENT_HOUSE')).toBe(false);
    expect(offered({ locale: 'en', unitTypeLabels: en }).map((option) => option.label)).toContain('School');
    // No English name: the Arabic one.
    expect(offered({ locale: 'en', unitTypeLabels: en }).map((option) => option.label)).toContain('شقة');
  });

  it('appends the floor types last, with no id, when the host draws them', () => {
    const options = offered({ withStructural: true });
    expect(options.slice(-2).map((option) => [option.value, option.unitTypeId])).toEqual([
      ['PILOTIS', undefined],
      ['EMPTY_FLOOR', undefined],
    ]);
    expect(offered().some((option) => option.value === 'PILOTIS')).toBe(false);
  });

  it('falls back to the base types alone, with no ids, while the list is not there', () => {
    const options = offered({ types: [], withStructural: true });
    expect(options.map((option) => [option.value, option.unitTypeId])).toEqual([
      ['APARTMENT', undefined],
      ['SHOP', undefined],
      ['PILOTIS', undefined],
      ['EMPTY_FLOOR', undefined],
    ]);
  });
});

describe('what a picker holds and sends', () => {
  const options = offered({ withStructural: true });

  it('sits a unit on its own type, or on its base’s system type when it has none', () => {
    expect(optionValueOf({ unitType: 'OFFICE', unitTypeId: 'school' }, options)).toBe('school');
    expect(optionValueOf({ unitType: 'SHOP', unitTypeId: null }, options)).toBe('sys-shop');
    // A type the list no longer carries: the base's first option.
    expect(optionValueOf({ unitType: 'SHOP', unitTypeId: 'gone' }, options)).toBe('sys-shop');
    expect(optionValueOf({ unitType: 'PILOTIS' }, options)).toBe('PILOTIS');
  });

  it('sends the chosen type’s base with its id, and a floor type with none', () => {
    expect(chosenType('school', options)).toEqual({ unitType: 'OFFICE', unitTypeId: 'school' });
    expect(chosenType('PILOTIS', options)).toEqual({ unitType: 'PILOTIS' });
    expect(chosenType('nope', options)).toBeNull();
  });
});

describe('a unit’s type name', () => {
  it('is its type’s name when the list carries it, even a switched-off one, else its base’s label', () => {
    expect(unitTypeLabel(TYPES, { unitType: 'OFFICE', unitTypeId: 'water' }, 'ar', labels)).toBe('شركة مياه');
    expect(unitTypeLabel(TYPES, { unitType: 'OFFICE', unitTypeId: 'school' }, 'en', en)).toBe('School');
    expect(unitTypeLabel(TYPES, { unitType: 'CLINIC', unitTypeId: null }, 'ar', labels)).toBe(labels.CLINIC);
    expect(unitTypeLabel([], { unitType: 'OFFICE', unitTypeId: 'school' }, 'ar', labels)).toBe(labels.OFFICE);
  });
});

describe('the drawing of a unit type', () => {
  it('is read off the types that have one, and a base-only type is left out', () => {
    const figures = figuresByType([
      type({ id: 'mosque', nameAr: 'مسجد', baseType: 'OFFICE', figureKey: 'MOSQUE' }),
      type({ id: 'pharmacy', nameAr: 'صيدلية', baseType: 'SHOP', figureKey: 'PHARMACY' }),
      type({ id: 'plain', nameAr: 'جمعية', baseType: 'OFFICE' }),
      SHOP,
    ]);
    expect([...figures.entries()]).toEqual([
      ['mosque', 'MOSQUE'],
      ['pharmacy', 'PHARMACY'],
    ]);
  });

  it('ignores a key a newer build stored, so its units fall back to the base front', () => {
    expect(figuresByType([type({ id: 'future', nameAr: 'نوع جديد', baseType: 'OFFICE', figureKey: 'HOLOGRAM' })]).size).toBe(0);
  });
});
