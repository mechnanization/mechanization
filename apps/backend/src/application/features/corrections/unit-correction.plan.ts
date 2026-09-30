import { createHash } from 'node:crypto';
import {
  isStructuralUnitType,
  isSurveyed,
  statusForFlags,
  type FieldFlag,
  type UnitCorrectionBlocker,
  type UnitCorrectionPreview,
} from '@mechanization/shared-schemas';
import { withoutCardFlags, withoutRowFlags } from '../citizens/card-flags';

/**
 * What «حذف تصحيحي» of one census unit would do, worked out from rows already
 * read. No database access here, so every rule below is testable on plain data
 * (`unit-correction.plan.spec.ts`) and the service can compute the same plan
 * twice — once for the preview, once under lock — and compare.
 *
 * The rules are the ones the hand-written production repair of 2026-09-28
 * (A2-424-A: 0001, B101, B102) followed, which is also what «سُجِّل بالخطأ»
 * does in the app:
 *
 *  - The unit is deleted. Its occupancies, visits and vacancy confirmations go
 *    with it (foreign-key cascade); cases keep their building and lose the unit.
 *  - Every file line naming the unit is **ended, never deleted**, as recorded
 *    in error: a current line closes now, an already-ended line keeps its date
 *    and is re-marked. A flat that never existed was never lived in, so no
 *    line naming it can keep an honest ending like «انتقل».
 *  - A card left with no current line ends too, the way `TenancyService` ends
 *    one. A card with no line naming the unit is never touched.
 *  - A landlord link on a card that ends is cleared (`detachUnits` REVERT on an
 *    ended card); on a card that goes on, the unit is pruned from its record.
 *  - «غير مؤكَّد» flags name cards and lines by position, so the ones on what
 *    closes leave with it and later ones move up (`card-flags.ts`).
 *
 * Refused outright, even for an admin: a damage assessment (a compensation
 * document the cascade would erase), and a landlord link this correction
 * cannot revert exactly.
 */

export const RECORDED_IN_ERROR = 'RECORDED_IN_ERROR';

export interface CorrectionUnit {
  id: string;
  buildingId: string;
  unitCode: string;
  floor: number;
  sequence: number;
  unitType: string;
  unitStatus: string | null;
  surveyStatus: string;
  updatedAt: Date;
}

export interface CorrectionBuilding {
  id: string;
  code: string;
  /** Live counts of the building's units under the trigger's rule, not the stored counters. */
  countedUnits: number;
  surveyedUnits: number;
}

export interface CorrectionOccupancy {
  id: string;
  citizenId: string;
  citizenName: string;
  role: string;
  fromDate: Date;
  toDate: Date | null;
  endReason: string | null;
  updatedAt: Date;
}

export interface CorrectionVisit {
  id: string;
  visitedAt: Date;
  outcome: string;
  officerName: string | null;
}

export interface CorrectionVacancy {
  id: string;
  observedAt: Date;
  basis: string | null;
  endedAt: Date | null;
  updatedAt: Date;
}

export interface CorrectionCase {
  id: string;
  caseType: string | null;
  status: string;
  updatedAt: Date;
}

