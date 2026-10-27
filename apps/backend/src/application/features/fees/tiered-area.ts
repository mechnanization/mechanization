import {
  matchBracket,
  unitLevels,
  type FeeAssessment,
  type FeeAssessmentLine,
  type FeeMatrixBracket,
  type FeeUnassessable,
  type FeeUnassessableReason,
} from '@mechanization/shared-schemas';
import type { BillableUnit } from '../../../domain/entities/billable-unit';

/** The unit that stopped an assessment, as the register holds it (`feeUnassessableSchema`). */
export type UnassessableUnit = NonNullable<FeeUnassessable['unit']>;

/**
 * Why one citizen cannot be assessed: the server's own sentence, for its logs,
 * and the code and unit a screen words and says what to do about.
 */
export interface Unassessable {
  kind: 'unassessable';
  reason: string;
  code: FeeUnassessableReason;
  unit?: UnassessableUnit;
}

/** Why a citizen's own bill cannot be raised, without the outcome's `kind`: what pricing hands the caller. */
export type UnassessableDetail = Omit<Unassessable, 'kind'>;

/** A unit's facts for `Unassessable.unit`: its code, parcel, type, area and level count. */
export function unassessableUnit(
  unit: Pick<BillableUnit, 'unitCode' | 'propertyNumber' | 'unitType' | 'unitArea' | 'levels'>,
): UnassessableUnit {
  return {
    unitCode: unit.unitCode ?? null,
    propertyNumber: unit.propertyNumber,
    unitType: unit.unitType,
    unitArea: unit.unitArea,
    levels: unitLevels(unit),
  };
}

/**
 * «الرسم حسب فئة المساحة» — pricing a TIERED_AREA notice, apart from the reads.
 *
 * The decisions are the product owner's, 2026-10-23
 * (docs/fees-system-rearchitecture-specification.md §1):
 *
 *  - A unit is charged the bracket its area falls in, on the scale of its own
 *    type and level count (D1, D7). The duplex and triplex brackets replace the
 *    roof factor; `levelFactors` is not read.
 *  - A unit two or more citizens are charged for is billed **once, in full**:
 *    one shared unit bill any of them may pay (D5). Never split, so deed shares
 *    and the 0075 co-owner methods play no part.
 *
 * Everything decided before the arithmetic stays where it is, in
 * `assessCitizen`: exemptions, uninhabitable flats, the review hold and the
 * bearer rule run first, unchanged, and only what they leave reaches here.
 *
 * And the review's decisions, 2026-10-26 (same document, §1):
 *
 *  - A unit the table does not price at all — a type no bracket names, a card
 *    with no unit type — is outside the notice: not charged, counted (D11).
 *  - A citizen whose own bill cannot be raised (a unit with no area, a level
 *    count the table lacks, an unsurveyed building) is still a debtor on every
 *    shared unit that can be priced: the gap is on another unit and changes
 *    nothing about this one's bracket (D10).
 *  - A period's bill stands: a unit already on a bill of the notice for the
 *    period is billed to nobody again in that period (D8).
 */

/** One unit priced by its bracket for one citizen. Not stored: the run regroups these. */
export interface TieredUnit {
  /** The census unit; null for a card-only unit, which cannot be matched across citizens. */
  unitId: string | null;
  /** OWNER, TENANT or FREE_OCCUPANT: in what capacity this citizen is charged for it. */
  role: string;
  amount: number;
  bracketCode: string;
  line: FeeAssessmentLine;
}

/** A unit the notice's table does not price at all (D11): counted on the bill, never charged. */
export interface OutsideUnit {
  unitId: string | null;
  /** Null for a card with no unit type: a أرض or a خيمة. */
  unitType: string | null;
}

