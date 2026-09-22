import {
  LAND_TYPE,
  OCCUPANCY_TYPE,
  PROPERTY_TYPE,
  STRUCTURAL_UNIT_TYPE,
  UNIT_STATUS,
  UNIT_TYPE,
} from '@mechanization/shared-schemas';
import { isStructuralBillableType } from './billable-unit';
import type {
  LandType,
  OccupancyType,
  PropertyType,
  UnitStatus,
  UnitType,
} from './property-entry.entity';

/**
 * The domain layer restates the register's vocabulary instead of importing it,
 * and that is a deliberate choice: nothing under `src/domain` imports anything
 * outside itself, so the entities stay readable without a package graph.
 *
 * The cost of that choice has been paid three times.
 *
 *   · `INDEPENDENT_HOUSE`, `OFFICE` and `WAREHOUSE` were added when fees became
 *     per-unit and never reached `UnitType`. It surfaced when a rate schedule
 *     tried to charge a مستودع differently from a محل.
 *   · `GARAGE`, `PILOTIS` and `EMPTY_FLOOR` went the same way.
 *   · `UnitStatus` was missing `FREE_OCCUPIED` — the value whose absence billed
 *     an owner and a شاغل بتسامح for the same flat — and `SEASONAL`.
 *
 * Every one of them was invisible to the compiler, because writes cross into
 * Prisma through `as never`. A comment saying "kept in step by hand" sat above
 * the list through all three.
 *
 * So the copies are checked rather than trusted. These tests import the shared
 * enums — which a spec may do, whatever the layer it tests — and compare them
 * to the unions, as *sets*: order is not part of the contract, membership is.
 * A new unit type added to the register now fails here, in the second it is
 * added, instead of on somebody's bill.
 *
 * A TypeScript union has no runtime value, so each list below is written out
 * `as const` and pinned to its union from both sides:
 *
 *   · `satisfies readonly UnitType[]` fails if the list names something the
 *     union does not have — a value *removed* from the union, or a typo.
 *   · `Exact<UnitType, (typeof list)[number]>` fails if the union has something
 *     the list does not — a value *added* to the union and nowhere else.
 *
 * The `as const` is load-bearing and was missing in the first version of this
 * file. Annotating the array `const list: readonly UnitType[]` instead widens
 * every element back to `UnitType`, so `(typeof list)[number]` *is* `UnitType`
 * and the comparison becomes `Exact<UnitType, UnitType>` — trivially true, for
 * any contents. That version passed with `GARAGE` deleted from the union,
 * which is the §8.7 failure exactly: a control that cannot fail for the reason
 * it exists. Do not "simplify" the `as const` away.
 *
 * Note where each half is enforced. The set comparisons below run under jest.
 * The union checks are **compile-time only** — jest transpiles without
 * typechecking, so they are enforced by `pnpm typecheck` (CI, ci.yml), not by
 * this suite passing.
 */

/** Fails to compile if `T` and `U` are not the same union. */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;

describe('domain enums do not drift from the register', () => {
  it('UnitType carries every unit type the register can store', () => {
    const domain = [
      'APARTMENT',
      'INDEPENDENT_HOUSE',
      'CLINIC',
      'OFFICE',
      'SHOP',
      'WAREHOUSE',
      'GARAGE',
      'PILOTIS',
      'EMPTY_FLOOR',
    ] as const satisfies readonly UnitType[];
    const EXHAUSTIVE: Exact<UnitType, (typeof domain)[number]> = true;

    expect(EXHAUSTIVE).toBe(true);
    expect(new Set<string>(domain)).toEqual(new Set<string>(UNIT_TYPE));
  });

  it('UnitStatus carries every unit status the register can store', () => {
    const domain = [
      'OWNER_OCCUPIED',
      'RENTED',
      'FREE_OCCUPIED',
      'SEASONAL',
      'VACANT',
      'UNDER_CONSTRUCTION',
    ] as const satisfies readonly UnitStatus[];
    const EXHAUSTIVE: Exact<UnitStatus, (typeof domain)[number]> = true;

    expect(EXHAUSTIVE).toBe(true);
    expect(new Set<string>(domain)).toEqual(new Set<string>(UNIT_STATUS));
  });

  it('OccupancyType, PropertyType and LandType match too', () => {
    const occupancy = ['OWNER', 'TENANT', 'FREE_OCCUPANT'] as const satisfies readonly OccupancyType[];
    const property = ['BUILDING', 'HOUSE', 'LAND', 'TENT'] as const satisfies readonly PropertyType[];
    const land = ['AGRICULTURAL', 'INDUSTRIAL'] as const satisfies readonly LandType[];

    const OCCUPANCY_EXHAUSTIVE: Exact<OccupancyType, (typeof occupancy)[number]> = true;
    const PROPERTY_EXHAUSTIVE: Exact<PropertyType, (typeof property)[number]> = true;
    const LAND_EXHAUSTIVE: Exact<LandType, (typeof land)[number]> = true;

    expect([OCCUPANCY_EXHAUSTIVE, PROPERTY_EXHAUSTIVE, LAND_EXHAUSTIVE]).toEqual([
      true,
      true,
      true,
    ]);
    expect(new Set<string>(occupancy)).toEqual(new Set<string>(OCCUPANCY_TYPE));
    expect(new Set<string>(property)).toEqual(new Set<string>(PROPERTY_TYPE));
    expect(new Set<string>(land)).toEqual(new Set<string>(LAND_TYPE));
  });

  /*
    `billableUnits` drops structural rows before a fee can be assessed against
    them, and it recognises them from its own set for the same import-free
    reason. That set is the one place billing decides what is not a premises,
    so it gets the same treatment as the unions above.
  */
  it('the billing filter knows exactly the structural types', () => {
    for (const type of STRUCTURAL_UNIT_TYPE) {
      expect(isStructuralBillableType(type)).toBe(true);
    }

    const occupiable = UNIT_TYPE.filter(
      (type) => !(STRUCTURAL_UNIT_TYPE as readonly string[]).includes(type),
    );
    expect(occupiable.length).toBeGreaterThan(0);
    for (const type of occupiable) {
      expect(isStructuralBillableType(type)).toBe(false);
    }
  });

  it('treats an absent type as something to bill, not something to drop', () => {
    // A unit whose type nobody recorded is still a unit. Dropping it would
    // silently under-collect, which is the failure mode the «غير مؤكَّد» flag
    // already has a documented answer for.
    expect(isStructuralBillableType(null)).toBe(false);
    expect(isStructuralBillableType(undefined)).toBe(false);
  });
});
