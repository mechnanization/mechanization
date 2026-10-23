import {
  matchBracket,
  unitLevels,
  type FeeAssessment,
  type FeeAssessmentLine,
  type FeeMatrixBracket,
} from '@mechanization/shared-schemas';
import type { BillableUnit } from '../../../domain/entities/billable-unit';

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

/**
 * Prices every unit one citizen is charged for, or says why it cannot.
 *
 * A unit with no area, or one the table has no bracket for, stops the whole
 * assessment, as a unit with no area does under PER_AREA: billing the rest
 * would read as a smaller holding, and the caller reports the citizen by name
 * so someone fixes the record.
 *
 * One unit is priced once per citizen. The same flat can reach one person
 * twice — on their building card and through an occupancy — and a bracket fee
 * is per unit.
 */
export function priceTieredUnits(
  units: readonly BillableUnit[],
  brackets: readonly FeeMatrixBracket[],
): { kind: 'priced'; units: TieredUnit[] } | { kind: 'unassessable'; reason: string } {
  const seen = new Set<string>();
  const priced: TieredUnit[] = [];

  for (const unit of units) {
    if (unit.unitId) {
      if (seen.has(unit.unitId)) continue;
      seen.add(unit.unitId);
    }

    const match = matchBracket(unit, brackets);
    if (match.kind === 'miss') {
      const where = `${unit.unitCode ? `وحدة ${unit.unitCode}` : 'وحدة'} على العقار ${unit.propertyNumber ?? '—'}`;
      return {
        kind: 'unassessable',
        reason:
          match.reason === 'NO_AREA'
            ? `${where} بلا مساحة مسجّلة`
            : `${where} لا تقع في أي فئة من جدول الفئات لنوعها${unitLevels(unit) > 1 ? ` وعدد طوابقها (${unitLevels(unit)})` : ''}`,
      };
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
      },
    });
  }

  return { kind: 'priced', units: priced };
}

/** What `assessCitizen` counted before pricing, carried onto the bill. */
export interface TieredCounts {
  excludedUnitCount: number;
  heldUnitCount: number;
  uninhabitableUnitCount: number;
  exemptUnitCount: number;
}

/**
 * A bill's breakdown under TIERED_AREA. There is no rate: each line carries
 * its bracket, and the amount is their sum.
 */
export function tieredAssessment(
  units: readonly TieredUnit[],
  counts: TieredCounts,
  shared: { sharedBillUnitCount?: number; sharedBillDebtorCount?: number } = {},
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
    ...(shared.sharedBillUnitCount ? { sharedBillUnitCount: shared.sharedBillUnitCount } : {}),
    ...(shared.sharedBillDebtorCount ? { sharedBillDebtorCount: shared.sharedBillDebtorCount } : {}),
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
 * A card-only unit has no census id and cannot be matched across citizens, so
 * it stays on each holder's own bill, as under every other basis. A citizen
 * whose every unit went to shared bills is returned with an amount of 0: the
 * issue raises no bill for them, and their counts still reach the summary.
 */
export function splitSharedUnitBills<C extends TieredCitizen>(
  assessed: readonly C[],
): { own: C[]; shared: SharedUnitBill[]; conflicts: SharedUnitConflict[] } {
  const holders = new Map<string, Array<{ citizenId: string; unit: TieredUnit }>>();
  for (const citizen of assessed) {
    for (const unit of citizen.tieredUnits ?? []) {
      if (!unit.unitId) continue;
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

  if (takenOff.size === 0) return { own: [...assessed], shared, conflicts };

  const sharedIds = new Set(shared.map((bill) => bill.unitId));
  const own = assessed.map((citizen) => {
    const units = citizen.tieredUnits ?? [];
    const kept = units.filter((unit) => !unit.unitId || !takenOff.has(unit.unitId));
    if (kept.length === units.length || !citizen.assessment) return citizen;

    const movedToShared = units.filter((unit) => unit.unitId && sharedIds.has(unit.unitId)).length;
    return {
      ...citizen,
      amount: kept.reduce((sum, unit) => sum + unit.amount, 0),
      tieredUnits: kept,
      assessment: tieredAssessment(kept, citizen.assessment, {
        ...(movedToShared > 0 ? { sharedBillUnitCount: movedToShared } : {}),
      }),
    };
  });

  return { own, shared, conflicts };
}