/** One citizen's units as the table prices them. */
export interface TieredPricing {
  /** Every unit the table prices, each once. */
  units: TieredUnit[];
  /** Units the table does not price at all — outside the notice, counted (D11). */
  outside: OutsideUnit[];
  /**
   * Why this citizen's own bill cannot be raised: the first unit the table
   * should price and cannot — no area, or a level count or an area no bracket
   * covers — with its code and the unit's facts, which a screen words
   * (`feeUnassessableSchema`). Null when every unit was priced or is outside
   * the table.
   */
  unassessable: UnassessableDetail | null;
}

/**
 * Prices every unit one citizen is charged for, and says what stops their bill.
 *
 * A unit with no area, or one whose level count or area the table has no
 * bracket for, withholds the citizen's own bill, as a unit with no area does
 * under PER_AREA: billing the rest would read as a smaller holding, and the
 * caller reports the citizen by name so someone fixes the record. It no longer
 * stops the pricing: the units that could be priced are still returned, so the
 * run can bill a unit this citizen shares with others (D10).
 *
 * A unit whose type the table never names is a different case: the notice does
 * not charge it, so it is counted and left out (D11). A table for flats and
 * houses issued to every citizen must not strand the man who also owns a plot.
 *
 * One unit is priced once per citizen. The same flat can reach one person
 * twice — on their building card and through an occupancy — and a bracket fee
 * is per unit.
 */
export function priceTieredUnits(
  units: readonly BillableUnit[],
  brackets: readonly FeeMatrixBracket[],
): TieredPricing {
  const seen = new Set<string>();
  const priced: TieredUnit[] = [];
  const outside: OutsideUnit[] = [];
  let unassessable: UnassessableDetail | null = null;

  for (const unit of units) {
    if (unit.unitId) {
      if (seen.has(unit.unitId)) continue;
      seen.add(unit.unitId);
    }

    const match = matchBracket(unit, brackets);
    if (match.kind === 'miss') {
      if (match.reason === 'NOT_IN_TABLE') {
        outside.push({ unitId: unit.unitId ?? null, unitType: unit.unitType });
        continue;
      }
      const where = `${unit.unitCode ? `وحدة ${unit.unitCode}` : 'وحدة'} على العقار ${unit.propertyNumber ?? '—'}`;
      // The first unit that withholds the bill; the pricing goes on for the shared units (D10).
      unassessable ??= {
        reason:
          match.reason === 'NO_AREA'
            ? `${where} بلا مساحة مسجّلة`
            : `${where} لا تقع في أي فئة من جدول الفئات لنوعها${unitLevels(unit) > 1 ? ` وعدد طوابقها (${unitLevels(unit)})` : ''}`,
        code: match.reason === 'NO_AREA' ? 'NO_AREA' : 'NO_BRACKET',
        unit: unassessableUnit(unit),
      };
      continue;
    }

    const { bracket } = match;
    priced.push({
      unitId: unit.unitId ?? null,
      role: unit.occupancyType,
      amount: bracket.amount,
      bracketCode: bracket.code,
      line: {
        propertyNumber: unit.propertyNumber,
        propertyType: unit.propertyType,
        unitType: unit.unitType,
        unitArea: unit.unitArea,
        ...(unit.unitCode ? { unitCode: unit.unitCode } : {}),
        ...(unitLevels(unit) > 1 ? { levels: unitLevels(unit) } : {}),
        bracketCode: bracket.code,
        bracketLabel: bracket.labelAr,
        // The unit a later run of the period reads back (D8).
        ...(unit.unitId ? { unitId: unit.unitId } : {}),
      },
    });
  }

  return { units: priced, outside, unassessable };
}

/** What `assessCitizen` counted before pricing, carried onto the bill. */
export interface TieredCounts {
  excludedUnitCount: number;
  heldUnitCount: number;
  uninhabitableUnitCount: number;
  exemptUnitCount: number;
  /** Units whose حالة الوحدة the notice does not charge (0100). Absent on a shared bill, which holds one unit in scope. */
  outOfScopeUnitCount?: number;
  /** Units the table does not price (D11). Absent before pricing counted them. */
  outsideTableUnitCount?: number;
}

