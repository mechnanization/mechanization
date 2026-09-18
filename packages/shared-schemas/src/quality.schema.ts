import { z } from 'zod';
import { uuid } from './primitives';

/**
 * «مراجعة الجودة» — the second pair of eyes on field records.
 *
 * Three things a supervisor does and one thing an officer does, each a small
 * input. The findings themselves are derived on the server and have no input.
 */

/**
 * What a supervisor can say was wrong when returning a record.
 *
 * Coded rather than free text so the officer's screen can point at the part of
 * the form, and so «how often is the area wrong» is a count rather than a
 * reading of sentences. The reason sentence is still required beside them.
 */
export const REVIEW_FIELD = [
  'NAME',
  'MOTHER_NAME',
  'PHONE',
  'HOUSEHOLD',
  'RESIDENCE',
  'PROPERTY',
  'OCCUPANCY_ROLE',
  'UNIT_LINK',
  'AREA',
  'UNIT_STATUS',
  'LANDLORD',
  'DUPLICATE',
  'OTHER',
] as const;
export type ReviewField = (typeof REVIEW_FIELD)[number];

/** What a re-check on the ground can find different. */
export const CHECK_DIFFERENCE = [
  'PERSON_NOT_THERE',
  'NAME',
  'PHONE',
  'HOUSEHOLD',
  'OCCUPANCY_ROLE',
  'UNIT_STATUS',
  'AREA',
  'UNIT_OR_BUILDING',
  'LANDLORD',
  'OTHER',
] as const;
export type CheckDifference = (typeof CHECK_DIFFERENCE)[number];

const reason = (message: string) =>
  z.string({ required_error: message }).trim().min(4, message).max(500, 'النص طويل جداً');

export const returnRecordSchema = z.object({
  reason: reason('يرجى كتابة ما يجب على الموظف تصحيحه'),
  fields: z.array(z.enum(REVIEW_FIELD)).min(1, 'اختر ما يحتاج إلى تصحيح').max(REVIEW_FIELD.length),
});
export type ReturnRecordInput = z.infer<typeof returnRecordSchema>;

export const drawSampleSchema = z
  .object({
    from: z.coerce.date({ invalid_type_error: 'تاريخ البداية غير صالح' }),
    to: z.coerce.date({ invalid_type_error: 'تاريخ النهاية غير صالح' }),
    /** Share of each officer's records in the period, never fewer than one where they filed any. */
    percent: z.coerce.number().int().min(1, 'النسبة ١٪ على الأقل').max(50, 'النسبة ٥٠٪ على الأكثر').default(5),
  })
  .refine((value) => value.from <= value.to, { message: 'تاريخ البداية بعد النهاية', path: ['from'] });
export type DrawSampleInput = z.infer<typeof drawSampleSchema>;

export const assignCheckSchema = z.object({ assignedToId: uuid.nullable() });
export type AssignCheckInput = z.infer<typeof assignCheckSchema>;

export const completeCheckSchema = z
  .object({
    result: z.enum(['MATCHES', 'DIFFERS']),
    differences: z.array(z.enum(CHECK_DIFFERENCE)).max(CHECK_DIFFERENCE.length).default([]),
    notes: z.string().trim().max(1000, 'الملاحظات طويلة جداً').optional(),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'DIFFERS' && value.differences.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['differences'], message: 'اختر ما وجدته مختلفاً' });
    }
    if (value.result === 'DIFFERS' && !value.notes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['notes'], message: 'اكتب ما وجدته على الأرض' });
    }
  });
export type CompleteCheckInput = z.infer<typeof completeCheckSchema>;

/** The kinds of finding the server derives. */
export const QUALITY_FINDING_KIND = [
  'DUPLICATE_CITIZEN',
  'HELD_AS_POSSIBLE_DUPLICATE',
  'OCCUPANT_HAS_LANDLORD_PHONE',
  'NEAR_DUPLICATE_BUILDINGS',
  'UNIT_STATUS_CONTRADICTION',
  'BUILDING_WITHOUT_PIN',
  'UNITS_WITHOUT_AREA',
  'UNLINKED_LANDLORDS',
] as const;
export type QualityFindingKind = (typeof QUALITY_FINDING_KIND)[number];

