import {
  canSpanLevels,
  floorsOfUnit,
  layoutBuildingFloors,
  levelFactorsSchema,
  levelSpanLimits,
  levelSpanOverlap,
  readLevelFactors,
  roofWeight,
  unitLevelsLabel,
  unitTopFloor,
  updateUnitSchema,
} from '@mechanization/shared-schemas';
import { unitsOutsideFloors } from './buildings.service';
import { withHouseFieldsOnRow } from '../citizens/card-flags';

/*
  One home on several levels (migration 0095, decision D28): the rules in
  shared-schemas that the matrix draws by, the server refuses by, and billing
  weighs by.
*/

type U = { id: string; floor: number; levels?: number; startCol: number | null; endCol: number | null };
const unit = (id: string, floor: number, startCol: number | null = null, endCol = startCol, levels = 1): U => ({
  id,
  floor,
  levels,
  startCol,
  endCol,
});
const drawn = (layouts: ReturnType<typeof layoutBuildingFloors<U>>, floor: number) =>
  (layouts.get(floor)?.blocks ?? []).map((block) => [
    block.unit.id,
    block.startCol,
    block.endCol,
    block.continuation ? 'up' : 'own',
  ]);

describe('layoutBuildingFloors', () => {
  it('draws a duplex’s upper level in the same columns on the floor above', () => {
    const duplex = unit('0001', 0, 2, 3, 2);
    const layouts = layoutBuildingFloors([duplex, unit('0002', 0, 1, 1)]);
    expect(drawn(layouts, 0)).toEqual([
      ['0002', 1, 1, 'own'],
      ['0001', 2, 3, 'own'],
    ]);
    expect(drawn(layouts, 1)).toEqual([['0001', 2, 3, 'up']]);
  });

  it('places an unpositioned unit above after the level rising through its floor, never on it', () => {
    const duplex = unit('0001', 0, null, null, 2);
    const layouts = layoutBuildingFloors([duplex, unit('0101', 1)]);
    expect(drawn(layouts, 1)).toEqual([
      ['0001', 1, 1, 'up'],
      ['0101', 2, 2, 'own'],
    ]);
  });

  it('carries a triplex through two floors, and a floor with only an upper level still exists', () => {
    const layouts = layoutBuildingFloors([unit('0001', 0, 1, 2, 3)]);
    expect([...layouts.keys()]).toEqual([0, 1, 2]);
    expect(drawn(layouts, 2)).toEqual([['0001', 1, 2, 'up']]);
  });

  it('draws a one-level building exactly as the floor-by-floor layout did', () => {
    const layouts = layoutBuildingFloors([unit('0001', 0, 1, 2), unit('0101', 1), unit('0102', 1, 4, 4)]);
    expect(drawn(layouts, 0)).toEqual([['0001', 1, 2, 'own']]);
    expect(drawn(layouts, 1)).toEqual([
      ['0102', 4, 4, 'own'],
      ['0101', 5, 5, 'own'],
    ]);
  });
});

describe('levelSpanOverlap and levelSpanLimits', () => {
  it('finds a flat drawn on the floor a duplex rises into', () => {
    const duplex = unit('0001', 0, 1, 2, 2);
    const above = unit('0101', 1, 2, 3);
    const layouts = layoutBuildingFloors([duplex, above]);
    expect(levelSpanOverlap(layouts, duplex, { startCol: 1, endCol: 2 })?.unit.id).toBe('0101');
  });

  it('asks about floors a unit does not reach yet, when told to', () => {
    const flat = unit('0001', 0, 1, 1);
    const above = unit('0101', 1, 1, 1);
    const layouts = layoutBuildingFloors([flat, above]);
    expect(levelSpanOverlap(layouts, flat, { startCol: 1, endCol: 1 })).toBeNull();
    expect(levelSpanOverlap(layouts, flat, { startCol: 1, endCol: 1 }, [0, 1])?.unit.id).toBe('0101');
  });

  it('lets a duplex widen only as far as both of its floors allow', () => {
    const duplex = unit('0001', 0, 2, 2, 2);
    const layouts = layoutBuildingFloors([duplex, unit('0003', 0, 6, 6), unit('0101', 1, 4, 4)]);
    expect(levelSpanLimits(layouts, duplex)).toEqual({ minStart: 1, maxEnd: 3 });
  });
});