/**
 * A bill's breakdown under TIERED_AREA. There is no rate: each line carries
 * its bracket, and the amount is their sum.
 */
export function tieredAssessment(
  units: readonly TieredUnit[],
  counts: TieredCounts,
  shared: {
    sharedBillUnitCount?: number;
    sharedBillDebtorCount?: number;
    sharedConflictUnitCount?: number;
    billedElsewhereUnitCount?: number;
  } = {},
): FeeAssessment {
  return {
    basis: 'TIERED_AREA',
    rate: 0,
    unitCount: units.length,
    totalArea: units.reduce((sum, unit) => sum + (unit.line.unitArea ?? 0), 0),
    excludedUnitCount: counts.excludedUnitCount,
    heldUnitCount: counts.heldUnitCount,
    uninhabitableUnitCount: counts.uninhabitableUnitCount,
    sharedUnitCount: 0,
    coOwnerPaidUnitCount: 0,
    exemptUnitCount: counts.exemptUnitCount,
    outOfScopeUnitCount: counts.outOfScopeUnitCount ?? 0,
    ...(counts.outsideTableUnitCount ? { outsideTableUnitCount: counts.outsideTableUnitCount } : {}),
    ...(shared.sharedBillUnitCount ? { sharedBillUnitCount: shared.sharedBillUnitCount } : {}),
    ...(shared.sharedBillDebtorCount ? { sharedBillDebtorCount: shared.sharedBillDebtorCount } : {}),
    ...(shared.sharedConflictUnitCount ? { sharedConflictUnitCount: shared.sharedConflictUnitCount } : {}),
    ...(shared.billedElsewhereUnitCount ? { billedElsewhereUnitCount: shared.billedElsewhereUnitCount } : {}),
    lines: units.map((unit) => unit.line),
  };
}

/** A citizen's assessment as the run holds it, before shared units are taken out. */
export interface TieredCitizen {
  citizenId: string;
  amount: number;
  assessment: FeeAssessment | null;
  tieredUnits?: readonly TieredUnit[];
}

/** One unit billed once to everyone charged for it (D5). Written by the issue, Phase 5. */
export interface SharedUnitBill {
  unitId: string;
  amount: number;
  /** Everyone charged for the unit, in citizen-id order, with the capacity each is charged in. */
  debtors: Array<{ citizenId: string; role: string }>;
  assessment: FeeAssessment;
}

/**
 * A unit two or more citizens are charged for whose records put it in
 * different brackets — one card's مساحة in «B», another's in «C». Not billed:
 * choosing one would be a guess about which record is right. Reported, so the
 * area is corrected on the unit.
 */
export interface SharedUnitConflict {
  unitId: string;
  unitCode: string | null;
  propertyNumber: string | null;
  citizenIds: string[];
  bracketCodes: string[];
}

/**
 * Takes the units several citizens are charged for off their own bills and
 * bills each once, in full, as a shared unit bill (D5).
 *
 * One citizen's assessment cannot know who else is charged for a flat, so this
 * runs over the whole run. A unit is shared when two or more citizens'
 * assessments price it: co-owners under an owner-borne notice, co-tenants under
 * an occupant-borne one, or an owner and a tenant both charged because the
 * flat's status was never recorded. Each of them is a debtor on the one bill.
 *
 * `withheld` are the citizens whose own bill cannot be raised (`unassessable`
 * in `assessCitizen`) with the units that could still be priced. They hold
 * those units as anyone does — a unit they share is billed, with them among its
 * debtors (D10) — but they get no own bill, so a unit only they hold is billed
 * to nobody until their record is fixed.
 *
 * `alreadyBilled` are the units already on a bill of this notice for this
 * period, cancelled ones included (D8). Each of them is billed to nobody again:
 * a co-owner recorded after the period was billed joins the unit's bill from the
 * next period, rather than the unit being billed a second time in this one.
 *
 * A card-only unit has no census id and cannot be matched across citizens, so
 * it stays on each holder's own bill, as under every other basis. A citizen
 * whose every unit went to shared bills is returned with an amount of 0: the
 * issue raises no bill for them, and their counts still reach the summary.
 */
