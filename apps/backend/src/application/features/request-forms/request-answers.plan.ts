import {
  answerValueForCitizen,
  type ApplicantCapacity,
  type CitizenFileValues,
  type RequestAnswerIssue,
  type RequestAnswerOrigin,
  type RequestAnswerValue,
  type RequestAnswerView,
  type RequestFieldType,
  type RequestFormRef,
  type RequestMissingPaper,
  type RequestPropertyMode,
} from '@mechanization/shared-schemas';

/**
 * What a request on a form decides, with no database (`request-answers.plan.spec.ts`): the request's own questions beside the
 * form's (capacity, property, purpose), the citizen's file as the linked questions read it, how a stored answer is compared
 * with a retried one, and how a request's form, answers and missing papers read back. Docs: docs/request-forms-plan.md §4.
 */

// ─── the request's own questions: capacity, property, purpose ───

/** What a form asks beside its questions (F6): the card, the applicant's capacity, the purpose. */
export interface FormAsks {
  propertyMode: RequestPropertyMode;
  askCapacity: boolean;
  askPurpose: boolean;
}

export interface RequestOwnFields {
  applicantCapacity?: ApplicantCapacity;
  propertyEntryId?: string;
  buildingUnitId?: string;
  purpose?: string;
}

export interface NormalisedOwnFields {
  applicantCapacity: ApplicantCapacity | null;
  propertyEntryId: string | null;
  buildingUnitId: string | null;
  purpose: string | null;
  /** The form asks for these and the body left them out. */
  issues: RequestAnswerIssue[];
  /** The form names a card and the body gave none (`REQUEST_PROPERTY_REQUIRED`). */
  propertyMissing: boolean;
}

/**
 * The request's own fields as the form reads them. What the form does not ask is dropped, not refused, so that a client that
 * still sends a capacity is not turned away; and because it is dropped here, a retry under the same key compares equal.
 */
export function normaliseOwnFields(asks: FormAsks, input: RequestOwnFields): NormalisedOwnFields {
  const issues: RequestAnswerIssue[] = [];
  let applicantCapacity: ApplicantCapacity | null = null;
  if (asks.askCapacity) {
    if (input.applicantCapacity) applicantCapacity = input.applicantCapacity;
    else issues.push({ fieldKey: 'applicantCapacity', code: 'REQUIRED' });
  }
  const names = asks.propertyMode !== 'NONE';
  const propertyEntryId = names ? (input.propertyEntryId ?? null) : null;
  // A unit line is always on a card.
  const buildingUnitId = propertyEntryId ? (input.buildingUnitId ?? null) : null;
  return {
    applicantCapacity,
    propertyEntryId,
    buildingUnitId,
    purpose: asks.askPurpose ? (input.purpose ?? null) : null,
    issues,
    propertyMissing: asks.propertyMode === 'REQUIRED' && propertyEntryId === null,
  };
}

// ─── the citizen's file ───

/** The columns of `users` a linked question reads. */
export interface CitizenFileRow {
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  motherName: string | null;
  phone: string | null;
  identityDocNumber: string | null;
  civilRecordNumber: string | null;
}

export const CITIZEN_FILE_SELECT = {
  firstName: true,
  middleName: true,
  lastName: true,
  motherName: true,
  phone: true,
  identityDocNumber: true,
  civilRecordNumber: true,
} as const;

/** The file as the shared validator reads it. A رقم مرجعي is not in it: no question can name one (non-negotiable 7). */
export function citizenFileValues(row: CitizenFileRow): CitizenFileValues {
  return {
    FIRST_NAME: row.firstName,
    FATHER_NAME: row.middleName,
    LAST_NAME: row.lastName,
    MOTHER_NAME: row.motherName,
    PHONE: row.phone,
    IDENTITY_NUMBER: row.identityDocNumber,
    CIVIL_RECORD_NUMBER: row.civilRecordNumber,
  };
}

// ─── a retried press ───

/** The answers a person typed, stored and retried: equal when every typed question holds the same value. */
export function sameTypedAnswers(
  stored: ReadonlyArray<{ fieldKey: string; value: unknown; origin: RequestAnswerOrigin }>,
  parsed: ReadonlyArray<{ fieldKey: string; value: unknown; origin: RequestAnswerOrigin }>,
): boolean {
  const typed = (rows: ReadonlyArray<{ fieldKey: string; value: unknown; origin: RequestAnswerOrigin }>) =>
    new Map(rows.filter((row) => row.origin === 'ANSWERED').map((row) => [row.fieldKey, JSON.stringify(row.value)]));
  const was = typed(stored);
  const now = typed(parsed);
  if (was.size !== now.size) return false;
  for (const [key, value] of now) if (was.get(key) !== value) return false;
  return true;
}

