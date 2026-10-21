import { createHash } from 'node:crypto';
import { MAX_UNIT_LEVELS, type DuplexMergeBlocker } from '@mechanization/shared-schemas';
import type { UnitCorrectionPlan, UnitCorrectionState } from './unit-correction.plan';

/**
 * «دمج مع الوحدة العلوية كدوبلكس» — the rules, apart from the transaction
 * (decision D28, 2026-10-17).
 *
 * Two flats stacked on each other that are one home on two levels — B-1-352-A,
 * recorded as 0001 and 0101 before a unit could span levels — become one unit:
 * the lower flat rises by the upper one's levels, and the upper flat is removed
 * exactly as «حذف تصحيحي» removes it (its file lines closed «سُجِّل بالخطأ»,
 * never deleted). That half is `planUnitCorrection`, unchanged; this module is
 * only what makes it a merge, and what makes a merge wrong:
 *
 *  - both are flats — a house's storeys are its levels already;
 *  - everyone recorded upstairs is recorded downstairs, in the same capacity,
 *    and every card naming the upper flat names the lower one too. Otherwise the
 *    upper flat is somebody else's home, and merging would bill one household
 *    for another's roof;
 *  - nothing on the upper flat says it is billed differently — a standing
 *    vacancy, an exemption, a co-owner method — since one home cannot be both;
 *  - the merged home has an area: the two summed, or the whole home's measured.
 */

/** One of the two flats, as the merge reads it. */
export interface MergeFlat {
  id: string;
  unitCode: string;
  floor: number;
  levels: number;
  unitType: string;
  unitArea: string | null;
  feeExemption: string | null;
  ownerBillingMode: string | null;
  responsibleOwnerId: string | null;
  startCol: number | null;
  endCol: number | null;
  updatedAt: Date;
}

export interface DuplexMergeState {
  lower: MergeFlat;
  upper: MergeFlat;
  /** «حذف تصحيحي»'s reading of the upper flat. */
  upperState: UnitCorrectionState;
  upperPlan: UnitCorrectionPlan;
  /** Current spells on the lower flat. */
  lowerSpells: Array<{ citizenId: string; role: string }>;
  /** Current file lines naming the lower flat. */
  lowerLines: Array<{ id: string; propertyEntryId: string; updatedAt: Date }>;
}

export interface DuplexMergePlan {
  fingerprint: string;
  blockers: DuplexMergeBlocker[];
  levelsAfter: number;
  /** As a decimal string, or null when it is unknown and was not given. */
  areaAfter: string | null;
}

/** The two areas summed to two decimals, or null when either is unknown. */
function summedArea(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null;
  return (Math.round((Number(a) + Number(b)) * 100) / 100).toFixed(2);
}

export function planDuplexMerge(state: DuplexMergeState, totalArea?: number): DuplexMergePlan {
  const { lower, upper, upperState, upperPlan } = state;
  const blockers: DuplexMergeBlocker[] = [];

  if (lower.unitType !== 'APARTMENT' || upper.unitType !== 'APARTMENT') blockers.push({ kind: 'NOT_FLATS' });
  if (lower.levels + upper.levels > MAX_UNIT_LEVELS) blockers.push({ kind: 'TOO_MANY_LEVELS', max: MAX_UNIT_LEVELS });

  const below = new Set(state.lowerSpells.map((spell) => `${spell.citizenId}:${spell.role}`));
  for (const spell of upperState.occupancies) {
    if (spell.toDate !== null) continue;
    if (!below.has(`${spell.citizenId}:${spell.role}`)) {
      blockers.push({ kind: 'OTHER_HOUSEHOLD', citizenName: spell.citizenName });
    }
  }

  const cardsBelow = new Set(state.lowerLines.map((line) => line.propertyEntryId));
  for (const card of upperState.cards) {
    if (card.endedAt) continue;
    const namesUpper = card.rows.some((row) => row.unitId === upper.id && row.endedAt === null);
    if (namesUpper && !cardsBelow.has(card.id)) {
      blockers.push({ kind: 'CARD_WITHOUT_LOWER', citizenName: card.citizenName });
    }
  }

  if (upperState.vacancies.some((vacancy) => vacancy.endedAt === null)) blockers.push({ kind: 'STANDING_VACANCY' });
  if (
    lower.feeExemption !== upper.feeExemption ||
    lower.ownerBillingMode !== upper.ownerBillingMode ||
    lower.responsibleOwnerId !== upper.responsibleOwnerId
  ) {
    blockers.push({ kind: 'BILLING_DIFFERS' });
  }

  const areaAfter = totalArea !== undefined ? totalArea.toFixed(2) : summedArea(lower.unitArea, upper.unitArea);
  if (areaAfter === null) blockers.push({ kind: 'AREA_UNKNOWN' });

  // «حذف تصحيحي»'s own refusals — a damage assessment, a link it cannot revert.
  blockers.push(...upperPlan.blockers);

  return {
    fingerprint: fingerprintOf(state),
    blockers,
    levelsAfter: lower.levels + upper.levels,
    areaAfter,
  };
}