export interface CorrectionLine {
  id: string;
  propertyEntryId: string;
  unitId: string | null;
  unitType: string | null;
  floor: string | null;
  unitArea: string | null;
  endedAt: Date | null;
  endReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CorrectionCard {
  id: string;
  registrationId: string;
  citizenId: string;
  citizenName: string;
  occupancyType: string;
  propertyType: string;
  createdAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  endReason: string | null;
  landlordCitizenId: string | null;
  landlordLinkFootprint: unknown;
  /**
   * Who the card's units are credited to: the officer of the registration it
   * was filed on. A merge moves a card onto another registration but not its
   * credit (`cardsFiledOn`), so that is `filedRegistrationId`'s officer when
   * set, and the registration's own otherwise.
   */
  filedById: string | null;
  filedByName: string | null;
  /** Every row on the card, current and ended, in creation order. */
  rows: CorrectionLine[];
}

export interface CorrectionRegistration {
  id: string;
  citizenId: string;
  updatedAt: Date;
  flaggedFields: unknown;
  /** The registration's current cards in creation order: the order flags count positions in. */
  currentCardIds: string[];
}

/**
 * A «دمج ملفين» that has not been undone, with a file this correction may
 * change. The undo is refused once either file changes, so the delete ends it.
 */
export interface CorrectionMerge {
  id: string;
  survivorId: string;
  survivorName: string;
  absorbedId: string;
  absorbedName: string;
  mergedAt: Date;
}

export interface UnitCorrectionState {
  unit: CorrectionUnit;
  building: CorrectionBuilding;
  occupancies: CorrectionOccupancy[];
  visits: CorrectionVisit[];
  vacancies: CorrectionVacancy[];
  damageIds: string[];
  cases: CorrectionCase[];
  /** Every card with a row naming the unit, or a landlord link that names it. */
  cards: CorrectionCard[];
  /** The registrations those cards belong to. */
  registrations: CorrectionRegistration[];
  /** Standing merges of anyone on those cards or in the unit, or their landlords. */
  merges: CorrectionMerge[];
}

export interface LineChange {
  id: string;
  cardId: string;
  mode: 'END' | 'RECLASSIFY';
  previousEndReason: string | null;
}

export interface LandlordLinkChange {
  cardId: string;
  mode: 'CLEAR' | 'PRUNE';
  /** The footprint to write: null clears it. */
  footprint: Record<string, unknown> | null;
}

export interface RegistrationFlagChange {
  registrationId: string;
  flags: Array<Record<string, unknown>>;
  status: string;
  removed: Array<Record<string, unknown>>;
}

export interface UnitCorrectionPlan {
  fingerprint: string;
  blockers: UnitCorrectionBlocker[];
  lineChanges: LineChange[];
  cardsToEnd: string[];
  landlordLinks: LandlordLinkChange[];
  registrationFlags: RegistrationFlagChange[];
  pay: Array<{ officerId: string; officerName: string | null; unitsLost: number }>;
  counters: { totalBefore: number; totalAfter: number; surveyedBefore: number; surveyedAfter: number };
  /** Everyone whose census record or file this changes: one audit row each. */
  citizensAffected: string[];
}

const byCreation = (a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) =>
  a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);

/** The footprint's per-unit entries, or null when it is not a shape this code can revert. */
function footprintUnits(footprint: unknown): Array<Record<string, unknown>> | null {
  if (!footprint || typeof footprint !== 'object' || Array.isArray(footprint)) return null;
  const units = (footprint as { units?: unknown }).units;
  if (!Array.isArray(units)) return null;
  if (!units.every((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))) return null;
  return units as Array<Record<string, unknown>>;
}

