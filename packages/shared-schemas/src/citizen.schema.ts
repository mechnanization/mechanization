import { z } from 'zod';
import {
  bloodTypeSchema,
  genderSchema,
  identityDocTypeSchema,
  maritalStatusSchema,
  residentStatusSchema,
} from './enums';
import {
  arabicOrLatinName,
  civilRecordNumber,
  documentNumber,
  lebanesePhone,
} from './primitives';

/**
 * Step 1 — البيانات الشخصية ومعلومات الإثبات
 *
 * The bare object is exported alongside the validated schema because two
 * things need the *fields* without the *rules*: `partialPersonalDetailsSchema`
 * below, and nothing else — see the note there for why that separation is not
 * a second, weaker validator.
 */
export const personalDetailsObject = z.object({
  firstName: arabicOrLatinName,
  middleName: arabicOrLatinName,
  lastName: arabicOrLatinName,
  gender: genderSchema,
  bloodType: bloodTypeSchema,
  identityDocType: identityDocTypeSchema,
  identityDocNumber: documentNumber.optional().or(z.literal('')),
  civilRecordNumber: civilRecordNumber.optional().or(z.literal('')),
  nationality: z
    .string({ required_error: 'الجنسية مطلوبة' })
    .trim()
    .min(2, 'الجنسية قصيرة جداً')
    .max(60, 'الجنسية طويلة جداً'),
  isLebanese: z.boolean({ required_error: 'يرجى تحديد الجنسية' }),
  residencyNumber: documentNumber.optional().or(z.literal('')),
  residentStatus: residentStatusSchema,
});

/**
 * Four conditional rules are enforced here rather than in the UI alone:
 *  1. civilRecordNumber (رقم السجل) is a Lebanese civil-registry number — it is
 *     required for a Lebanese person and meaningless for anyone else, so it is
 *     required only when `isLebanese` is true.
 *  2. identityDocNumber is required for a Lebanese person, whichever document
 *     type they picked. Its UI label varies by doc type (see
 *     `labels.ar.identityDocNumberLabel`).
 *  3. A non-Lebanese person is not asked for both a passport number and a
 *     رقم إقامة — someone who has given the municipality either one is
 *     identifiable, and requiring the other on top would block someone who
 *     simply does not have it yet (a passport pending renewal, a residency
 *     permit still in process). At least one of identityDocNumber /
 *     residencyNumber must be present; neither is required on its own.
 *  4. residentStatus REFUGEE describes someone displaced from outside Lebanon —
 *     a Lebanese citizen cannot hold it. The UI hides the option once لبناني
 *     is chosen; this is what actually stops it reaching the server if that
 *     selection is ever bypassed or left stale from before a nationality switch.
 */
export const personalDetailsSchema = personalDetailsObject.superRefine((data, ctx) => {
  if (data.isLebanese) {
    if (!data.identityDocNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['identityDocNumber'],
        message: 'رقم الوثيقة مطلوب',
      });
    }
    if (!data.civilRecordNumber) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['civilRecordNumber'],
        message: 'رقم السجل مطلوب للبنانيين',
      });
    }
    if (data.residentStatus === 'REFUGEE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['residentStatus'],
        message: 'صفة «لاجئ» غير متاحة للمواطنين اللبنانيين',
      });
    }
    return;
  }

  if (!data.identityDocNumber && !data.residencyNumber) {
    const message = 'أدخل رقم جواز السفر أو رقم الإقامة — يكفي إدخال واحد منهما';
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['identityDocNumber'], message });
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['residencyNumber'], message });
  }
});

export type PersonalDetails = z.infer<typeof personalDetailsSchema>;

