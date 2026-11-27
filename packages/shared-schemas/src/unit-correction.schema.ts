import { z } from 'zod';
import { typeError } from './type-error';
import type { BlockRefusal } from './error-codes';

/**
 * «حذف تصحيحي» — a SUPER_ADMIN removes a census unit the ordinary delete
 * refuses, because something was recorded against a flat that does not exist.
 *
 * The ordinary `deleteUnit` stops at the first occupancy, visit or file line,
 * and until this existed the only way past it was hand-written SQL against
 * production. This is that SQL as a feature: previewed, confirmed, one
 * transaction, audited inside it.
 *
 * The request carries the preview's `fingerprint`. The server recomputes it
 * under row locks and refuses when anything the preview showed has changed,
 * so what is deleted is always exactly what the admin read.
 */
export const unitCorrectionDeleteSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/, 'افتح المعاينة من جديد'),
  reason: z
    .string(typeError({ required: 'اكتب سبب الحذف' }))
    .trim()
    .min(10, 'اكتب سبباً واضحاً: عشرة أحرف على الأقل')
    .max(500, 'السبب طويل جداً'),
  /** The unit's code, typed by hand: the confirmation muscle memory cannot give. */
  confirmCode: z.string(typeError({ required: 'اكتب رمز الوحدة للتأكيد' })).trim().min(1, 'اكتب رمز الوحدة للتأكيد'),
});

export type UnitCorrectionDeleteInput = z.infer<typeof unitCorrectionDeleteSchema>;

/** Why a correction delete cannot go ahead even for an admin. */
export type UnitCorrectionBlocker =
  /** A damage assessment is a compensation document; the cascade would erase it. */
  | { kind: 'DAMAGE_ASSESSMENT'; count: number }
  /** A landlord link on a card that ends here also wrote to other units; unlink it from the file first. */
  | { kind: 'LINK_NAMES_OTHER_UNITS'; citizenName: string }
  /** A landlord link whose record could not be read, so it cannot be reverted safely. */
  | { kind: 'UNREADABLE_LANDLORD_LINK'; citizenName: string };

/** A blocker as a preview sends it: what it is, and its refusal to word it by (ERR-04). */
export type WithRefusal<T> = T & { refusal: BlockRefusal };

/** The refusal «حذف تصحيحي» answers a blocker with, and the preview words it by. */
export function unitCorrectionBlockerRefusal(blocker: UnitCorrectionBlocker): BlockRefusal {
  switch (blocker.kind) {
    case 'DAMAGE_ASSESSMENT':
      return { code: 'UNIT_CORRECTION_DAMAGE_ASSESSMENT', params: { count: blocker.count } };
    case 'LINK_NAMES_OTHER_UNITS':
      return { code: 'UNIT_CORRECTION_LINK_NAMES_OTHER_UNITS', params: { name: blocker.citizenName } };
    case 'UNREADABLE_LANDLORD_LINK':
      return { code: 'UNIT_CORRECTION_UNREADABLE_LANDLORD_LINK', params: { name: blocker.citizenName } };
  }
}

