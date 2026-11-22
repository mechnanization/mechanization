import {
  answerableFields,
  fileFields,
  linkedFields,
  parseAnswers,
  type CitizenFileValues,
  type OfferedRequestField,
  type OfferedRequestForm,
  type RequestAnswerIssue,
  type RequestAnswerIssueCode,
} from '@mechanization/shared-schemas';

/**
 * Filling a request form, as plain data (docs/request-forms-plan.md §6): what the portal and the counter both do before they
 * send — which steps a form has, what is typed, what the citizen's file already holds, and whether the shared validator is
 * satisfied. The server runs the same `parseAnswers` again; this only lets the screen name a problem beside its question.
 */

/** What one question holds while it is being filled: text and numbers as typed, a choice as its key, several as a list, yes/no. */
export type AnswerInput = string | boolean | string[];

/** The type of paper the identity copy is filed as (D2, F12): every online request carries one. */
export const IDENTITY_PAPER = 'IDENTITY' as const;

/** The questions a person answers on screen: typed ones, not copied from the file, not a paper. */
export function typedFields(form: Pick<OfferedRequestForm, 'fields'>): OfferedRequestField[] {
  return answerableFields(form.fields) as OfferedRequestField[];
}

/** The questions copied from the citizen's file, shown and not asked. */
export function copiedFields(form: Pick<OfferedRequestForm, 'fields'>): OfferedRequestField[] {
  return linkedFields(form.fields) as OfferedRequestField[];
}

/** The questions answered by a paper. */
export function paperFields(form: Pick<OfferedRequestForm, 'fields'>): OfferedRequestField[] {
  return fileFields(form.fields) as OfferedRequestField[];
}

/**
 * The linked questions the file cannot fill (F4): the request is refused until a clerk completes the file, so the screen says so
 * before the person starts. Empty at the counter before a citizen is chosen (`linkedValue` is absent, not null).
 */
export function blockedFields(form: Pick<OfferedRequestForm, 'fields'>): OfferedRequestField[] {
  return copiedFields(form).filter((field) => field.linkedValue === null);
}

/** The file as the shared validator reads it, rebuilt from the values the server sent with the questions. */
export function fileOf(form: Pick<OfferedRequestForm, 'fields'>): CitizenFileValues {
  const file: CitizenFileValues = {};
  for (const field of copiedFields(form)) {
    if (field.linkedSource !== null) file[field.linkedSource] = field.linkedValue ?? null;
  }
  return file;
}

/** Whether the form asks anything beside its questions: the card, the capacity, the purpose (F6). */
export function asksOwnFields(form: Pick<OfferedRequestForm, 'propertyMode' | 'askCapacity' | 'askPurpose'>): boolean {
  return form.propertyMode !== 'NONE' || form.askCapacity || form.askPurpose;
}

/** Whether the form carries its own identity-copy question, which then stands in for the standard step (F12). */
export function hasIdentityQuestion(form: Pick<OfferedRequestForm, 'fields'>): boolean {
  return paperFields(form).some((field) => field.type === 'FILE' && field.config.attachmentType === IDENTITY_PAPER);
}

export type FillStep = 'type' | 'property' | 'answers' | 'papers' | 'review';

/**
 * The steps a choice has. A built-in type is the four it always had. A form has «العقار» only when it asks the card, the
 * capacity or the purpose, «الأجوبة» only when it has something to show or ask, and «المستندات» always: every online request
 * carries an identity copy.
 */
export function stepsFor(form: OfferedRequestForm | null): FillStep[] {
  if (!form) return ['type', 'property', 'papers', 'review'];
  const steps: FillStep[] = ['type'];
  if (asksOwnFields(form)) steps.push('property');
  if (typedFields(form).length + copiedFields(form).length > 0) steps.push('answers');
  steps.push('papers', 'review');
  return steps;
}

/** What the person typed for the typed questions, as the request carries it: blank is no answer. */
export function answersToSend(form: Pick<OfferedRequestForm, 'fields'>, values: Readonly<Record<string, AnswerInput | undefined>>): Record<string, AnswerInput> {
  const out: Record<string, AnswerInput> = {};
  for (const field of typedFields(form)) {
    const value = values[field.key];
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[field.key] = typeof value === 'string' ? value.trim() : value;
  }
  return out;
}

/** The shared validator's verdict on the questions, by key: the first code of each question. */
export function answerIssues(
  form: Pick<OfferedRequestForm, 'fields'>,
  values: Readonly<Record<string, AnswerInput | undefined>>,
): Record<string, RequestAnswerIssueCode> {
  const result = parseAnswers(form.fields, answersToSend(form, values), fileOf(form));
  if (result.ok) return {};
  const out: Record<string, RequestAnswerIssueCode> = {};
  for (const issue of result.issues) {
    // A question the file cannot fill is the screen's own notice (`blockedFields`), not an answer to fix.
    if (issue.code === 'LINKED_FIELD_EMPTY') continue;
    if (!(issue.fieldKey in out)) out[issue.fieldKey] = issue.code;
  }
  return out;
}

/** The issues an API refusal carries (`REQUEST_ANSWERS_INVALID`, `details.issues`), by key, or none when it carries none. */
export function issuesOfRefusal(details: unknown): Record<string, RequestAnswerIssueCode> {
  const raw = (details as { issues?: unknown } | null | undefined)?.issues;
  if (!Array.isArray(raw)) return {};
  const out: Record<string, RequestAnswerIssueCode> = {};
  for (const item of raw as RequestAnswerIssue[]) {
    if (item && typeof item.fieldKey === 'string' && typeof item.code === 'string' && !(item.fieldKey in out)) out[item.fieldKey] = item.code;
  }
  return out;
}

/** A file question holds a paper once at least one is queued for it. */
export function unansweredPapers(
  form: Pick<OfferedRequestForm, 'fields'>,
  queuedKeys: readonly (string | undefined)[],
): OfferedRequestField[] {
  const held = new Set(queuedKeys.filter((key): key is string => key !== undefined));
  return paperFields(form).filter((field) => !held.has(field.key));
}

/** The first step still missing its answer, or `review` when every step has one. */
export function firstMissingStep(args: {
  steps: readonly FillStep[];
  chosen: boolean;
  needsProperty: boolean;
  hasProperty: boolean;
  capacityMissing: boolean;
  answersMissing: boolean;
  blocked: boolean;
  papersMissing: boolean;
}): FillStep {
  const { steps } = args;
  if (!args.chosen || args.blocked) return 'type';
  if (steps.includes('property') && ((args.needsProperty && !args.hasProperty) || args.capacityMissing)) return 'property';
  if (steps.includes('answers') && args.answersMissing) return 'answers';
  if (args.papersMissing) return 'papers';
  return 'review';
}
