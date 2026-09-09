import { z } from 'zod';
import { landTypeSchema, propertyTypeSchema } from './enums';
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
