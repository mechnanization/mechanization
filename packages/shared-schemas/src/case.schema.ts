import { z } from 'zod';
import { caseTypeSchema, landTypeSchema, propertyTypeSchema } from './enums';
import { uuid } from './primitives';

/**
 * حالات — field visits that could not become a citizen registration.
 *
 * Nobody home, the gate was locked, access was refused: whatever staff could
 * observe about the property from outside is worth keeping so the next visit
 * does not start from zero. Every field but `notes` is optional on purpose —
 * a case is definitionally the record of what could *not* be fully
 * established, so demanding the rest of the citizen-registration taxonomy
 * here would just move the blocker from "can't register" to "can't even log
 * that I tried".
 */

/**
 * Where a حالة stands.
 *
 * `SCHEDULED` is the state that was missing and was being carried in someone's
 * head: a case an officer has already agreed a return date for is neither open
 * work waiting to be picked up nor settled, and leaving it `OPEN` meant every
 * dispatch list re-proposed a visit that was already arranged. It is a
 * *promise*, not an outcome — `scheduledRevisitAt` on the case carries the date
 * — and the only way out of it is still `RESOLVED`.
 *
 * Ordered as the work moves, which is also the order the tabs render in.
 */
export const CASE_STATUS = ['OPEN', 'SCHEDULED', 'RESOLVED'] as const;
export type CaseStatus = (typeof CASE_STATUS)[number];

const notesField = z
  .string({ required_error: 'وصف الحالة مطلوب' })
  .trim()
  .min(3, 'وصف الحالة قصير جداً')
  .max(500, 'وصف الحالة طويل جداً');

const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * The census links a case may carry.
 *
 * All optional, and they do not replace the free-text `buildingName`/`floor`
 * above. On a parcel whose buildings have not been surveyed yet — which is most
 * of them, most of the time — the free text is the only thing an officer at a
 * door can write down. These are the *resolved* form, set when the case can be
 * attached to rows, and they are what turn "every open case in this building"
 * from a string search into a query.
 */
const censusLinks = {
  caseType: caseTypeSchema.optional(),
  buildingId: uuid.optional(),
  unitId: uuid.optional(),
  damageAssessmentId: uuid.optional(),
  /**
   * When someone has agreed to go back.
   *
   * Not required by `SCHEDULED` and not forbidden without it. A date with no
   * status is an officer noting an intention before committing to it, and a
   * `SCHEDULED` with no date is a revisit agreed as "next week" — both are real
   * things a doorstep produces, and refusing either would only move the loss
   * from the record to the officer's memory.
   */
  scheduledRevisitAt: z.coerce
    .date({ invalid_type_error: 'تاريخ الزيارة غير صالح' })
    .optional(),
};

export const createCaseSchema = z.object({
  notes: notesField,
  propertyNumber: optionalText(40),
  neighborhood: optionalText(80),
  propertyType: propertyTypeSchema.optional(),
  buildingName: optionalText(120),
  floor: optionalText(20),
  side: optionalText(60),
  landType: landTypeSchema.optional(),
  tentLocation: optionalText(200),
  ...censusLinks,
});

export type CreateCaseInput = z.infer<typeof createCaseSchema>;

/**
 * Which fields apply to a case once نوع العقار is chosen — the same idea as
 * `PROPERTY_FIELD_MAP` in `property.schema.ts`, trimmed to what a case can
 * actually carry: no `units`, no `sharedRights`, no `unitArea` — a case is a
 * quick note from the doorstep, not a full survey. `neighborhood` and
 * `propertyNumber` apply to every type and are asked before a type is even
 * picked, so they are not repeated here.
 */
export const CASE_FIELD_MAP = {
  BUILDING: ['buildingName', 'floor'],
  HOUSE: ['buildingName', 'side'],
  LAND: ['landType'],
  TENT: ['tentLocation'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Every field optional, but at least one present — a PATCH carrying nothing
 * is a caller bug, and silently returning the unchanged case would hide it.
 */
export const updateCaseSchema = z
  .object({
    notes: notesField.optional(),
    propertyNumber: optionalText(40).nullable(),
    neighborhood: optionalText(80).nullable(),
    propertyType: propertyTypeSchema.optional(),
    buildingName: optionalText(120).nullable(),
    floor: optionalText(20).nullable(),
    side: optionalText(60).nullable(),
    landType: landTypeSchema.optional(),
    tentLocation: optionalText(200).nullable(),
    status: z.enum(CASE_STATUS).optional(),
    caseType: caseTypeSchema.optional(),
    buildingId: uuid.nullable().optional(),
    unitId: uuid.nullable().optional(),
    damageAssessmentId: uuid.nullable().optional(),
    scheduledRevisitAt: z.coerce
      .date({ invalid_type_error: 'تاريخ الزيارة غير صالح' })
      .nullable()
      .optional(),
    /**
     * The bridge to the citizen registry. Setting this always resolves the
     * case (see `CasesService.update`); passing `null` only clears the link
     * — it does not reopen a case someone marked resolved another way.
     */
    resolvedCitizenId: uuid.nullable().optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'لا يوجد أي تغيير لحفظه',
  });

export type UpdateCaseInput = z.infer<typeof updateCaseSchema>;
