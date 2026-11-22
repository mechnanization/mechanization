import { z } from 'zod';
import { typeError } from './type-error';
import {
  REQUEST_FIELD_TYPE,
  applicantCapacitySchema,
  requestAttachmentTypeSchema,
  requestPropertyModeSchema,
  type ApplicantCapacity,
  type RequestAnswerOrigin,
  type RequestFieldType,
  type RequestFormVersionStatus,
  type RequestLinkedSource,
  type RequestPropertyMode,
  type RequestType,
} from './enums';
import {
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_ATTACHMENT_MAX_BYTES,
  REQUEST_ATTACHMENT_MIME_TYPES,
  requestFeeAmountSchema,
  submitCounterRequestSchema,
  submitOnlineRequestSchema,
} from './citizen-request.schema';
import { isCalendarDay } from './primitives';

/**
 * Request forms — a form the manager defines (its questions and its fee) that a
 * citizen fills in online and a clerk at the counter. Design:
 * docs/request-forms-plan.md; the decisions F1–F12: docs/open-decisions.md §24;
 * the tables: tenant migrations 0112 and 0113.
 *
 * Laid out like `citizen-request.schema.ts`: the rules both apps read, then the
 * inputs, then the views. The answers validator is `request-form-answers.ts`,
 * which reads the field definitions defined here.
 */

// ─── rules both apps read ───

/** At most this many questions a version (CHECK `request_form_fields_position_range`: positions 0–39). */
export const REQUEST_FORM_MAX_FIELDS = 40;
export const REQUEST_FORM_NAME_MAX = 200;
export const REQUEST_FIELD_LABEL_MAX = 200;
export const REQUEST_FIELD_HELP_MAX = 500;
export const REQUEST_FORM_TEMPLATE_MAX = 5000;
export const REQUEST_FORM_MAX_CHOICES = 50;

/** A field's key, and a choice's: stable, lower snake case, starting with a letter (CHECK `request_form_fields_key_shape`). */
export const REQUEST_FIELD_KEY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;

/** The longest a short and a long text answer may be. */
export const REQUEST_SHORT_TEXT_MAX = 500;
export const REQUEST_LONG_TEXT_MAX = 5000;

/** A number answer's bound: far below what a JSON number holds exactly. */
export const REQUEST_NUMBER_BOUND = 999_999_999_999;

/** The most decimal places a decimal question may ask for. */
export const REQUEST_DECIMALS_MAX = 4;

/**
 * Where a linked field's value is read from, by the field's type (CHECK
 * `request_form_fields_linked_source_type`): a name part is short text, a phone is a phone,
 * an identity or civil record number is a document number.
 */
export const REQUEST_LINKED_SOURCE_TYPE = {
  FIRST_NAME: 'SHORT_TEXT',
  FATHER_NAME: 'SHORT_TEXT',
  LAST_NAME: 'SHORT_TEXT',
  MOTHER_NAME: 'SHORT_TEXT',
  PHONE: 'PHONE',
  IDENTITY_NUMBER: 'DOCUMENT_NUMBER',
  CIVIL_RECORD_NUMBER: 'DOCUMENT_NUMBER',
} as const satisfies Record<RequestLinkedSource, RequestFieldType>;

// ─── field definitions: a discriminated union by type, each with its own safe options ───

const keyMessage = 'المفتاح أحرف لاتينية صغيرة وأرقام و _ ويبدأ بحرف';
const keySchema = z.string(typeError({ required: 'اكتب مفتاح السؤال' })).regex(REQUEST_FIELD_KEY_PATTERN, keyMessage);

const requiredText = (max: number, required: string, tooLong: string) =>
  z.string(typeError({ required })).trim().min(1, required).max(max, tooLong);

/** Optional text: blank is no text. */
const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .optional()
    .transform((value) => (value ? value : undefined));

const wholeNumber = (message: string) =>
  z.number(typeError({ invalid: message })).int(message).min(-REQUEST_NUMBER_BOUND, message).max(REQUEST_NUMBER_BOUND, message);

const calendarDay = z
  .string()
  .refine((value) => isCalendarDay(value), 'اكتب تاريخاً صحيحاً بصيغة YYYY-MM-DD');

/** Every config is strict: a key the catalogue does not know is refused, never carried. */
const emptyConfig = z.object({}).strict().default({});

