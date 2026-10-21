import { z } from 'zod';
import { normalizeDigits } from './primitives';

/**
 * Administrative sectors (قطاع) a municipality draws over its own cadastre.
 *
 * The same shapes validate the request server-side and drive the editor's
 * inline errors client-side, so a zone the form accepts is a zone the API
 * accepts — the two cannot drift into disagreeing about what is valid.
 */

/** Matches the رقم العقار field the citizen form validates against: saved in Latin digits (`propertyNumberField`). */
const parcelNumberField = z
  .string({ required_error: 'رقم العقار مطلوب' })
  .trim()
  .min(1, 'رقم العقار مطلوب')
  .max(40)
  .transform((value) => normalizeDigits(value));

const zoneColorField = z
  .string({ required_error: 'لون القطاع مطلوب' })
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, 'اللون يجب أن يكون بصيغة #RRGGBB');

/**
 * Uppercased on the way in so "sec-a1" and "SEC-A1" cannot both be created and
 * then read as two different sectors in a report.
 */
const zoneCodeField = z
  .string({ required_error: 'رمز القطاع مطلوب' })
  .trim()
  .min(2, 'رمز القطاع قصير جداً')
  .max(24, 'رمز القطاع طويل جداً')
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'رمز القطاع يقبل الأحرف والأرقام والشرطة فقط')
  .transform((value) => value.toUpperCase());

const zoneNameField = z
  .string({ required_error: 'اسم القطاع مطلوب' })
  .trim()
  .min(2, 'اسم القطاع قصير جداً')
  .max(120, 'اسم القطاع طويل جداً');

/**
 * Duplicates are collapsed rather than rejected: the editor's box-select can
 * legitimately sweep a parcel the admin already clicked, and failing the save
 * over it would punish them for a gesture that expressed the right intent.
 */
const parcelNumbersField = z
  .array(parcelNumberField)
  .max(20_000, 'عدد العقارات كبير جداً')
  .transform((values) => [...new Set(values)]);

export const createZoneSchema = z.object({
  name: zoneNameField,
  code: zoneCodeField,
  color: zoneColorField.default('#3B82F6'),
  description: z.string().trim().max(500, 'الوصف طويل جداً').optional(),
  parcelNumbers: parcelNumbersField.default([]),
});

export type CreateZoneInput = z.infer<typeof createZoneSchema>;

/**
 * Every field optional, but at least one present — a PUT carrying nothing is a
 * caller bug, and silently returning the unchanged zone would hide it.
 */
export const updateZoneSchema = z
  .object({
    name: zoneNameField.optional(),
    code: zoneCodeField.optional(),
    color: zoneColorField.optional(),
    description: z.string().trim().max(500, 'الوصف طويل جداً').nullable().optional(),
    parcelNumbers: parcelNumbersField.optional(),
  })
  .refine((value) => Object.values(value).some((v) => v !== undefined), {
    message: 'لا يوجد أي تغيير لحفظه',
  });

export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;