export const dismissFindingSchema = z.object({
  kind: z.enum(QUALITY_FINDING_KIND),
  subjectKey: z.string().trim().min(1).max(500),
  reason: reason('يرجى ذكر سبب اعتبارها ليست مشكلة'),
});
export type DismissFindingInput = z.infer<typeof dismissFindingSchema>;

export function qualityLabels(locale: string) {
  const en = locale === 'en';
  return {
    reviewField: {
      NAME: en ? 'Name' : 'الاسم',
      MOTHER_NAME: en ? "Mother's name" : 'اسم الأم',
      PHONE: en ? 'Phone / WhatsApp' : 'الهاتف / الواتساب',
      HOUSEHOLD: en ? 'Household' : 'أفراد الأسرة',
      RESIDENCE: en ? 'Residence' : 'الإقامة',
      PROPERTY: en ? 'Property details' : 'بيانات العقار',
      OCCUPANCY_ROLE: en ? 'Occupancy role' : 'صفة الإشغال',
      UNIT_LINK: en ? 'Building / unit link' : 'ربط المبنى والوحدة',
      AREA: en ? 'Area' : 'المساحة',
      UNIT_STATUS: en ? 'Unit status' : 'حالة الوحدة',
      LANDLORD: en ? 'Landlord' : 'المالك',
      DUPLICATE: en ? 'Duplicate record' : 'سجل مكرر',
      OTHER: en ? 'Other' : 'أخرى',
    } satisfies Record<ReviewField, string>,
    checkDifference: {
      PERSON_NOT_THERE: en ? 'Person not found there' : 'الشخص غير موجود في المكان',
      NAME: en ? 'Name' : 'الاسم',
      PHONE: en ? 'Phone' : 'الهاتف',
      HOUSEHOLD: en ? 'Household' : 'أفراد الأسرة',
      OCCUPANCY_ROLE: en ? 'Occupancy role' : 'صفة الإشغال',
      UNIT_STATUS: en ? 'Unit status' : 'حالة الوحدة',
      AREA: en ? 'Area' : 'المساحة',
      UNIT_OR_BUILDING: en ? 'Unit or building' : 'الوحدة أو المبنى',
      LANDLORD: en ? 'Landlord' : 'المالك',
      OTHER: en ? 'Other' : 'أخرى',
    } satisfies Record<CheckDifference, string>,
    findingKind: {
      DUPLICATE_CITIZEN: en ? 'Same person filed twice' : 'شخص مسجَّل مرتين',
      HELD_AS_POSSIBLE_DUPLICATE: en ? 'Filed offline, looks registered' : 'سجل وصل دون اتصال ويبدو مسجَّلاً',
      OCCUPANT_HAS_LANDLORD_PHONE: en ? "Occupant carries the owner's number" : 'رقم الشاغل هو رقم المالك',
      NEAR_DUPLICATE_BUILDINGS: en ? 'Buildings metres apart on one parcel' : 'مبانٍ متلاصقة على العقار نفسه',
      UNIT_STATUS_CONTRADICTION: en ? 'Unit and owner card disagree' : 'حالة الوحدة تخالف بطاقة المالك',
      BUILDING_WITHOUT_PIN: en ? 'Building with no entrance pin' : 'مبنى بلا مدخل مُثبت',
      UNITS_WITHOUT_AREA: en ? 'Occupied units with no area' : 'وحدات مشغولة بلا مساحة',
      UNLINKED_LANDLORDS: en ? 'Owners named but not linked' : 'مالكون مذكورون غير مربوطين',
    } satisfies Record<QualityFindingKind, string>,
    /**
     * What the re-check found, as one word.
     *
     * Shared rather than written where it is shown: the check panel and the
     * activity trail must call the same outcome by the same name, or an
     * auditor reading «مختلف» on one screen and something else on the other
     * has to work out whether they are the same thing.
     */
    checkResult: {
      MATCHES: en ? 'Matches' : 'مطابق',
      DIFFERS: en ? 'Differs' : 'مختلف',
    } satisfies Record<'MATCHES' | 'DIFFERS', string>,
  };
}
