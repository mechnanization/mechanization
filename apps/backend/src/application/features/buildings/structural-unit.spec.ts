import {
  BUILDING_UNIT_FIELDS,
  FEE_TARGET_CATEGORY,
  STRUCTURAL_UNIT_TYPE,
  UNIT_STATUS,
  UNIT_TYPE,
  buildingUnitSchema,
  isDwellingUnitType,
  isStructuralUnitType,
  getLabels,
} from '@mechanization/shared-schemas';
import { assertOccupiableUnit } from './buildings.service';
import {
  billableUnits,
  type BillablePropertyEntry,
} from '../../../domain/entities/billable-unit';

/**
 * «طابق أعمدة» — the one unit type nobody can be registered against.
 *
 * The value earns its place in `UnitType` for a single reason: the matrix is a
 * drawing of the structure, and a block drawn without its column floor has
 * every storey above it off by one. Everything else about it is a subtraction,
 * and each subtraction is a door somebody could otherwise walk through. These
 * are the doors.
 */
describe('structural unit types', () => {
  it('names the floor types and nothing that describes premises', () => {
    expect([...STRUCTURAL_UNIT_TYPE]).toEqual(['PILOTIS', 'EMPTY_FLOOR']);

    for (const type of ['APARTMENT', 'INDEPENDENT_HOUSE', 'CLINIC', 'OFFICE', 'SHOP', 'WAREHOUSE', 'GARAGE']) {
      expect(isStructuralUnitType(type)).toBe(false);
    }
  });

  /*
    «طابق فارغ» is a unit *type* and not `UnitStatus.VACANT`, and the two are one
    Arabic letter apart. شاغرة says a flat exists and is empty — billable,
    exemptible, counted. This says there is no flat. Asserted because the day
    somebody "simplifies" this into a status is the day the census starts
    counting floors that hold nothing as units.
  */
  it('keeps the empty floor out of the unit-status vocabulary', () => {
    expect((UNIT_STATUS as readonly string[]).includes('EMPTY_FLOOR')).toBe(false);
    expect((STRUCTURAL_UNIT_TYPE as readonly string[]).includes('VACANT')).toBe(false);
  });

  /*
    An unknown value reads as occupiable. Stated as a test because the opposite
    default is the tempting one and it is wrong: a guard that refuses everything
    it does not recognise would start refusing the *next* unit type the day it
    is added and before anything teaches it otherwise.
  */
  it('treats an unknown or absent type as occupiable', () => {
    expect(isStructuralUnitType(null)).toBe(false);
    expect(isStructuralUnitType(undefined)).toBe(false);
    expect(isStructuralUnitType('PENTHOUSE')).toBe(false);
  });

  it('is not a dwelling, and is not the complement of one either', () => {
    expect(isDwellingUnitType('PILOTIS')).toBe(false);
    // A محل is neither — the two predicates are independent, not opposites.
    expect(isDwellingUnitType('SHOP')).toBe(false);
    expect(isStructuralUnitType('SHOP')).toBe(false);
  });
});

describe('assertOccupiableUnit', () => {
  it('refuses an occupant on either kind of structural floor', () => {
    expect(() => assertOccupiableUnit({ unitType: 'PILOTIS', unitCode: '0001' })).toThrow(
      'طابق أعمدة',
    );
    expect(() => assertOccupiableUnit({ unitType: 'EMPTY_FLOOR', unitCode: '0401' })).toThrow(
      'طابق فارغ',
    );
  });

  /*
    The message names the type the officer actually chose. Telling someone who
    marked a floor «فارغ» that it is a «طابق أعمدة» is the kind of wrongness
    that makes the rest of the sentence not worth reading.
  */
  it('names the type the officer chose, not the first structural one', () => {
    expect(() => assertOccupiableUnit({ unitType: 'EMPTY_FLOOR', unitCode: '0401' })).not.toThrow(
      /طابق أعمدة/,
    );
  });

  /*
    The message has to name the way out, not only the refusal. An officer who
    reaches this has nearly always tapped a structural block on a grid where it
    sits directly beside the flat they wanted — «الأخرى» rather than «فوقها»,
    because a طابق فارغ is as often above the flats as below them.
  */
  it('names the unit and tells the officer what to do instead', () => {
    for (const unitType of STRUCTURAL_UNIT_TYPE) {
      expect(() => assertOccupiableUnit({ unitType, unitCode: '0001' })).toThrow(/0001/);
      expect(() => assertOccupiableUnit({ unitType, unitCode: '0001' })).toThrow(
        /الطوابق الأخرى/,
      );
    }
  });

  it('lets every other unit type through', () => {
    for (const unitType of UNIT_TYPE.filter((type) => !isStructuralUnitType(type))) {
      expect(() => assertOccupiableUnit({ unitType, unitCode: '0102' })).not.toThrow();
    }
  });
});