export function planUnitCorrection(state: UnitCorrectionState): UnitCorrectionPlan {
  const { unit } = state;
  const blockers: UnitCorrectionBlocker[] = [];

  if (state.damageIds.length > 0) {
    blockers.push({ kind: 'DAMAGE_ASSESSMENT', count: state.damageIds.length });
  }

  // ── Lines naming the unit ──────────────────────────────────────────────
  const lineChanges: LineChange[] = [];
  for (const card of state.cards) {
    for (const row of card.rows) {
      if (row.unitId !== unit.id) continue;
      if (row.endedAt === null) {
        lineChanges.push({ id: row.id, cardId: card.id, mode: 'END', previousEndReason: null });
      } else if (row.endReason !== RECORDED_IN_ERROR) {
        lineChanges.push({ id: row.id, cardId: card.id, mode: 'RECLASSIFY', previousEndReason: row.endReason });
      }
    }
  }
  const ending = new Set(lineChanges.filter((change) => change.mode === 'END').map((change) => change.id));

  // ── Cards left with no current line ────────────────────────────────────
  const cardsToEnd = state.cards
    .filter((card) => {
      if (card.endedAt !== null) return false;
      const current = card.rows.filter((row) => row.endedAt === null);
      return current.length > 0 && current.every((row) => ending.has(row.id));
    })
    .map((card) => card.id);
  const endingCards = new Set(cardsToEnd);

  // ── Landlord links ─────────────────────────────────────────────────────
  const landlordLinks: LandlordLinkChange[] = [];
  for (const card of state.cards) {
    const footprint = card.landlordLinkFootprint;
    const hasFootprint = footprint !== null && footprint !== undefined;

    if (endingCards.has(card.id) && (card.landlordCitizenId || hasFootprint)) {
      if (hasFootprint) {
        const units = footprintUnits(footprint);
        if (!units) {
          blockers.push({ kind: 'UNREADABLE_LANDLORD_LINK', citizenName: card.citizenName });
          continue;
        }
        if (units.some((entry) => entry.unitId !== unit.id)) {
          blockers.push({ kind: 'LINK_NAMES_OTHER_UNITS', citizenName: card.citizenName });
          continue;
        }
      }
      landlordLinks.push({ cardId: card.id, mode: 'CLEAR', footprint: null });
      continue;
    }

    if (!hasFootprint || !JSON.stringify(footprint).includes(unit.id)) continue;
    const units = footprintUnits(footprint);
    if (!units) {
      blockers.push({ kind: 'UNREADABLE_LANDLORD_LINK', citizenName: card.citizenName });
      continue;
    }
    const remaining = units.filter((entry) => entry.unitId !== unit.id);
    if (remaining.length === units.length) continue;
    landlordLinks.push({
      cardId: card.id,
      mode: 'PRUNE',
      footprint: { ...(footprint as Record<string, unknown>), units: remaining },
    });
  }

  // ── «غير مؤكَّد» flags ─────────────────────────────────────────────────
  const cardById = new Map(state.cards.map((card) => [card.id, card]));
  const registrationFlags: RegistrationFlagChange[] = [];
  for (const registration of state.registrations) {
    const affected = registration.currentCardIds
      .map((cardId, index) => ({ cardId, index }))
      .filter(({ cardId }) => {
        const card = cardById.get(cardId);
        return Boolean(card && card.rows.some((row) => ending.has(row.id)));
      })
      // Last first, so each position is still the one it was read at.
      .sort((a, b) => b.index - a.index);
    if (affected.length === 0) continue;

    let flags: unknown = registration.flaggedFields;
    const removed: Array<Record<string, unknown>> = [];
    let changed = false;

    for (const { cardId, index } of affected) {
      if (endingCards.has(cardId)) {
        const shifted = withoutCardFlags(flags, index);
        flags = shifted.flags;
        changed ||= shifted.changed;
        removed.push(...shifted.removed);
        continue;
      }
      const current = cardById
        .get(cardId)!
        .rows.filter((row) => row.endedAt === null)
        .sort(byCreation);
      const positions = current
        .map((row, rowIndex) => (ending.has(row.id) ? rowIndex : -1))
        .filter((rowIndex) => rowIndex >= 0)
        .sort((a, b) => b - a);
      for (const rowIndex of positions) {
        const shifted = withoutRowFlags(flags, { cardIndex: index, rowIndex });
        flags = shifted.flags;
        changed ||= shifted.changed;
        removed.push(...shifted.removed);
      }
    }

    if (changed) {
      const list = flags as Array<Record<string, unknown>>;
      registrationFlags.push({
        registrationId: registration.id,
        flags: list,
        status: statusForFlags(list as unknown as FieldFlag[]),
        removed,
      });
    }
  }

  // ── Pay ────────────────────────────────────────────────────────────────
  /*
    Earnings are $1 per distinct unit per officer (`creditBillableUnits`), and a
    line or card ended RECORDED_IN_ERROR earns nothing. Every line naming this
    unit ends up RECORDED_IN_ERROR, so each officer who is credited for the
    unit today loses exactly one unit — however many lines of theirs name it.

    Credit follows the registration a card was filed on (`cardsFiledOn`): a
    card a merge carried across still pays the officer who filed it, and
    `load` resolves `filedById` to that officer.
  */
  const pay = new Map<string, { officerId: string; officerName: string | null; unitsLost: number }>();
  for (const card of state.cards) {
    if (!card.filedById || card.endReason === RECORDED_IN_ERROR) continue;
    const credited = card.rows.some(
      (row) =>
        row.unitId === unit.id && row.endReason !== RECORDED_IN_ERROR && !isStructuralUnitType(row.unitType),
    );
    if (credited && !pay.has(card.filedById)) {
      pay.set(card.filedById, { officerId: card.filedById, officerName: card.filedByName, unitsLost: 1 });
    }
  }

  // ── Building counters (the units trigger's rule) ───────────────────────
  const counted = !isStructuralUnitType(unit.unitType);
  const surveyed = counted && isSurveyed(unit.surveyStatus);
  const counters = {
    totalBefore: state.building.countedUnits,
    totalAfter: state.building.countedUnits - (counted ? 1 : 0),
    surveyedBefore: state.building.surveyedUnits,
    surveyedAfter: state.building.surveyedUnits - (surveyed ? 1 : 0),
  };

  const touchedCards = new Set([
    ...lineChanges.map((change) => change.cardId),
    ...landlordLinks.map((change) => change.cardId),
  ]);
  const citizensAffected = [
    ...new Set([
      ...state.occupancies.map((occupancy) => occupancy.citizenId),
      ...state.cards.filter((card) => touchedCards.has(card.id)).map((card) => card.citizenId),
    ]),
  ].sort();

  return {
    fingerprint: fingerprintOf(state),
    blockers,
    lineChanges,
    cardsToEnd,
    landlordLinks,
    registrationFlags,
    pay: [...pay.values()],
    counters,
    citizensAffected,
  };
}

