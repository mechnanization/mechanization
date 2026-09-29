import { z } from 'zod';

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
    .string({ required_error: 'اكتب سبب الحذف' })
    .trim()
    .min(10, 'اكتب سبباً واضحاً: عشرة أحرف على الأقل')
    .max(500, 'السبب طويل جداً'),
  /** The unit's code, typed by hand: the confirmation muscle memory cannot give. */
  confirmCode: z.string({ required_error: 'اكتب رمز الوحدة للتأكيد' }).trim().min(1, 'اكتب رمز الوحدة للتأكيد'),
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
  blockers: UnitCorrectionBlocker[];
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
