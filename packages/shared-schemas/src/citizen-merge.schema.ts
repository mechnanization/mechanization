import { z } from 'zod';
import { uuid } from './primitives';

/**
 * «دمج ملفين» — one person filed twice, folded into one file.
 *
 * ## Who may do it
 *
 * SUPER_ADMIN only, server-enforced. It is the one action in the register that
 * rewrites *whose* a registration, a bill and a flat are, and the launch-day
 * incident (2026-09-12: three brothers merged into one row by a shared document
 * number) is what a merge looks like when nobody with both files in front of
 * them decided it.
 *
 * ## What it does
 *
 * The kept file stays; the other is deactivated and points at it. Everything
 * the other file held moves across — its filings, its current cards (onto the
 * kept file's newest filing, which is the one billing and the edit form read),
 * its census spells, bills, payment checkouts, cases and the tenants' links
 * that name it as landlord. A flat both files record ends on the absorbed side
 * as «سُجِّل خطأً». A field the kept file is missing is filled from the other;
 * a field both answer differently keeps the kept file's answer.
 *
 * ## How it is undone
 *
 * «التراجع عن الدمج» reverts exactly what the merge recorded, and is refused
 * once either file has changed since — the same rule «إلغاء الربط» follows for
 * an owner link.
 */

/** Why a merge cannot go ahead — each one names the step that unblocks it. */
export const CITIZEN_MERGE_BLOCKS = [
  'SAME_FILE',
  'INACTIVE',
  'ALREADY_MERGED',
  'ROLE_CONFLICT',
  'LINKED_DUPLICATE',
  'SELF_LINK',
  'RESIDENCE_CONFLICT',
  'TOO_MANY_CARDS',
] as const;
export type CitizenMergeBlockCode = (typeof CITIZEN_MERGE_BLOCKS)[number];

/** Why an undo cannot go ahead. */
export const CITIZEN_UNMERGE_BLOCKS = ['ALREADY_UNDONE', 'CHANGED_SINCE', 'MERGED_AGAIN'] as const;
export type CitizenUnmergeBlockCode = (typeof CITIZEN_UNMERGE_BLOCKS)[number];

const reason = z
  .string()
  .trim()
  .min(10, 'اشرح بجملة كاملة لماذا — ١٠ أحرف على الأقل')
  .max(1000, 'السبب طويل جداً');

/** Which file stays and which is folded into it. */
export const citizenMergePairSchema = z
  .object({
    keepId: uuid,
    absorbId: uuid,
  })
  .refine((pair) => pair.keepId !== pair.absorbId, {
    message: 'لا يمكن دمج ملف في نفسه',
    path: ['absorbId'],
  });
export type CitizenMergePair = z.infer<typeof citizenMergePairSchema>;

export const citizenMergeSchema = z
  .object({
    keepId: uuid,
    absorbId: uuid,
    reason,
    /**
     * The two version stamps the preview returned. The merge is refused if
     * either file moved since — the preview is what the administrator agreed
     * to, and a merge of something else is not what they confirmed.
     */
    expected: z.object({
      keep: z.string().min(1).max(200),
      absorb: z.string().min(1).max(200),
    }),
  })
  .refine((pair) => pair.keepId !== pair.absorbId, {
    message: 'لا يمكن دمج ملف في نفسه',
    path: ['absorbId'],
  });
export type CitizenMergeInput = z.infer<typeof citizenMergeSchema>;

export const citizenUnmergeSchema = z.object({ reason });
export type CitizenUnmergeInput = z.infer<typeof citizenUnmergeSchema>;

/**
 * The live «قد يكون مسجَّلاً مسبقاً» question, asked while the form is typed.
 *
 * Every field optional, because the form asks after two letters of a name or
 * six digits of a phone; the rule decides what is enough.
 */
export const possibleDuplicatesQuerySchema = z.object({
  firstName: z.string().trim().max(60).optional(),
  middleName: z.string().trim().max(60).optional(),
  lastName: z.string().trim().max(60).optional(),
  motherName: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
  whatsapp: z.string().trim().max(32).optional(),
  civilRecordNumber: z.string().trim().max(40).optional(),
  residencyNumber: z.string().trim().max(40).optional(),
  gender: z.enum(['MALE', 'FEMALE']).optional(),
  isLebanese: z.boolean().optional(),
  /** Census units the cards being typed name — the same door, filed twice. */
  unitIds: z.array(uuid).max(200).optional(),
  /** The file being edited, which is never its own duplicate. */
  excludeId: uuid.optional(),
});
export type PossibleDuplicatesQuery = z.infer<typeof possibleDuplicatesQuerySchema>;

/**
 * What a match agreed on, in the order a person weighs them. `NAME_PARTIAL`:
 * the first and father's names agree and the family name does not — it is
 * only ever named beside other facts that agree, never alone.
 */
export const DUPLICATE_MATCHED_ON = [
  'NAME',
  'NAME_SIMILAR',
  'NAME_PARTIAL',
  'PHONE',
  'MOTHER',
  'CIVIL_RECORD',
  'RESIDENCY_NUMBER',
  'SAME_UNIT',
] as const;
export type DuplicateMatchedOn = (typeof DUPLICATE_MATCHED_ON)[number];