describe('a citizen card can never name one', () => {
  const card = {
    unitType: 'APARTMENT',
    floor: '3',
    unitArea: '120',
    sharedRights: [],
  };

  it('accepts an ordinary flat', () => {
    expect(buildingUnitSchema.safeParse(card).success).toBe(true);
  });

  /*
    The form's list never carried the value, so this refusal is not about the
    form. It is about the doors that do not read that list: the CSV import, an
    offline queue replaying a submission an older client built, and anything
    posting to the API directly.
  */
  it.each(STRUCTURAL_UNIT_TYPE)('refuses a card line typed as %s', (unitType) => {
    const result = buildingUnitSchema.safeParse({ ...card, unitType });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['unitType']);
      expect(result.error.issues[0]?.message).toContain('مصفوفة المبنى');
    }
  });

  /* `BUILDING_UNIT_FIELDS` is what the card's unit editor renders; the type
     being in it is what makes the refusal above reachable rather than moot. */
  it('still renders the type field on a card', () => {
    expect([...BUILDING_UNIT_FIELDS]).toContain('unitType');
  });
});

describe('no fee can be aimed at one', () => {
  /*
    0042 established that `FEE_TARGET_CATEGORY` and `UNIT_TYPE` "have to move
    together", because `matchesCategory` compares a category against
    `unit.unitType` directly. The invariant is narrower than it reads, and this
    is the test that says so: every *occupiable* unit type appears there, and a
    structural one must not — a fee aimed at «طوابق الأعمدة» would match every
    pilotis in town and find nobody to bill.
  */
  it('carries every occupiable unit type and no structural one', () => {
    for (const type of UNIT_TYPE) {
      expect((FEE_TARGET_CATEGORY as readonly string[]).includes(type)).toBe(
        !isStructuralUnitType(type),
      );
    }
  });
});

describe('labels', () => {
  it('names the floor rather than the material, in both locales', () => {
    expect(getLabels('ar').unitType.PILOTIS).toBe('طابق أعمدة');
    expect(getLabels('en').unitType.PILOTIS).toContain('Pilotis');
  });

  /*
    «(بلا وحدات)» is load-bearing, not decoration. Without it «طابق فارغ» sits
    one letter from «شاغرة» in a dropdown next to شقة and محل, and the officer
    with a floor of empty flats picks the wrong one.
  */
  it('spells out that an empty floor has no units', () => {
    expect(getLabels('ar').unitType.EMPTY_FLOOR).toContain('بلا وحدات');
    expect(getLabels('en').unitType.EMPTY_FLOOR).toContain('no units');
  });
});

/**
 * The third door.
 *
 * Two doors create an occupancy and both refuse a structural unit:
 * `assertOccupiableUnit` on the matrix panel, and an inline check in the census
 * sync. The invariant written into the migration prose and the service comments
 * is that *every* door refuses one.
 *
 * There is a third, and it is not an occupancy door at all: saving a citizen's
 * property card writes `building_units.unitId`, a bare uuid that no server-side
 * lookup validates against the unit it points at. The card's own `unitType` is
 * narrowed by a zod refine; the id beside it is not.
 *
 * That link is what billing reads. `preferLinked` takes the *census* unit's
 * type in preference to the card's, so a card saying APARTMENT while pointing
 * at a pilotis arrives in assessment as a pilotis — and `unitMatches` opens
 * with `if (!category) return true`, so any ALL_CITIZENS or single-citizen
 * notice charges for it.
 *
 * Keeping the structural types out of `FEE_TARGET_CATEGORY` (above) stops a fee
 * being *aimed* at one. These are what stop one being charged *for*.
 */
describe('no fee can be charged for one', () => {
  const card = (units: BillablePropertyEntry['units']): BillablePropertyEntry => ({
    propertyType: 'BUILDING',
    propertyNumber: '1553',
    occupancyType: 'OWNER',
    unitType: null,
    unitArea: null,
    units,
  });

  it('drops a structural row the card itemised directly', () => {
    const units = billableUnits(card([{ unitType: 'PILOTIS', unitArea: 200 }]));
    expect(units).toEqual([]);
  });

  it('drops it when the card says APARTMENT but the link says pilotis', () => {
    /*
      The defect, exactly. The card is well-formed — it passes the zod refine,
      because its own `unitType` is APARTMENT — and the link underneath it is
      never checked against anything.
    */
    const units = billableUnits(
      card([{ unitType: 'APARTMENT', unitArea: 120, unit: { unitType: 'PILOTIS', unitArea: 200 } }]),
    );
    expect(units).toEqual([]);
  });

  it('leaves the real flats on the same card alone', () => {
    const units = billableUnits(
      card([
        { unitType: 'APARTMENT', unitArea: 120 },
        { unitType: 'APARTMENT', unitArea: 95, unit: { unitType: 'EMPTY_FLOOR', unitArea: 300 } },
        { unitType: 'SHOP', unitArea: 40 },
      ]),
    );

    expect(units.map((unit) => unit.unitType)).toEqual(['APARTMENT', 'SHOP']);
  });

  it('drops one held through an occupancy row', () => {
    // Belt and braces: the two occupancy doors should already make this
    // unreachable, so it existing at all would mean one of them was bypassed.
    const units = billableUnits({
      ...card([]),
      occupiedUnits: [
        { role: 'OWNER', unitType: 'EMPTY_FLOOR', unitArea: 300 },
        { role: 'OWNER', unitType: 'APARTMENT', unitArea: 110 },
      ],
    });

    expect(units.map((unit) => unit.unitType)).toEqual(['APARTMENT']);
  });

  it('drops a single-unit card whose own type is structural', () => {
    const units = billableUnits({
      propertyType: 'BUILDING',
      propertyNumber: '1553',
      occupancyType: 'OWNER',
      unitType: 'PILOTIS',
      unitArea: 200,
      units: [],
    });

    expect(units).toEqual([]);
  });
});