export function splitSharedUnitBills<C extends TieredCitizen>(
  assessed: readonly C[],
  options: {
    withheld?: readonly TieredCitizen[];
    alreadyBilled?: ReadonlySet<string>;
  } = {},
): { own: C[]; shared: SharedUnitBill[]; conflicts: SharedUnitConflict[] } {
  const alreadyBilled = options.alreadyBilled ?? new Set<string>();
  const holders = new Map<string, Array<{ citizenId: string; unit: TieredUnit }>>();
  for (const citizen of [...assessed, ...(options.withheld ?? [])]) {
    for (const unit of citizen.tieredUnits ?? []) {
      if (!unit.unitId || alreadyBilled.has(unit.unitId)) continue;
      const list = holders.get(unit.unitId) ?? [];
      if (!list.some((entry) => entry.citizenId === citizen.citizenId)) {
        list.push({ citizenId: citizen.citizenId, unit });
      }
      holders.set(unit.unitId, list);
    }
  }

  const shared: SharedUnitBill[] = [];
  const conflicts: SharedUnitConflict[] = [];
  /** Units taken off the citizens' own bills: billed as shared, or not billed at all. */
  const takenOff = new Set<string>();

  for (const [unitId, list] of holders) {
    if (list.length < 2) continue;
    takenOff.add(unitId);
    const ordered = [...list].sort((a, b) => a.citizenId.localeCompare(b.citizenId));
    const codes = [...new Set(ordered.map((entry) => entry.unit.bracketCode))];
    const first = ordered[0]!.unit;

    if (codes.length > 1) {
      conflicts.push({
        unitId,
        unitCode: first.line.unitCode ?? null,
        propertyNumber: first.line.propertyNumber,
        citizenIds: ordered.map((entry) => entry.citizenId),
        bracketCodes: codes,
      });
      continue;
    }

    shared.push({
      unitId,
      amount: first.amount,
      debtors: ordered.map((entry) => ({ citizenId: entry.citizenId, role: entry.unit.role })),
      assessment: tieredAssessment(
        [first],
        { excludedUnitCount: 0, heldUnitCount: 0, uninhabitableUnitCount: 0, exemptUnitCount: 0 },
        { sharedBillDebtorCount: ordered.length },
      ),
    });
  }

  if (takenOff.size === 0 && alreadyBilled.size === 0) return { own: [...assessed], shared, conflicts };

  const sharedIds = new Set(shared.map((bill) => bill.unitId));
  const conflictIds = new Set(conflicts.map((conflict) => conflict.unitId));
  const own = assessed.map((citizen) => {
    const units = citizen.tieredUnits ?? [];
    const kept = units.filter(
      (unit) => !unit.unitId || (!takenOff.has(unit.unitId) && !alreadyBilled.has(unit.unitId)),
    );
    if (kept.length === units.length || !citizen.assessment) return citizen;

    // Each unit that left this bill is counted on it, by where it went.
    const countOf = (ids: ReadonlySet<string>) => units.filter((unit) => unit.unitId && ids.has(unit.unitId)).length;
    const movedToShared = countOf(sharedIds);
    const conflicted = countOf(conflictIds);
    const billedElsewhere = countOf(alreadyBilled);
    return {
      ...citizen,
      amount: kept.reduce((sum, unit) => sum + unit.amount, 0),
      tieredUnits: kept,
      assessment: tieredAssessment(kept, citizen.assessment, {
        ...(movedToShared > 0 ? { sharedBillUnitCount: movedToShared } : {}),
        ...(conflicted > 0 ? { sharedConflictUnitCount: conflicted } : {}),
        ...(billedElsewhere > 0 ? { billedElsewhereUnitCount: billedElsewhere } : {}),
      }),
    };
  });

  return { own, shared, conflicts };
}
