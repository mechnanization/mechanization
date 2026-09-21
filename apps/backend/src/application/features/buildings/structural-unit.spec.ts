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