/** How each agreeing fact is named beside a candidate. */
export function duplicateMatchedOnLabels(locale: string): Record<DuplicateMatchedOn, string> {
  const en = locale === 'en';
  return {
    NAME: en ? 'name' : 'الاسم',
    NAME_SIMILAR: en ? 'similar name' : 'اسم مشابه',
    NAME_PARTIAL: en ? "first and father's name" : 'الاسم واسم الأب',
    PHONE: en ? 'phone' : 'الهاتف',
    MOTHER: en ? "mother's name" : 'اسم الأم',
    CIVIL_RECORD: en ? 'civil record no.' : 'رقم السجل',
    RESIDENCY_NUMBER: en ? 'residency permit' : 'رقم الإقامة',
    SAME_UNIT: en ? 'same flat' : 'الوحدة نفسها',
  };
}

export interface PossibleDuplicateMatch {
  id: string;
  referenceNumber: string | null;
  fullName: string;
  motherName: string | null;
  phone: string | null;
  residence: string | null;
  propertyCount: number;
  registeredAt: string | null;
  registeredBy: string | null;
  matchedOn: DuplicateMatchedOn[];
  /**
   * Beyond reasonable doubt the same person — the save refuses a new file for
   * an officer rather than asking (see `duplicateVerdict` on the server).
   */
  certain: boolean;
}

// ─────────────────────────────  Preview  ─────────────────────────────

/** One side of the pair, as the dialog introduces it. */
export interface CitizenMergeSide {
  id: string;
  fullName: string;
  referenceNumber: string | null;
  motherName: string | null;
  phone: string | null;
  residence: string;
  registeredAt: string | null;
  registrations: number;
  currentCards: number;
  /** Sent back as `expected` — see `citizenMergeSchema`. */
  version: string;
}

export interface CitizenMergeBlock {
  code: CitizenMergeBlockCode;
  message: string;
}

/** A field both files answer, differently. The kept file's answer stays. */
export interface CitizenMergeFieldConflict {
  field: string;
  keep: string | null;
  absorb: string | null;
}

/** A field the kept file is missing and takes from the other. */
export interface CitizenMergeFieldFill {
  field: string;
  value: string | null;
}

/** A card as the dialog names it. */
export interface CitizenMergeCardLine {
  cardId: string;
  /** Which file it was on before the merge. */
  from: 'keep' | 'absorb';
  label: string;
  unitCodes: string[];
  /** Not linked to سجل المباني — moved as it is, and worth a look afterwards. */
  unlinked: boolean;
}

/** A flat both files record: the absorbed copy ends «سُجِّل خطأً». */
export interface CitizenMergeDuplicateLine {
  label: string;
  unitCode: string | null;
  /** The officer who filed the copy that ends. */
  filedBy: string | null;
}

/** What the merge does to one officer's pay — always ≤ 0. */
export interface CitizenMergePayLine {
  officerId: string;
  officerName: string;
  /** Dollars. Negative: credit for a duplicate copy that ends. */
  delta: number;
}

/** A bill both files carry for one notice and period — left where it is. */
export interface CitizenMergeBillLine {
  paymentId: string;
  title: string;
  periodKey: string;
  amount: number;
  currency: string;
  paymentStatus: string;
}

export interface CitizenMergePreview {
  keep: CitizenMergeSide;
  absorb: CitizenMergeSide;
  blocks: CitizenMergeBlock[];
  fills: CitizenMergeFieldFill[];
  conflicts: CitizenMergeFieldConflict[];
  /** The filing that becomes the file — the newest of both. */
  newestFiling: { id: string; referenceNumber: string; from: 'keep' | 'absorb' };
  cardsMoved: CitizenMergeCardLine[];
  duplicates: CitizenMergeDuplicateLine[];
  pay: CitizenMergePayLine[];
  counts: {
    registrations: number;
    spellsMoved: number;
    spellsEnded: number;
    bills: number;
    checkouts: number;
    cases: number;
    feeNotices: number;
    tenantLinks: number;
    flagsAnswered: number;
  };
  /** Bills both files carry for the same notice and period, left on the absorbed file. */
  billsLeftBehind: CitizenMergeBillLine[];
}

export interface CitizenMergeResult {
  mergeId: string;
  keepId: string;
  absorbId: string;
  preview: CitizenMergePreview;
}

/** A merge as the kept file and the absorbed file each show it. */
export interface CitizenMergeRecord {
  id: string;
  survivor: { id: string; fullName: string; referenceNumber: string | null };
  absorbed: { id: string; fullName: string; referenceNumber: string | null };
  reason: string;
  mergedAt: string;
  mergedBy: string | null;
  undoneAt: string | null;
  undoneBy: string | null;
  undoReason: string | null;
}

export interface CitizenUnmergePreview {
  merge: CitizenMergeRecord;
  blocks: Array<{ code: CitizenUnmergeBlockCode; message: string }>;
}
