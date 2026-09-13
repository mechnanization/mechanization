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
  internationalPhone,
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
  /*
    No longer asked. The form stopped collecting an identity document on
    2026-09-13: officers had been told it was not required and filled it with
    shared or invented numbers, and because citizens were matched on it, every
    repeated number merged a different person into whoever used it first.

    Kept optional rather than removed, for two reasons. Real records already
    hold real numbers and none of them may be lost — an edit that no longer
    sends the field leaves the stored value alone (`CitizensService.update`).
    And a non-Lebanese person's passport number still travels in
    `identityDocNumber`, under `PASSPORT`.
  */
  identityDocType: identityDocTypeSchema.optional(),
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
 * Two conditional rules are enforced here rather than in the UI alone:
 *  1. civilRecordNumber (رقم السجل) is a Lebanese civil-registry number — it is
 *     required for a Lebanese person and meaningless for anyone else, so it is
 *     required only when `isLebanese` is true.
 *  2. residentStatus REFUGEE describes someone displaced from outside Lebanon —
 *     a Lebanese citizen cannot hold it. The UI hides the option once لبناني
 *     is chosen; this is what actually stops it reaching the server if that
 *     selection is ever bypassed or left stale from before a nationality switch.
 *
 * Two rules that used to be here are gone, deliberately. A Lebanese person is
 * no longer asked for an identity document at all (see `identityDocType`), and
 * a non-Lebanese person may leave both the passport number and the رقم إقامة
 * empty: the form labels them «إلزامي إن وجد» — to be written down when the
 * person has one, never to be invented when they do not. A required number is
 * exactly what produced the invented ones.
 */
export const personalDetailsSchema = personalDetailsObject.superRefine((data, ctx) => {
  if (data.isLebanese) {
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
  phone: internationalPhone,
  whatsappSameAsPhone: z.boolean().default(true),
  whatsapp: internationalPhone.optional(),
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
    .min(1, 'يجب تسجيل فرد واحد على الأقل لكل قيد عائلي')
    .max(50, 'العدد كبير جداً — يرجى مراجعة البلدية')
    .optional(),
  familySize: z.coerce
    .number()
    .int('يجب أن يكون رقماً صحيحاً')
    .min(1)
    .max(50)
    .optional(),
});

export const contactDetailsSchema = contactDetailsObject
  .transform((data) => ({
    ...data,
    whatsapp: data.whatsappSameAsPhone ? data.phone : data.whatsapp,
  }))
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
  .transform((data) => ({
    ...data,
    whatsapp: data.whatsappSameAsPhone === false ? data.whatsapp : (data.phone ?? data.whatsapp),
  }))
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

// ─────────────  «غير مقيم في البلدة» — a non-resident record  ─────────────

/**
 * What the register keeps about a person who lives outside the town and owns,
 * rents or runs something in it — «غير مقيم في البلدة». The names still say
 * «owner» because the record began as an owner record; see `CITIZEN_RESIDENCE`.
 *
 * A short record, not a household file with its gaps flagged. The rental-value
 * fee falls on whoever occupies the unit (Law 60/1988, Art. 3–4); what the law
 * wants of an owner is their name on the assessment roll (Art. 17) and where
 * they live (Art. 14). So this asks exactly that — a name, how to reach them,
 * where they live, and optionally somebody local who holds the keys — and
 * nothing a household file asks: no identity document, no رقم السجل, no blood
 * type, no marital status, no household counts, no صفة الإقامة.
 *
 * Filed as a full household with «حفظ سريع» instead, the same owner would sit in
 * «يتطلب مراجعة» for ever over fields that are missing *on purpose*, and صفة
 * الإقامة offers no true answer for someone who lives in Abidjan.
 *
 * اسم الأب is asked and not required: the person answering is often a tenant or
 * a neighbour who knows the owner's name and number and nothing else.
 */
export const nonResidentOwnerPersonalSchema = z.object({
  firstName: arabicOrLatinName,
  middleName: arabicOrLatinName.optional().or(z.literal('')),
  lastName: arabicOrLatinName,
  /** Town or country — «بيروت»، «ساحل العاج». Free text: there is no list to pick from. */
  residencePlace: z
    .string({ required_error: 'مكان الإقامة مطلوب' })
    .trim()
    .min(2, 'مكان الإقامة قصير جداً')
    .max(80, 'مكان الإقامة طويل جداً'),
});

/** Same division of labour as `partialPersonalDetailsSchema`: shape, not rules. */
export const partialNonResidentOwnerPersonalSchema = nonResidentOwnerPersonalSchema
  .partial()
  .required({ firstName: true, lastName: true });

/**
 * How to reach an owner who is not here.
 *
 * The phone is required because reaching them is why the record exists — and it
 * is flaggable like any other field, for the owner whose tenant knows a name and
 * no number. The local contact is the relative or caretaker with the keys: a
 * contact, not a person the register tracks, so two strings rather than a link
 * to another citizen.
 */
const nonResidentOwnerContactObject = z.object({
  phone: internationalPhone,
  whatsappSameAsPhone: z.boolean().default(true),
  whatsapp: internationalPhone.optional(),
  localContactName: z.string().trim().max(120, 'الاسم طويل جداً').optional(),
  localContactPhone: internationalPhone.optional().or(z.literal('')),
});

export const nonResidentOwnerContactSchema = nonResidentOwnerContactObject
  .transform((data) => ({
    ...data,
    whatsapp: data.whatsappSameAsPhone ? data.phone : data.whatsapp,
    localContactName: data.localContactName || undefined,
    localContactPhone: data.localContactPhone || undefined,
  }))
  .superRefine((data, ctx) => {
    if (!data.whatsappSameAsPhone && !data.whatsapp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['whatsapp'],
        message: 'رقم الواتساب مطلوب',
      });
    }
  });

export const partialNonResidentOwnerContactSchema = nonResidentOwnerContactObject
  .partial()
  .transform((data) => ({
    ...data,
    whatsapp: data.whatsappSameAsPhone === false ? data.whatsapp : (data.phone ?? data.whatsapp),
    localContactName: data.localContactName || undefined,
    localContactPhone: data.localContactPhone || undefined,
  }));