describe('the level rules', () => {
  it('lets only a dwelling span levels', () => {
    expect(canSpanLevels('APARTMENT')).toBe(true);
    expect(canSpanLevels('INDEPENDENT_HOUSE')).toBe(true);
    expect(canSpanLevels('SHOP')).toBe(false);
    expect(canSpanLevels('PILOTIS')).toBe(false);
  });

  it('knows which floors a unit occupies', () => {
    expect(floorsOfUnit({ floor: 1, levels: 3 })).toEqual([1, 2, 3]);
    expect(unitTopFloor({ floor: 1, levels: 3 })).toBe(3);
    expect(unitTopFloor({ floor: 1, levels: null })).toBe(1);
  });

  it('weighs a flat by the table, a house by its storeys, and refuses an unpriced flat', () => {
    expect(roofWeight({ unitType: 'APARTMENT', levels: 1 }, {})).toBe(1);
    expect(roofWeight({ unitType: 'APARTMENT', levels: 2 }, { '2': 1.8 })).toBe(1.8);
    expect(roofWeight({ unitType: 'APARTMENT', levels: 3 }, { '2': 1.8 })).toBeNull();
    expect(roofWeight({ unitType: 'INDEPENDENT_HOUSE', levels: 2 }, {})).toBe(2);
  });

  it('accepts only a discount in the factor table — between one roof and N', () => {
    expect(levelFactorsSchema.safeParse({ '2': 1.8, '3': 2.6 }).success).toBe(true);
    expect(levelFactorsSchema.safeParse({ '2': 2.2 }).success).toBe(false);
    expect(levelFactorsSchema.safeParse({ '2': 0.9 }).success).toBe(false);
    expect(levelFactorsSchema.safeParse({ '1': 1 }).success).toBe(false);
    expect(levelFactorsSchema.safeParse({ '7': 6 }).success).toBe(false);
  });

  it('reads a stored table, dropping what the schema would refuse', () => {
    expect(readLevelFactors({ '2': 1.8, '3': 9, x: 1 })).toEqual({ '2': 1.8 });
    expect(readLevelFactors(null)).toEqual({});
    expect(readLevelFactors([1.8])).toEqual({});
  });

  it('names a duplex and a triplex, and says nothing for one level', () => {
    expect(unitLevelsLabel(1, 'ar')).toBeNull();
    expect(unitLevelsLabel(2, 'ar')).toBe('دوبلكس');
    expect(unitLevelsLabel(3, 'en')).toBe('Triplex');
    expect(unitLevelsLabel(4, 'ar')).toBe('4 طوابق');
  });

  it('accepts «عدد طوابق المسكن» on a unit edit, within bounds', () => {
    expect(updateUnitSchema.safeParse({ levels: 2 }).success).toBe(true);
    expect(updateUnitSchema.safeParse({ levels: 0 }).success).toBe(false);
    expect(updateUnitSchema.safeParse({ levels: 7 }).success).toBe(false);
  });
});

describe('unitsOutsideFloors', () => {
  it('counts a duplex’s upper level against the building’s floors', () => {
    const duplex = { floor: 1, levels: 2 };
    expect(unitsOutsideFloors([duplex], 2, 0)).toEqual([duplex]);
    expect(unitsOutsideFloors([duplex], 3, 0)).toEqual([]);
  });
});

describe('withHouseFieldsOnRow', () => {
  it('moves a «غير مؤكَّد» area onto the row a «منزل» card becomes, and leaves the rest', () => {
    const flags = [
      { path: 'properties.1.unitArea', status: 'UNKNOWN' },
      { path: 'properties.1.neighborhood', status: 'UNKNOWN' },
      { path: 'properties.0.unitArea', status: 'UNKNOWN' },
      { path: 'personal.motherName', status: 'UNKNOWN' },
    ];
    const moved = withHouseFieldsOnRow(flags, 1);
    expect(moved.changed).toBe(true);
    expect(moved.flags.map((flag) => flag.path)).toEqual([
      'properties.1.units.0.unitArea',
      'properties.1.neighborhood',
      'properties.0.unitArea',
      'personal.motherName',
    ]);
  });

  it('changes nothing when the card carries no such flag', () => {
    expect(withHouseFieldsOnRow([{ path: 'properties.0.neighborhood' }], 0).changed).toBe(false);
  });
});
