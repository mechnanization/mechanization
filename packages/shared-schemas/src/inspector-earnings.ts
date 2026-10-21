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
 *  - the row was not recorded in error. `RECORDED_IN_ERROR` is the one end
 *    reason that says the work never happened; every other ending says it did
 *    and then stopped. A tenant who moves out and an owner who sells were both
 *    interviewed, and taking the dollar back months later would make an
 *    officer's pay depend on what the people he surveyed did next. Same test on
 *    the property entry one level up.
 *  - it is not a structural floor. «طابق أعمدة» and «طابق فارغ» draw a level of
 *    the building; nobody holds them and nobody can be registered against them.
 *    Migrations 0052 and 0054 already keep them out of `buildings.unitsTotal`,
 *    and a payment that counted them would contradict the census on the next
 *    screen over.
 *  - no other row has already been credited for the same physical unit.
 *
 * Note what this deliberately does NOT test: `endedAt`. An ended row is still
 * paid, because ending is the normal end of a tenancy's life, not a retraction
 * of the visit. Only the reason decides.
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
 *
 * == Who is paid for a line ===============================================
 *
 * The officer who filed it (`filedByOf`), not the officer who registered the
 * citizen. A line carries its own filer (`building_units.filedById`, migration
 * 0096) when somebody added it to a file after the file was made — an owner
 * recorded on the matrix, an owner link, a flat added on the edit form. A line
 * without one was filed with its registration, and is credited to that
 * registration's officer.
 *
 * Until 0096 there was only the registration's officer, so every line added to
 * a file later paid whoever had registered that citizen first (user decision,
 * 2026-10-16: the officer who did the work is paid). The deduplication above is
 * unchanged and still per officer, so an officer who filed a tenant and then
 * recorded the same flat's owner is paid once for the flat.
 */

import { isStructuralUnitType } from './enums';

/** Dollars per distinct unit. */
export const COMMISSION_RATE = 1.0;

/**
 * The one end reason that withdraws an officer's credit: it says the record
 * should never have existed. `MOVED_OUT` and `OWNERSHIP_TRANSFERRED` describe
 * something that really happened and later ended, and keep earning.
 *
 * A string rather than the Prisma enum so this module stays free of the
 * generated client — the value is compared as text, exactly as migrations 0052
 * and 0054 compare unit types.
 */
export const UNEARNED_END_REASON = 'RECORDED_IN_ERROR';

/** The columns of a unit row this rule reads. */
export type EarningsUnit = {
  id: string;
  unitId: string | null;
  unitType: string | null;
  endReason: string | null;
  /** Who filed the line, when it was added after its file (0096). See `filedByOf`. */
  filedById?: string | null;
};

/** The columns of a property entry this rule reads. */
export type EarningsPropertyEntry = {
  endReason: string | null;
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
    if (entry.endReason === UNEARNED_END_REASON) continue;

    for (const unit of entry.units) {
      if (unit.endReason === UNEARNED_END_REASON) continue;
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

/**
 * The cards one registration's officer is credited for: those filed on it,
 * wherever they sit now.
 *
 * A merge (migration 0061) moves a person's current cards onto their newest
 * registration, because that is the one billing and the edit form read. The
 * dollar does not move with them (user decision, 2026-09-28): a moved card
 * carries `filedRegistrationId`, is skipped where it now sits, and is counted
 * among the `movedCards` of the registration it was filed on. A card no merge
 * has moved has no `filedRegistrationId` and counts where it is, which is every
 * card filed before the column existed.
 *
 * Both pay screens read registrations through this — a second reading of «which
 * cards did this officer file» would be a second answer to the pay question.
 */
export function cardsFiledOn<T extends { filedRegistrationId?: string | null }>(registration: {
  id: string;
  properties: readonly T[];
  movedCards?: readonly T[];
}): T[] {
  return [
    ...registration.properties.filter(
      (card) => !card.filedRegistrationId || card.filedRegistrationId === registration.id,
    ),
    ...(registration.movedCards ?? []),
  ];
}

/**
 * The officer paid for a line: the one who filed it (`building_units.filedById`,
 * migration 0096), or, for a line filed with its file, the officer of the
 * registration its card was filed on — `cardsFiledOn` decides which registration
 * that is, so pass that registration's officer.
 */
export function filedByOf(line: { filedById?: string | null }, fileOfficerId: string | null): string | null {
  return line.filedById ?? fileOfficerId;
}

/**
 * The cards filed on `registration` (`cardsFiledOn`), each keeping only the lines
 * `officerId` is paid for (`filedByOf`) — what `creditBillableUnits` is fed for
 * that officer.
 *
 * Every card comes back, with its lines filtered; one holding none of this
 * officer's lines credits nothing. A registration matters to an officer when he
 * registered it or filed a line on it, and a reader asks for both: the lines
 * other officers added to his files are theirs, and his own lines on their files
 * are his.
 */
export function cardsCreditedTo<
  C extends { filedRegistrationId?: string | null; units: ReadonlyArray<{ filedById?: string | null }> },
>(
  officerId: string,
  registration: {
    id: string;
    createdById: string | null;
    properties: readonly C[];
    movedCards?: readonly C[];
  },
): Array<Omit<C, 'units'> & { units: Array<C['units'][number]> }> {
  return cardsFiledOn(registration).map((card) => ({
    ...card,
    units: card.units.filter((line) => filedByOf(line, registration.createdById) === officerId),
  }));
}