const shortTextConfig = z
  .object({
    minLength: z.number().int().min(0).max(REQUEST_SHORT_TEXT_MAX).optional(),
    maxLength: z.number().int().min(1).max(REQUEST_SHORT_TEXT_MAX).optional(),
  })
  .strict()
  .refine((c) => c.minLength === undefined || c.maxLength === undefined || c.minLength <= c.maxLength, 'الحد الأدنى للطول أكبر من الأقصى')
  .default({});

const longTextConfig = z
  .object({
    minLength: z.number().int().min(0).max(REQUEST_LONG_TEXT_MAX).optional(),
    maxLength: z.number().int().min(1).max(REQUEST_LONG_TEXT_MAX).optional(),
  })
  .strict()
  .refine((c) => c.minLength === undefined || c.maxLength === undefined || c.minLength <= c.maxLength, 'الحد الأدنى للطول أكبر من الأقصى')
  .default({});

const integerConfig = z
  .object({ min: wholeNumber('الحد الأدنى غير صالح').optional(), max: wholeNumber('الحد الأقصى غير صالح').optional() })
  .strict()
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, 'الحد الأدنى أكبر من الأقصى')
  .default({});

const boundedNumber = (message: string) =>
  z.number(typeError({ invalid: message })).finite(message).min(-REQUEST_NUMBER_BOUND, message).max(REQUEST_NUMBER_BOUND, message);

const decimalConfig = z
  .object({
    min: boundedNumber('الحد الأدنى غير صالح').optional(),
    max: boundedNumber('الحد الأقصى غير صالح').optional(),
    decimals: z.number().int().min(1).max(REQUEST_DECIMALS_MAX).default(2),
  })
  .strict()
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, 'الحد الأدنى أكبر من الأقصى')
  .default({ decimals: 2 });

const dateConfig = z
  .object({ min: calendarDay.optional(), max: calendarDay.optional() })
  .strict()
  .refine((c) => c.min === undefined || c.max === undefined || c.min <= c.max, 'التاريخ الأدنى بعد الأقصى')
  .default({});

const choiceSchema = z
  .object({
    key: keySchema,
    labelAr: requiredText(REQUEST_FIELD_LABEL_MAX, 'اكتب نص الخيار', 'نص الخيار طويل جداً'),
    labelEn: optionalText(REQUEST_FIELD_LABEL_MAX, 'نص الخيار طويل جداً'),
  })
  .strict();

const choicesSchema = z
  .array(choiceSchema)
  .min(2, 'السؤال بالاختيار يحتاج خيارين على الأقل')
  .max(REQUEST_FORM_MAX_CHOICES, `الخيارات حتى ${REQUEST_FORM_MAX_CHOICES} خياراً`)
  .superRefine((choices, ctx) => {
    const seen = new Set<string>();
    choices.forEach((choice, index) => {
      if (seen.has(choice.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'key'], message: 'مفتاح الخيار مكرر' });
      }
      seen.add(choice.key);
    });
  });

const singleChoiceConfig = z.object({ choices: choicesSchema }).strict();

const multiChoiceConfig = z
  .object({
    choices: choicesSchema,
    minSelected: z.number().int().min(1).max(REQUEST_FORM_MAX_CHOICES).optional(),
    maxSelected: z.number().int().min(1).max(REQUEST_FORM_MAX_CHOICES).optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const { minSelected, maxSelected, choices } = config;
    if (minSelected !== undefined && minSelected > choices.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minSelected'], message: 'الحد الأدنى أكبر من عدد الخيارات' });
    }
    if (maxSelected !== undefined && maxSelected > choices.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['maxSelected'], message: 'الحد الأقصى أكبر من عدد الخيارات' });
    }
    if (minSelected !== undefined && maxSelected !== undefined && minSelected > maxSelected) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['minSelected'], message: 'الحد الأدنى أكبر من الأقصى' });
    }
  });

/**
 * A file question: the kind of paper it is (the type the request's papers already carry, so the
 * identity-copy rule of D2 can be met by a field), how many, and which file kinds. Never beyond what
 * a request takes: the size stays `REQUEST_ATTACHMENT_MAX_BYTES` and no form promises more than
 * `REQUEST_ATTACHMENTS_MAX` papers, so neither is a setting.
 */