/**
 * Everything the plan was computed from, hashed. The service recomputes this
 * under row locks and refuses the delete when it differs from the preview's:
 * whatever changed since, the admin has not read it.
 */
export function fingerprintOf(state: UnitCorrectionState): string {
  const at = (value: Date | null) => (value ? value.toISOString() : null);
  const sorted = <T extends { id: string }>(rows: readonly T[]) =>
    [...rows].sort((a, b) => a.id.localeCompare(b.id));

  const canonical = {
    unit: {
      id: state.unit.id,
      buildingId: state.unit.buildingId,
      unitCode: state.unit.unitCode,
      unitType: state.unit.unitType,
      surveyStatus: state.unit.surveyStatus,
      updatedAt: at(state.unit.updatedAt),
    },
    building: {
      countedUnits: state.building.countedUnits,
      surveyedUnits: state.building.surveyedUnits,
    },
    occupancies: sorted(state.occupancies).map((row) => [row.id, row.citizenId, at(row.toDate), at(row.updatedAt)]),
    visits: sorted(state.visits).map((row) => row.id),
    vacancies: sorted(state.vacancies).map((row) => [row.id, at(row.endedAt), at(row.updatedAt)]),
    damage: [...state.damageIds].sort(),
    cases: sorted(state.cases).map((row) => [row.id, row.status, at(row.updatedAt)]),
    cards: sorted(state.cards).map((card) => [
      card.id,
      card.registrationId,
      at(card.endedAt),
      card.endReason,
      card.landlordCitizenId,
      card.landlordLinkFootprint ?? null,
      card.filedById,
      at(card.updatedAt),
      sorted(card.rows).map((row) => [row.id, row.unitId, at(row.endedAt), row.endReason, at(row.updatedAt)]),
    ]),
    registrations: sorted(state.registrations).map((row) => [
      row.id,
      row.flaggedFields ?? null,
      row.currentCardIds,
      at(row.updatedAt),
    ]),
    merges: sorted(state.merges).map((row) => row.id),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The preview the dialog reads: the plan in terms of people, cards and lines. */
export function previewOf(state: UnitCorrectionState, plan: UnitCorrectionPlan): UnitCorrectionPreview {
  const iso = (value: Date) => value.toISOString();
  const lineChange = new Map(plan.lineChanges.map((change) => [change.id, change]));
  const endingCards = new Set(plan.cardsToEnd);
  const linkByCard = new Map(plan.landlordLinks.map((change) => [change.cardId, change.mode]));
  const flagsByRegistration = new Map(plan.registrationFlags.map((change) => [change.registrationId, change]));

  const files = new Map<string, UnitCorrectionPreview['files'][number]>();
  const fileOf = (citizenId: string, citizenName: string) => {
    let file = files.get(citizenId);
    if (!file) {
      file = { citizenId, citizenName, occupancyOnly: false, cards: [], flagsRemoved: 0 };
      files.set(citizenId, file);
    }
    return file;
  };

  for (const card of [...state.cards].sort(byCreation)) {
    const lines = card.rows
      .filter((row) => lineChange.has(row.id))
      .sort(byCreation)
      .map((row) => ({
        id: row.id,
        unitType: row.unitType,
        floor: row.floor,
        unitArea: row.unitArea,
        change: lineChange.get(row.id)!.mode,
        previousEndReason: lineChange.get(row.id)!.previousEndReason,
      }));
    const landlordLink = linkByCard.get(card.id) ?? null;
    if (lines.length === 0 && !landlordLink) continue;
    const mode = landlordLink === 'CLEAR' ? 'CLEARED' : landlordLink === 'PRUNE' ? 'PRUNED' : null;
    fileOf(card.citizenId, card.citizenName).cards.push({
      cardId: card.id,
      propertyType: card.propertyType,
      occupancyType: card.occupancyType,
      cardEnds: endingCards.has(card.id),
      landlordLink: mode,
      lines,
    });
  }

  for (const registration of state.registrations) {
    const change = flagsByRegistration.get(registration.id);
    if (change && files.has(registration.citizenId)) {
      files.get(registration.citizenId)!.flagsRemoved += change.removed.length;
    }
  }

  for (const occupancy of state.occupancies) {
    if (!files.has(occupancy.citizenId)) {
      fileOf(occupancy.citizenId, occupancy.citizenName).occupancyOnly = true;
    }
  }

  const nothingRecorded =
    state.occupancies.length === 0 &&
    state.visits.length === 0 &&
    state.vacancies.length === 0 &&
    state.damageIds.length === 0 &&
    state.cases.length === 0 &&
    plan.lineChanges.length === 0 &&
    plan.landlordLinks.length === 0;

  return {
    unit: {
      id: state.unit.id,
      unitCode: state.unit.unitCode,
      floor: state.unit.floor,
      unitType: state.unit.unitType,
      unitStatus: state.unit.unitStatus,
      surveyStatus: state.unit.surveyStatus,
    },
    building: { id: state.building.id, code: state.building.code },
    fingerprint: plan.fingerprint,
    blockers: plan.blockers,
    nothingRecorded,
    removed: {
      occupancies: [...state.occupancies]
        .sort((a, b) => a.fromDate.getTime() - b.fromDate.getTime())
        .map((row) => ({
          id: row.id,
          citizenId: row.citizenId,
          citizenName: row.citizenName,
          role: row.role,
          fromDate: iso(row.fromDate),
          toDate: row.toDate ? iso(row.toDate) : null,
          endReason: row.endReason,
        })),
      visits: [...state.visits]
        .sort((a, b) => a.visitedAt.getTime() - b.visitedAt.getTime())
        .map((row) => ({ id: row.id, visitedAt: iso(row.visitedAt), outcome: row.outcome, officerName: row.officerName })),
      vacancies: [...state.vacancies]
        .sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime())
        .map((row) => ({ id: row.id, observedAt: iso(row.observedAt), basis: row.basis, standing: row.endedAt === null })),
    },
    files: [...files.values()],
    casesUnlinked: state.cases.map((row) => ({ id: row.id, caseType: row.caseType, status: row.status })),
    pay: plan.pay,
    counters: plan.counters,
    mergesEnded: mergesEnded(state, plan),
  };
}

/**
 * The standing merges this delete makes impossible to undo: those with a file
 * whose cards, lines or census record it changes. The undo compares each file
 * row by row with how the merge left it, so any change here is one.
 */
function mergesEnded(state: UnitCorrectionState, plan: UnitCorrectionPlan): UnitCorrectionPreview['mergesEnded'] {
  const changedCards = new Set([
    ...plan.cardsToEnd,
    ...plan.lineChanges.map((change) => change.cardId),
    ...plan.landlordLinks.map((change) => change.cardId),
  ]);
  const touched = new Set(plan.citizensAffected);
  for (const card of state.cards) {
    if (!changedCards.has(card.id)) continue;
    touched.add(card.citizenId);
    // A tenant's card linked to a merged owner is named in that merge's footprint.
    if (card.landlordCitizenId) touched.add(card.landlordCitizenId);
  }
  return [...state.merges]
    .filter((merge) => touched.has(merge.survivorId) || touched.has(merge.absorbedId))
    .sort((a, b) => a.mergedAt.getTime() - b.mergedAt.getTime() || a.id.localeCompare(b.id))
    .map((merge) => ({
      mergeId: merge.id,
      survivorId: merge.survivorId,
      survivorName: merge.survivorName,
      absorbedName: merge.absorbedName,
      mergedAt: merge.mergedAt.toISOString(),
    }));
}
