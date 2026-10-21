import { z } from 'zod';
import { normalizeDigits } from './primitives';

/**
 * What is left of the old submission schema: the رقم العقار lookup.
 *
 * Everything else in this file described the citizen-facing طلب and the
 * municipality's adjudication of it — `submitRegistrationSchema` (the six-step
 * wizard payload, with its document slots and its الإقرار), `changeStatusSchema`
 * (the reviewer's transition), and `REJECTABLE_FIELDS` (the field-by-field
 * rejection vocabulary the reviewer picked from and the applicant's correction
 * form resolved back to captions).
 *
 * None of it has a subject any more. Records are entered by staff from
 * documents handed across a counter, so there is no submission to validate at
 * the door, no decision to record against it, and no citizen waiting to be
 * told which field to fix. The property-number check survives because it is
 * about the *cadastre*, not about a طلب: it answers "is this a real parcel in
 * this municipality", which the staff entry form asks on every keystroke.
 */

/** Blur-check used by the property card while a رقم العقار is typed. */
export const propertyNumberCheckSchema = z.object({
  propertyNumber: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .transform((value) => normalizeDigits(value)),
});

/**
 * `inCadastre` is null for a municipality that has not imported its cadastre,
 * so the form knows to stay quiet rather than claim the number is invalid.
 */
export const propertyNumberCheckResponseSchema = z.object({
  propertyNumber: z.string(),
  inCadastre: z.boolean().nullable(),
  location: z
    .object({
      latitude: z.number(),
      longitude: z.number(),
      approximate: z.boolean(),
    })
    .nullable(),
  suggestions: z.array(z.string()).default([]),
  /**
   * Neighbours already registered on this parcel. Informational only — a
   * building shares one cadastral number, so this never blocks an entry.
   */
  registeredCount: z.number().int().nonnegative().default(0),
});

export type PropertyNumberCheckResponse = z.infer<typeof propertyNumberCheckResponseSchema>;