export interface UnitCorrectionPreview {
  unit: {
    id: string;
    unitCode: string;
    floor: number;
    unitType: string;
    unitStatus: string | null;
    surveyStatus: string;
  };
  building: { id: string; code: string };
  /** Recomputed by the server under lock; the delete is refused if it differs. */
  fingerprint: string;
  blockers: Array<WithRefusal<UnitCorrectionBlocker>>;
  /** Nothing hangs off the unit: the delete removes the unit row and nothing else. */
  nothingRecorded: boolean;
  /** Census records removed with the unit (the foreign-key cascade). */
  removed: {
    occupancies: Array<{
      id: string;
      citizenId: string;
      citizenName: string;
      role: string;
      fromDate: string;
      toDate: string | null;
      endReason: string | null;
    }>;
    visits: Array<{ id: string; visitedAt: string; outcome: string; officerName: string | null }>;
    vacancies: Array<{ id: string; observedAt: string; basis: string | null; standing: boolean }>;
  };
  /** Citizens' files: lines closed as «سُجِّل بالخطأ», kept as history, never deleted. */
  files: Array<{
    citizenId: string;
    citizenName: string;
    /** Recorded in the unit (an occupancy) with no line on any card naming it. */
    occupancyOnly: boolean;
    cards: Array<{
      cardId: string;
      propertyType: string;
      occupancyType: string;
      /** No current line is left on the card, so the card itself closes. */
      cardEnds: boolean;
      landlordLink: 'CLEARED' | 'PRUNED' | null;
      lines: Array<{
        id: string;
        unitType: string | null;
        floor: string | null;
        unitArea: string | null;
        /** END: a current line closes today. RECLASSIFY: an ended line is re-marked «سُجِّل بالخطأ». */
        change: 'END' | 'RECLASSIFY';
        previousEndReason: string | null;
      }>;
    }>;
    /** «غير مؤكَّد» flags that named a closed line or card and leave with it. */
    flagsRemoved: number;
  }>;
  /** Follow-up cases about the unit: they stay on the building with no unit. */
  casesUnlinked: Array<{ id: string; caseType: string | null; status: string }>;
  /** Officers whose billable units fall, one per officer (pay dedupes by unit). */
  pay: Array<{ officerId: string; officerName: string | null; unitsLost: number }>;
  counters: { totalBefore: number; totalAfter: number; surveyedBefore: number; surveyedAfter: number };
  /**
   * Standing «دمج ملفين» of a file this delete changes. The undo refuses once
   * either file changes, so after this delete those merges are final.
   */
  mergesEnded: Array<{
    mergeId: string;
    survivorId: string;
    survivorName: string;
    absorbedName: string;
    mergedAt: string;
  }>;
}

export interface UnitCorrectionResult {
  unitCode: string;
  buildingId: string;
  buildingCode: string;
  deleted: { occupancies: number; visits: number; vacancies: number };
  linesEnded: number;
  linesReclassified: number;
  cardsEnded: number;
  landlordLinksChanged: number;
  casesUnlinked: number;
  citizensAffected: number;
  auditEntries: number;
}

// ─────────────────────────────  «دمج كدوبلكس»  ─────────────────────────────

/**
 * «دمج مع الوحدة العلوية كدوبلكس» — a SUPER_ADMIN folds the flat directly above
 * a flat into it, when the two were recorded as two flats but are one home on
 * two levels (decision D28, migration 0095).
 *
 * It is «حذف تصحيحي» of the upper flat, plus what makes it a merge: the lower
 * flat rises by the upper one's levels and takes both areas, the upper flat's
 * visits and follow-up cases move down, and the lower flat's file lines take
 * the new area. Previewed, fingerprinted, one transaction, audited inside it —
 * exactly as the delete is.
 *
 * `confirmCode` is the UPPER flat's code: the one that disappears.
 * `totalArea` overrides the summed area — the officer measured the whole home —
 * and is required when either flat has none.
 */
export const duplexMergeSchema = unitCorrectionDeleteSchema.extend({
  totalArea: z.coerce
    .number(typeError({ invalid: 'المساحة يجب أن تكون رقماً' }))
    .positive('المساحة يجب أن تكون أكبر من صفر')
    .max(100_000, 'المساحة كبيرة جداً')
    .optional(),
});

export type DuplexMergeInput = z.infer<typeof duplexMergeSchema>;

/** Why two stacked flats cannot be merged as one home, even by an admin. */
export type DuplexMergeBlocker =
  /** Only flats (شقة) are merged; a house's storeys are its levels already. */
  | { kind: 'NOT_FLATS' }
  /** The merged home would span more levels than a unit may. */
  | { kind: 'TOO_MANY_LEVELS'; max: number }
  /** Someone recorded in the upper flat is not recorded in the lower one, in the same capacity. */
  | { kind: 'OTHER_HOUSEHOLD'; citizenName: string }
  /** A card names the upper flat but not the lower one, so it would lose its flat. */
  | { kind: 'CARD_WITHOUT_LOWER'; citizenName: string }
  /** The upper flat carries a standing «تأكيد الشغور». */
  | { kind: 'STANDING_VACANCY' }
  /** The two flats are billed differently (exemption or co-owner method) — one home cannot be both. */
  | { kind: 'BILLING_DIFFERS' }
  /** Neither flat's area is known, nor was the whole home's given. */
  | { kind: 'AREA_UNKNOWN' }
  | UnitCorrectionBlocker;