/**
 * The same fields with nothing required of them.
 *
 * This is **not** a looser rulebook. Whether a record is acceptable is still
 * decided by `personalDetailsSchema` above — a submission carrying flags is
 * validated against it and passes only if every complaint it raises lands on a
 * field the officer explicitly flagged (see `parseCitizenSubmission`). What
 * this schema does is the other half of the job: shape and normalise what
 * *is* there — a phone into E.164, a household size into an integer — once the
 * strict pass has already ruled on it.
 *
 * Built from `personalDetailsObject` rather than restated, so a field added
 * above is carried here automatically and cannot be silently dropped on the
 * way to the database.
 *
 * The three that stay required are `NON_FLAGGABLE_FIELDS` — no flag can excuse
 * them, so no shape derived from flags can make them optional. Stating it here
 * as well as there means everything downstream reads them as plain `string` /
 * `boolean` and never has to defend against an absence that cannot happen.
 */
export const partialPersonalDetailsSchema = personalDetailsObject
  .partial()
  .required({ firstName: true, lastName: true, isLebanese: true });

export type PartialPersonalDetails = z.infer<typeof partialPersonalDetailsSchema>;

/**
 * Step 2 — معلومات التواصل والأسرة
 *
 * `whatsappSameAsPhone` is a UI affordance that also carries meaning on the wire:
 * when true the backend copies `phone` rather than trusting a client-sent duplicate.
 */
export const contactDetailsObject = z.object({
  maritalStatus: maritalStatusSchema,
  phone: lebanesePhone,
  whatsappSameAsPhone: z.boolean().default(true),
  whatsapp: lebanesePhone.optional(),
  actualHouseholdMembers: z.coerce
    .number({
      required_error: 'عدد أفراد الأسرة المقيمين في المنزل مطلوب',
      invalid_type_error: 'عدد أفراد الأسرة المقيمين في المنزل يجب أن يكون رقماً',
    })
    .int('يجب أن يكون رقماً صحيحاً')
    .min(1, 'يجب تسجيل فرد واحد على الأقل')
    .max(50, 'العدد كبير جداً — يرجى مراجعة البلدية'),
  totalRegisteredMembers: z.coerce
    .number()
    .int('يجب أن يكون رقماً صحيحاً')
    .min(1)
    .max(50)
    .optional(),
  familySize: z.coerce
    .number()
    .int('يجب أن يكون رقماً صحيحاً')
    .min(1)
    .max(50)
    .optional(),
});

export const contactDetailsSchema = contactDetailsObject
  .transform((data) => {
    const actual = data.actualHouseholdMembers ?? data.familySize;
    return {
      ...data,
      actualHouseholdMembers: actual,
      totalRegisteredMembers: data.totalRegisteredMembers ?? actual,
      whatsapp: data.whatsappSameAsPhone ? data.phone : data.whatsapp,
    };
  })
  .superRefine((data, ctx) => {
    if (!data.whatsappSameAsPhone && !data.whatsapp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['whatsapp'],
        message: 'رقم الواتساب مطلوب',
      });
    }
    if (
      data.actualHouseholdMembers != null &&
      data.totalRegisteredMembers != null &&
      data.actualHouseholdMembers > data.totalRegisteredMembers
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualHouseholdMembers'],
        message: 'عدد الأفراد الفعليين لا يمكن أن يتجاوز إجمالي المسجلين في القيد',
      });
    }
  });

export type ContactDetails = z.infer<typeof contactDetailsSchema>;

/**
 * Contact details with nothing required — the counterpart of
 * `partialPersonalDetailsSchema`, and the same division of labour.
 *
 * The copy-from-phone rule is kept because it is normalisation rather than
 * validation: `whatsappSameAsPhone` describes what the officer *meant*, and
 * dropping it here would store a null WhatsApp number for a household that has
 * one. An absent `whatsappSameAsPhone` reads as true, exactly as its default
 * does on the strict schema; when the phone itself is flagged there is nothing
 * to copy and both end up empty, which is the honest outcome.
 */
export const partialContactDetailsSchema = contactDetailsObject
  .partial()
  .transform((data) => {
    const actual = data.actualHouseholdMembers ?? data.familySize;
    return {
      ...data,
      actualHouseholdMembers: actual,
      totalRegisteredMembers: data.totalRegisteredMembers ?? actual,
      whatsapp: data.whatsappSameAsPhone === false ? data.whatsapp : (data.phone ?? data.whatsapp),
    };
  });

export type PartialContactDetails = z.infer<typeof partialContactDetailsSchema>;