const fileConfig = z
  .object({
    attachmentType: requestAttachmentTypeSchema.default('OTHER'),
    maxFiles: z.number().int().min(1).max(REQUEST_ATTACHMENTS_MAX, `حتى ${REQUEST_ATTACHMENTS_MAX} ملفات`).default(1),
    accept: z
      .array(z.enum(REQUEST_ATTACHMENT_MIME_TYPES))
      .min(1, 'اختر نوع ملف واحداً على الأقل')
      .superRefine((kinds, ctx) => {
        if (new Set(kinds).size !== kinds.length) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'نوع الملف مكرر' });
        }
      })
      .default([...REQUEST_ATTACHMENT_MIME_TYPES]),
  })
  .strict()
  .default({ attachmentType: 'OTHER', maxFiles: 1, accept: [...REQUEST_ATTACHMENT_MIME_TYPES] });

/** The size a file question's papers may be, for the screen: always the request's own limit. */
export const REQUEST_FILE_FIELD_MAX_BYTES = REQUEST_ATTACHMENT_MAX_BYTES;

const fieldBase = {
  key: keySchema,
  labelAr: requiredText(REQUEST_FIELD_LABEL_MAX, 'اكتب نص السؤال', 'نص السؤال طويل جداً'),
  labelEn: optionalText(REQUEST_FIELD_LABEL_MAX, 'نص السؤال طويل جداً'),
  helpAr: optionalText(REQUEST_FIELD_HELP_MAX, 'نص المساعدة طويل جداً'),
  helpEn: optionalText(REQUEST_FIELD_HELP_MAX, 'نص المساعدة طويل جداً'),
};

/** A linked source is allowed on one type only (`REQUEST_LINKED_SOURCE_TYPE`). */
const linkedTo = <const S extends readonly RequestLinkedSource[]>(sources: S) =>
  z.enum(sources as unknown as [S[number], ...S[number][]]).nullish().transform((value) => value ?? null);

/** A field that cannot be linked to the file. */
const unlinked = z.null().optional().transform(() => null);

const define = <T extends RequestFieldType, C extends z.ZodType, L extends z.ZodType>(type: T, config: C, linkedSource: L) =>
  z.object({ ...fieldBase, type: z.literal(type), config, linkedSource }).strict();

export const requestFormFieldSchema = z.discriminatedUnion('type', [
  define('SHORT_TEXT', shortTextConfig, linkedTo(['FIRST_NAME', 'FATHER_NAME', 'LAST_NAME', 'MOTHER_NAME'] as const)),
  define('LONG_TEXT', longTextConfig, unlinked),
  define('INTEGER', integerConfig, unlinked),
  define('DECIMAL', decimalConfig, unlinked),
  define('DATE', dateConfig, unlinked),
  define('PHONE', emptyConfig, linkedTo(['PHONE'] as const)),
  define('DOCUMENT_NUMBER', emptyConfig, linkedTo(['IDENTITY_NUMBER', 'CIVIL_RECORD_NUMBER'] as const)),
  define('SINGLE_CHOICE', singleChoiceConfig, unlinked),
  define('MULTI_CHOICE', multiChoiceConfig, unlinked),
  define('YES_NO', emptyConfig, unlinked),
  define('FILE', fileConfig, unlinked),
]);
/** One question as the manager defines it, and as a version stores it. */
export type RequestFormFieldDefinition = z.infer<typeof requestFormFieldSchema>;

/** The definition of one type, narrowed. */
export type RequestFieldOf<T extends RequestFieldType> = Extract<RequestFormFieldDefinition, { type: T }>;

/** Every type the catalogue has a definition for: a type added to the enum without one fails typecheck here. */
export const REQUEST_FIELD_TYPES_DEFINED: readonly RequestFieldType[] = REQUEST_FIELD_TYPE;

// ─── inputs ───

/** A form's own settings, which the manager can change at any time (they are not versioned: F2). */
const formSettings = {
  nameAr: requiredText(REQUEST_FORM_NAME_MAX, 'اكتب اسم النموذج', 'اسم النموذج طويل جداً'),
  nameEn: optionalText(REQUEST_FORM_NAME_MAX, 'اسم النموذج طويل جداً'),
  feeAmount: requestFeeAmountSchema,
  propertyMode: requestPropertyModeSchema,
  askCapacity: z.boolean(),
  askPurpose: z.boolean(),
  /** «يفحص مستحقات العقار» (F13): the clerk cannot approve while the property the request names owes. Needs a required card. */
  requiresNoDues: z.boolean().default(false),
  /** A draft the clerk starts the statement from (F9): never the certificate. */
  statementTemplate: optionalText(REQUEST_FORM_TEMPLATE_MAX, 'نص الإفادة طويل جداً'),
  sortOrder: z.number().int().min(0).max(1_000_000).default(0),
};