/**
 * The upper flat's correction fingerprint, and everything on the lower flat the
 * merge writes to or reasons from. The whole home's area is not in it: it is
 * what the admin types on confirming, not something that can go stale.
 */
export function fingerprintOf(state: DuplexMergeState): string {
  const canonical = {
    upper: state.upperPlan.fingerprint,
    upperRow: {
      levels: state.upper.levels,
      unitArea: state.upper.unitArea,
      unitType: state.upper.unitType,
      updatedAt: state.upper.updatedAt.toISOString(),
    },
    lower: {
      id: state.lower.id,
      levels: state.lower.levels,
      unitArea: state.lower.unitArea,
      unitType: state.lower.unitType,
      feeExemption: state.lower.feeExemption,
      ownerBillingMode: state.lower.ownerBillingMode,
      updatedAt: state.lower.updatedAt.toISOString(),
    },
    spells: [...state.lowerSpells].map((spell) => `${spell.citizenId}:${spell.role}`).sort(),
    lines: [...state.lowerLines].map((line) => `${line.id}:${line.updatedAt.toISOString()}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Why the merge cannot go ahead, in a sentence the dialog and the refusal both show. */
export function mergeBlockerReason(blocker: DuplexMergeBlocker): string {
  switch (blocker.kind) {
    case 'NOT_FLATS':
      return 'الدمج كدوبلكس للشقق فقط؛ طوابق المنزل تُسجَّل في «عدد طوابق المسكن»';
    case 'TOO_MANY_LEVELS':
      return `المسكن لا يتجاوز ${blocker.max} طوابق`;
    case 'OTHER_HOUSEHOLD':
      return `${blocker.citizenName} مسجَّل في الوحدة العلوية وليس في السفلية بالصفة نفسها — قد تكون أسرة أخرى`;
    case 'CARD_WITHOUT_LOWER':
      return `ملف ${blocker.citizenName} يسمّي الوحدة العلوية دون السفلية`;
    case 'STANDING_VACANCY':
      return 'على الوحدة العلوية تأكيد شغور قائم';
    case 'BILLING_DIFFERS':
      return 'الوحدتان تُفوتران بطريقتين مختلفتين (إعفاء أو توزيع بين المالكين)';
    case 'AREA_UNKNOWN':
      return 'مساحة إحدى الوحدتين غير مسجَّلة: اكتب مساحة المسكن كاملاً';
    case 'DAMAGE_ASSESSMENT':
      return `على الوحدة العلوية ${blocker.count} كشف ضرر`;
    case 'LINK_NAMES_OTHER_UNITS':
      return `ربط ملف ${blocker.citizenName} بالمالك يشمل وحدات أخرى`;
    case 'UNREADABLE_LANDLORD_LINK':
      return `تعذّرت قراءة ربط ملف ${blocker.citizenName} بالمالك`;
  }
}
