/**
 * What an inspector is paid for: one dollar per distinct unit he filed.
 *
 * Two screens used to answer this question with two copies of the same loop —
 * `getInspectorProfile` for one inspector's page and `listStaff` for the
 * roster — and a rule that lives in two places is a rule that will disagree
 * with itself. It lives here now, and both call it.
 *
 * == What counts ========================================================
 *
 * A unit row (`building_units`) that is still standing:
 *
 *  - its own `endedAt` is null. An ended tenancy is work that was undone;
 *    billing it again pays twice for one flat.
 *  - its property entry's `endedAt` is null, for the same reason one level up.
 *  - it is not a structural floor. «طابق أعمدة» and «طابق فارغ» draw a level of
 *    the building; nobody holds them and nobody can be registered against them.
 *    Migrations 0052 and 0054 already keep them out of `buildings.unitsTotal`,
 *    and a payment that counted them would contradict the census on the next
 *    screen over.
 *  - no other row has already been credited for the same physical unit.
 *
 * == Why the deduplication is by census unit, and what it costs ==========
 *
 * A flat whose owner lives elsewhere and whose tenant lives in it carries two
 * records — the owner's file and the occupant's file — pointing at one
 * `units` row. Those are two interviews and one flat, so whether they are one
 * dollar or two is a policy question, not a counting one. This module answers
 * "one", because the rate is written per unit.
 *
 * `unitId` is nullable: a record can describe a flat the census never
 * registered. Those cannot be compared to anything, so each counts as its own
 * unit under a key that cannot collide with a real one. It is the one
 * over-count this rule cannot resolve from the data, and it is deliberate —
 * refusing to pay for them would be worse.
 *
 * == What does not count =================================================
 *
 * Land parcels, tents, and buildings with no units recorded. They are property
 * entries with no unit row, and the rate is per unit. They are still work, and
 * still appear in the surveyed-work breakdown on the profile page; they earn
 * nothing.
 */

import { isStructuralUnitType } from './enums';

/** Dollars per distinct unit. */
export const COMMISSION_RATE = 1.0;

/** The columns of a unit row this rule reads. */
export type EarningsUnit = {
  id: string;
  unitId: string | null;
  unitType: string | null;
  endedAt: Date | string | null;
};

/** The columns of a property entry this rule reads. */
export type EarningsPropertyEntry = {
  endedAt: Date | string | null;
  units: readonly EarningsUnit[];
};

/**
 * Credits every unit in `entries` that `seen` has not already been credited
 * for, adding each one's key to `seen`, and returns how many this call added.
 *
 * `seen` is the caller's, and spans one inspector's whole history rather than
 * one registration: the owner's file and the tenant's file for the same flat
 * are two different registrations, so a set scoped to a registration would
 * deduplicate nothing. Feed registrations oldest first and the credit lands on
 * whoever filed first, which is the only ordering that does not change an
 * inspector's total when an unrelated record is added later.
 */
export function creditBillableUnits(
  entries: readonly EarningsPropertyEntry[],
  seen: Set<string>,
): number {
  let credited = 0;

  for (const entry of entries) {
    if (entry.endedAt != null) continue;

    for (const unit of entry.units) {
      if (unit.endedAt != null) continue;
      if (isStructuralUnitType(unit.unitType)) continue;

      // `bu:` cannot collide with a census uuid, so an unlinked record is its
      // own unit rather than merging with every other unlinked one.
      const key = unit.unitId ?? `bu:${unit.id}`;
      if (seen.has(key)) continue;

      seen.add(key);
      credited += 1;
    }
  }

  return credited;
}