/** A form that checks dues names a property: the card is required (CHECK `request_forms_dues_needs_property`). */
function duesNeedsProperty(value: { requiresNoDues: boolean; propertyMode: RequestPropertyMode }, ctx: z.RefinementCtx): void {
  if (value.requiresNoDues && value.propertyMode !== 'REQUIRED') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['requiresNoDues'], message: 'فحص المستحقات يحتاج عقاراً إلزامياً' });
  }
}

/** «نموذج جديد»: the settings only. The questions are saved as a draft, then published. */
export const createRequestFormSchema = z.object(formSettings).strict().superRefine(duesNeedsProperty);
export type CreateRequestFormInput = z.infer<typeof createRequestFormSchema>;

/** The settings of an existing form (`PUT request-forms/:id`). */
export const updateRequestFormSchema = z.object(formSettings).strict().superRefine(duesNeedsProperty);
export type UpdateRequestFormInput = z.infer<typeof updateRequestFormSchema>;

/** Keys are unique inside a version, and a form holds at most `REQUEST_FORM_MAX_FIELDS` questions. */
function uniqueKeys(fields: ReadonlyArray<{ key: string }>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  fields.forEach((field, index) => {
    if (seen.has(field.key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'key'], message: 'مفتاح السؤال مكرر' });
    }
    seen.add(field.key);
  });
}

/**
 * The draft's questions, in order (the array is the position), saved whole. `expectedRevision` is the revision the
 * editor read: a draft saved since is refused (`REQUEST_FORM_EDIT_CONFLICT`), so two managers never overwrite each other.
 */
export const saveRequestFormDraftSchema = z
  .object({
    expectedRevision: z.number(typeError({ required: 'النسخة غير معروفة' })).int().min(1),
    fields: z.array(requestFormFieldSchema).max(REQUEST_FORM_MAX_FIELDS, `النموذج حتى ${REQUEST_FORM_MAX_FIELDS} سؤالاً`).superRefine(uniqueKeys),
  })
  .strict();
export type SaveRequestFormDraftInput = z.infer<typeof saveRequestFormDraftSchema>;

/** Why a draft cannot be published yet. */
export type RequestFormPublishIssue =
  | { code: 'NO_FIELDS' }
  | { code: 'TOO_MANY_FIELDS' }
  | { code: 'DUPLICATE_KEY'; fieldKey: string }
  | { code: 'CHOICES_NEEDED'; fieldKey: string }
  | { code: 'LINKED_TYPE_MISMATCH'; fieldKey: string };

/**
 * What stops a draft being published, or an empty list. A system form (F1) has no questions of its own and is
 * published by the migration that makes it, never by this check. The server asks it again under the form's lock.
 */
export function formPublishIssues(fields: ReadonlyArray<RequestFormFieldDefinition>): RequestFormPublishIssue[] {
  const issues: RequestFormPublishIssue[] = [];
  if (fields.length === 0) issues.push({ code: 'NO_FIELDS' });
  if (fields.length > REQUEST_FORM_MAX_FIELDS) issues.push({ code: 'TOO_MANY_FIELDS' });
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) issues.push({ code: 'DUPLICATE_KEY', fieldKey: field.key });
    seen.add(field.key);
    if ((field.type === 'SINGLE_CHOICE' || field.type === 'MULTI_CHOICE') && field.config.choices.length < 2) {
      issues.push({ code: 'CHOICES_NEEDED', fieldKey: field.key });
    }
    if (field.linkedSource && REQUEST_LINKED_SOURCE_TYPE[field.linkedSource] !== field.type) {
      issues.push({ code: 'LINKED_TYPE_MISMATCH', fieldKey: field.key });
    }
  }
  return issues;
}

/**
 * Whether the form already asks for an identity copy (F12): a file field whose paper is an `IDENTITY`. The server
 * demands that copy of every online request whatever the form, so the portal adds the standard step to a form
 * that lacks the field; the builder tells the manager.
 */
export function formAsksForIdentityCopy(fields: ReadonlyArray<RequestFormFieldDefinition>): boolean {
  return fields.some((field) => field.type === 'FILE' && field.config.attachmentType === 'IDENTITY');
}