// ─── reading a request back ───

/** What a request row carries of its form (`REQUEST_SELECT`'s `formVersion` and `answers`). */
export interface RequestFormRow {
  formVersion: {
    id: string;
    versionNumber: number;
    form: { id: string; nameAr: string; nameEn: string | null };
    fields: Array<{ id: string; key: string; labelAr: string; labelEn: string | null }>;
  } | null;
  answers: Array<{
    value: unknown;
    origin: string;
    field: { key: string; position: number; type: string; labelAr: string; labelEn: string | null; config: unknown };
  }>;
  attachments: Array<{ fieldId: string | null }>;
}

/** The words of a choice answer, from the choices the version defined; null for any other type or a key it no longer lists. */
function choiceWords(type: RequestFieldType, value: RequestAnswerValue, config: unknown): { ar: string; en: string | null } | null {
  if (type !== 'SINGLE_CHOICE' && type !== 'MULTI_CHOICE') return null;
  const choices = (config as { choices?: Array<{ key: string; labelAr: string; labelEn?: string | null }> } | null)?.choices ?? [];
  const keys = Array.isArray(value) ? value : [String(value)];
  const found = keys.map((key) => choices.find((choice) => choice.key === key)).filter((choice): choice is NonNullable<typeof choice> => Boolean(choice));
  if (found.length === 0) return null;
  return {
    ar: found.map((choice) => choice.labelAr).join('، '),
    en: found.every((choice) => choice.labelEn) ? found.map((choice) => choice.labelEn).join(', ') : null,
  };
}

export function formRefOf(row: {
  formVersion: { id: string; versionNumber: number; form: { id: string; nameAr: string; nameEn: string | null } } | null;
}): RequestFormRef | null {
  const version = row.formVersion;
  if (!version) return null;
  return {
    id: version.form.id,
    versionId: version.id,
    versionNumber: version.versionNumber,
    nameAr: version.form.nameAr,
    nameEn: version.form.nameEn,
  };
}

/** Every answer in the form's own order. The citizen's copy has identity and civil numbers masked (F8). */
export function answerViewsOf(row: Pick<RequestFormRow, 'answers'>, audience: 'STAFF' | 'CITIZEN'): RequestAnswerView[] {
  return [...row.answers]
    .sort((a, b) => a.field.position - b.field.position)
    .map((answer) => {
      const type = answer.field.type as RequestFieldType;
      const value = answer.value as RequestAnswerValue;
      return {
        fieldKey: answer.field.key,
        labelAr: answer.field.labelAr,
        labelEn: answer.field.labelEn,
        type,
        value: audience === 'CITIZEN' ? answerValueForCitizen(type, value) : value,
        display: choiceWords(type, value, answer.field.config),
        origin: answer.origin as RequestAnswerOrigin,
      };
    });
}

/**
 * The file questions of the request's version that hold no paper. The version's file questions are read apart from its
 * others (`REQUEST_SELECT`), so `formVersion.fields` here are file questions only.
 */
export function missingPapersOf(row: Pick<RequestFormRow, 'formVersion' | 'attachments'>): RequestMissingPaper[] {
  const version = row.formVersion;
  if (!version) return [];
  const held = new Set(row.attachments.map((attachment) => attachment.fieldId).filter((id): id is string => id !== null));
  return version.fields
    .filter((field) => !held.has(field.id))
    .map((field) => ({ fieldKey: field.key, labelAr: field.labelAr, labelEn: field.labelEn }));
}

/** The key of the question a paper answers, or null. */
/** The question a paper answers, with its words, or null. */
export function fieldOfPaper(
  row: Pick<RequestFormRow, 'formVersion'>,
  attachment: { fieldId: string | null },
): { key: string; labelAr: string; labelEn: string | null } | null {
  if (!attachment.fieldId) return null;
  const field = row.formVersion?.fields.find((candidate) => candidate.id === attachment.fieldId);
  return field ? { key: field.key, labelAr: field.labelAr, labelEn: field.labelEn } : null;
}

/** The key of the question a paper answers, or null. */
export function fieldKeyOfPaper(
  row: Pick<RequestFormRow, 'formVersion'>,
  attachment: { fieldId: string | null },
): string | null {
  if (!attachment.fieldId) return null;
  return row.formVersion?.fields.find((field) => field.id === attachment.fieldId)?.key ?? null;
}