/**
 * The refusal «دمج كدوبلكس» answers a blocker with, and the preview words it
 * by. The three blockers it shares with «حذف تصحيحي» have codes of their own
 * here: they are about the upper flat, not the unit being deleted.
 */
export function duplexMergeBlockerRefusal(blocker: DuplexMergeBlocker): BlockRefusal {
  switch (blocker.kind) {
    case 'NOT_FLATS':
      return { code: 'DUPLEX_MERGE_NOT_FLATS', params: {} };
    case 'TOO_MANY_LEVELS':
      return { code: 'DUPLEX_MERGE_TOO_MANY_LEVELS', params: { max: blocker.max } };
    case 'OTHER_HOUSEHOLD':
      return { code: 'DUPLEX_MERGE_OTHER_HOUSEHOLD', params: { name: blocker.citizenName } };
    case 'CARD_WITHOUT_LOWER':
      return { code: 'DUPLEX_MERGE_CARD_WITHOUT_LOWER', params: { name: blocker.citizenName } };
    case 'STANDING_VACANCY':
      return { code: 'DUPLEX_MERGE_STANDING_VACANCY', params: {} };
    case 'BILLING_DIFFERS':
      return { code: 'DUPLEX_MERGE_BILLING_DIFFERS', params: {} };
    case 'AREA_UNKNOWN':
      return { code: 'DUPLEX_MERGE_AREA_UNKNOWN', params: {} };
    case 'DAMAGE_ASSESSMENT':
      return { code: 'DUPLEX_MERGE_DAMAGE_ASSESSMENT', params: { count: blocker.count } };
    case 'LINK_NAMES_OTHER_UNITS':
      return { code: 'DUPLEX_MERGE_LINK_NAMES_OTHER_UNITS', params: { name: blocker.citizenName } };
    case 'UNREADABLE_LANDLORD_LINK':
      return { code: 'DUPLEX_MERGE_UNREADABLE_LANDLORD_LINK', params: { name: blocker.citizenName } };
  }
}

export interface DuplexMergePreview {
  lower: { id: string; unitCode: string; floor: number; levels: number; unitArea: string | null };
  upper: { id: string; unitCode: string; floor: number; levels: number; unitArea: string | null };
  building: { id: string; code: string };
  /** Recomputed under lock; the merge is refused if it differs. */
  fingerprint: string;
  blockers: Array<WithRefusal<DuplexMergeBlocker>>;
  /** What the lower flat becomes. `areaAfter` is null when it must be given (`AREA_UNKNOWN`). */
  levelsAfter: number;
  areaAfter: string | null;
  /** Moved onto the lower flat. */
  visitsMoved: number;
  casesMoved: number;
  /** The upper flat's spells, removed with it — each one duplicated on the lower flat. */
  occupanciesRemoved: number;
  /** The upper flat's file lines, closed «سُجِّل بالخطأ»: the cards keep their line on the lower flat. */
  files: UnitCorrectionPreview['files'];
  /** Officers whose billable units fall: the upper flat was one more unit than the home is. */
  pay: UnitCorrectionPreview['pay'];
  /** Standing «دمج ملفين» of a file this changes — final once it does (as for «حذف تصحيحي»). */
  mergesEnded: UnitCorrectionPreview['mergesEnded'];
}

export interface DuplexMergeResult {
  unitCode: string;
  removedUnitCode: string;
  buildingId: string;
  levels: number;
  unitArea: string | null;
  linesEnded: number;
  visitsMoved: number;
  casesMoved: number;
  citizensAffected: number;
}