// ─── filing a request on a form ───

const formUuid = (message: string) => z.string(typeError({ required: message })).guid(message);

/**
 * The answers as the client sends them: field key → value. Only the shape is checked here, bounded so a body cannot be
 * made huge; whether each value is right for its question is `request-form-answers.ts`, which needs the form.
 */
export const requestAnswersInputSchema = z
  .record(
    z.string().regex(REQUEST_FIELD_KEY_PATTERN, keyMessage),
    z.union([
      z.string().max(REQUEST_LONG_TEXT_MAX),
      z.number().finite(),
      z.boolean(),
      z.array(z.string().max(REQUEST_FIELD_LABEL_MAX)).max(REQUEST_FORM_MAX_CHOICES),
    ]),
  )
  .refine((answers) => Object.keys(answers).length <= REQUEST_FORM_MAX_FIELDS, `الأجوبة حتى ${REQUEST_FORM_MAX_FIELDS} جواباً`);
export type RequestAnswersInput = z.infer<typeof requestAnswersInputSchema>;

const formRequestFields = {
  formId: formUuid('اختر النموذج'),
  /**
   * The published version the screen showed (`OfferedRequestForm.versionId`). Sent by the portal and the counter, so a form
   * republished while the person filled it in is `REQUEST_FORM_VERSION_STALE` and not answered against other questions.
   */
  formVersionId: formUuid('النسخة غير معروفة').optional(),
  answers: requestAnswersInputSchema.default({}),
  /** Asked only when the form asks for it (`askCapacity`): the server checks. */
  applicantCapacity: applicantCapacitySchema.optional(),
  propertyEntryId: formUuid('اختر العقار').optional(),
  buildingUnitId: formUuid('اختر الوحدة').optional(),
  purpose: z
    .string()
    .trim()
    .max(500, 'الغرض طويل جداً')
    .optional()
    .transform((value) => (value ? value : undefined)),
  clientRequestId: z.string().guid(),
};

/** A unit line is always on a card. Whether the form needs a card is its `propertyMode`, which the server knows. */
function formRequestShape(value: { propertyEntryId?: string; buildingUnitId?: string }, context: z.RefinementCtx): void {
  if (value.buildingUnitId && !value.propertyEntryId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['propertyEntryId'], message: 'اختر العقار' });
  }
}

/**
 * `.strict()`: a body that names a `formId` and also a `requestType` is two requests in one, and is refused. The shape of a
 * request on no form is `submitOnlineRequestSchema`, untouched.
 */
export const submitOnlineFormRequestSchema = z.object(formRequestFields).strict().superRefine(formRequestShape);
export type SubmitOnlineFormRequestInput = z.infer<typeof submitOnlineFormRequestSchema>;

export const submitCounterFormRequestSchema = z
  .object({ ...formRequestFields, citizenId: formUuid('اختر المواطن') })
  .strict()
  .superRefine(formRequestShape);
export type SubmitCounterFormRequestInput = z.infer<typeof submitCounterFormRequestSchema>;

/** Picks the schema a body is for: one that names a `formId` is a request on a form, any other the request of 0092. */
function eitherRequestBody<A extends z.ZodType, B extends z.ZodType>(legacy: A, form: B) {
  return z.unknown().transform((value, ctx): z.infer<A> | z.infer<B> => {
    const chosen = typeof value === 'object' && value !== null && 'formId' in value ? form : legacy;
    const result = chosen.safeParse(value);
    if (result.success) return result.data;
    for (const issue of result.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message, path: [...issue.path] });
    }
    return z.NEVER;
  });
}

/** `POST requests/mine`: a request on no form, or on a form. */
export const onlineRequestBodySchema = eitherRequestBody(submitOnlineRequestSchema, submitOnlineFormRequestSchema);
export type OnlineRequestBody = z.infer<typeof onlineRequestBodySchema>;

/** `POST requests`: the counter's, the same two shapes with the citizen named. */
export const counterRequestBodySchema = eitherRequestBody(submitCounterRequestSchema, submitCounterFormRequestSchema);
export type CounterRequestBody = z.infer<typeof counterRequestBodySchema>;

/** A body that is a request on a form. */
export function isFormRequestBody<T extends object>(body: T): body is Extract<T, { formId: string }> {
  return 'formId' in body && typeof (body as { formId?: unknown }).formId === 'string';
}

/**
 * The text fields sent beside a paper (`multipart/form-data`): the kind of paper (a request on no form), or the file question
 * it answers (a request on a form, whose own `attachmentType` the server then files it under, so the client's is ignored).
 */
export const uploadRequestPaperSchema = z
  .object({ type: requestAttachmentTypeSchema.optional(), fieldKey: keySchema.optional() })
  .superRefine((value, ctx) => {
    if (!value.type && !value.fieldKey) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['type'], message: 'اختر نوع المستند' });
    }
  });
export type UploadRequestPaperInput = z.infer<typeof uploadRequestPaperSchema>;

// ─── views ───

/** A question as a screen reads it: the definition, where it stands in the version, and its id. */
export type RequestFormFieldView = RequestFormFieldDefinition & { id: string; position: number };

export interface RequestFormVersionView {
  id: string;
  versionNumber: number;
  status: RequestFormVersionStatus;
  /** What a draft's save compares (`expectedRevision`). */
  revision: number;
  publishedAt: string | null;
  fields: RequestFormFieldView[];
}

/** One row of the manager's list of forms (`GET request-forms`). */
export interface RequestFormListItem {
  id: string;
  nameAr: string;
  nameEn: string | null;
  feeAmount: number;
  enabled: boolean;
  /** Set on a form standing for a built-in request type (F1). */
  systemType: RequestType | null;
  archivedAt: string | null;
  /** The questions of the current version. */
  fieldCount: number;
  hasDraft: boolean;
  requestCount: number;
  updatedAt: string;
}

/** A form with its current version and its draft (`GET request-forms/:id`). */
export interface RequestFormView {
  id: string;
  nameAr: string;
  nameEn: string | null;
  feeAmount: number;
  enabled: boolean;
  propertyMode: RequestPropertyMode;
  askCapacity: boolean;
  askPurpose: boolean;
  requiresNoDues: boolean;
  statementTemplate: string | null;
  systemType: RequestType | null;
  sortOrder: number;
  archivedAt: string | null;
  current: RequestFormVersionView | null;
  draft: RequestFormVersionView | null;
  requestCount: number;
  updatedAt: string;
}

/** A question of an offered form, with the file's value for a linked one. */
export type OfferedRequestField = RequestFormFieldView & {
  /**
   * For a linked field: what the citizen's file holds, or null when it holds nothing and the request is refused until a
   * clerk completes the file (F4, `REQUEST_FORM_LINKED_FIELD_EMPTY`). Absent on a field that is not linked.
   */
  linkedValue?: string | null;
};

/** A form a citizen or a clerk may file now (`GET requests/mine/forms`, `GET requests/forms`). */
export interface OfferedRequestForm {
  id: string;
  /** The published version the answers are validated against. A request filed against an older one is refused. */
  versionId: string;
  nameAr: string;
  nameEn: string | null;
  feeAmount: number;
  propertyMode: RequestPropertyMode;
  askCapacity: boolean;
  askPurpose: boolean;
  fields: OfferedRequestField[];
}

/** One answer on a request, as staff and the citizen read it (the citizen's has identity numbers masked, F8). */
export interface RequestAnswerView {
  fieldKey: string;
  labelAr: string;
  labelEn: string | null;
  type: RequestFieldType;
  /** A file question has no value here: its papers are the request's attachments. */
  value: string | number | boolean | string[];
  /** For a choice question, the words of what was chosen (the stored value is its key); null for every other type. */
  display: { ar: string; en: string | null } | null;
  origin: RequestAnswerOrigin;
}

/** What a form tells a request it was filled against. */
export interface RequestFormRef {
  id: string;
  versionId: string;
  versionNumber: number;
  nameAr: string;
  nameEn: string | null;
}

/** A file question of the request's form that holds no paper yet. */
export interface RequestMissingPaper {
  fieldKey: string;
  labelAr: string;
  labelEn: string | null;
}

/** What the counter reads once a citizen is chosen (`GET requests/forms/:formId/prefill?citizenId=`): the file's value for each linked question. */
export interface RequestFormPrefill {
  formId: string;
  citizenId: string;
  /** By field key; null where the file holds nothing, so the request is refused until a clerk completes it (F4). */
  linkedValues: Record<string, string | null>;
}

/** The applicant's capacity is on a request only when its form asked. */
export type RequestCapacityAsked = ApplicantCapacity | null;
