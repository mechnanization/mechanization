import type { RequestAnswerOrigin, RequestFieldType, RequestLinkedSource } from './enums';
import {
  REQUEST_LONG_TEXT_MAX,
  REQUEST_NUMBER_BOUND,
  REQUEST_SHORT_TEXT_MAX,
  type RequestFieldOf,
  type RequestFormFieldDefinition,
} from './request-form.schema';
import { documentNumber, internationalPhone, isCalendarDay, normalizeDigits } from './primitives';

/**
 * Whether the answers to a request form fit the form, and what to store.
 *
 * One function both apps call: the portal and the counter screen run it before they send (so the person sees what is
 * wrong beside the question), the server runs it again before it writes a row, because the browser is never trusted.
 * Every field is required (open decisions §24 F4), so there is no «optional» branch: an answer that is missing is the
 * `REQUIRED` issue and nothing else. A question tied to the citizen's file (`linkedSource`) is never typed: its value is
 * the file's, copied when the request is filed, and an empty one stops the request until a clerk completes the file.
 *
 * A file question holds no value here: its papers are the request's attachments, checked by the upload route.
 */

/** Why one answer is refused. A code, never prose: the screens translate it (`requestForms.issues.<CODE>`). */
export const REQUEST_ANSWER_ISSUE_CODES = [
  'REQUIRED',
  'WRONG_TYPE',
  'UNKNOWN_FIELD',
  'LINKED_FIELD_NOT_ANSWERABLE',
  'LINKED_FIELD_EMPTY',
  'TOO_SHORT',
  'TOO_LONG',
  'NOT_A_NUMBER',
  'NOT_INTEGER',
  'BELOW_MIN',
  'ABOVE_MAX',
  'TOO_MANY_DECIMALS',
  'NOT_A_DATE',
  'BEFORE_MIN_DATE',
  'AFTER_MAX_DATE',
  'INVALID_PHONE',
  'INVALID_DOCUMENT_NUMBER',
  'NOT_A_CHOICE',
  'TOO_FEW_CHOICES',
  'TOO_MANY_CHOICES',
  'DUPLICATE_CHOICE',
  'NOT_YES_NO',
] as const;
export type RequestAnswerIssueCode = (typeof REQUEST_ANSWER_ISSUE_CODES)[number];

export interface RequestAnswerIssue {
  fieldKey: string;
  code: RequestAnswerIssueCode;
  /** The bound a message names (`BELOW_MIN`: `min`; `TOO_LONG`: `max`), never a value the person typed. */
  params?: Readonly<Record<string, number | string>>;
}

/** What an answer is stored as. A text, a number (integer or decimal), a day `YYYY-MM-DD`, a choice key, the keys, or a yes/no. */
export type RequestAnswerValue = string | number | boolean | string[];

export interface ParsedRequestAnswer {
  fieldKey: string;
  type: RequestFieldType;
  value: RequestAnswerValue;
  origin: RequestAnswerOrigin;
}

export type ParseAnswersResult =
  | { ok: true; answers: ParsedRequestAnswer[] }
  | { ok: false; issues: RequestAnswerIssue[] };

/** The citizen's file, as far as a linked question reads it. Never a رقم مرجعي: there is no source for one. */
export type CitizenFileValues = Partial<Record<RequestLinkedSource, string | null | undefined>>;

/** What the file holds for a source, or null when it holds nothing (blank is nothing). */
export function linkedValueFor(source: RequestLinkedSource, file: CitizenFileValues): string | null {
  const value = file[source];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** The questions a person types or taps: not a file, not copied from the file. */
export function answerableFields(fields: ReadonlyArray<RequestFormFieldDefinition>): RequestFormFieldDefinition[] {
  return fields.filter((field) => field.type !== 'FILE' && field.linkedSource === null);
}

/** The questions copied from the citizen's file. */
export function linkedFields(fields: ReadonlyArray<RequestFormFieldDefinition>): RequestFormFieldDefinition[] {
  return fields.filter((field) => field.type !== 'FILE' && field.linkedSource !== null);
}

/** The questions answered by a paper. */
export function fileFields(fields: ReadonlyArray<RequestFormFieldDefinition>): Array<RequestFieldOf<'FILE'>> {
  return fields.filter((field): field is RequestFieldOf<'FILE'> => field.type === 'FILE');
}

/** The linked questions the citizen's file cannot fill yet: what a clerk must complete first (F4). */
export function emptyLinkedFields(
  fields: ReadonlyArray<RequestFormFieldDefinition>,
  file: CitizenFileValues,
): RequestFormFieldDefinition[] {
  return linkedFields(fields).filter((field) => field.linkedSource !== null && linkedValueFor(field.linkedSource, file) === null);
}

// ─── one value ───

type One = { value: RequestAnswerValue } | { issue: RequestAnswerIssueCode; params?: Record<string, number | string> };

const missing = (raw: unknown): boolean =>
  raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '') || (Array.isArray(raw) && raw.length === 0);

function parseText(field: RequestFieldOf<'SHORT_TEXT'> | RequestFieldOf<'LONG_TEXT'>, raw: unknown): One {
  if (typeof raw !== 'string') return { issue: 'WRONG_TYPE' };
  const text = raw.trim();
  const ceiling = field.type === 'SHORT_TEXT' ? REQUEST_SHORT_TEXT_MAX : REQUEST_LONG_TEXT_MAX;
  const min = field.config.minLength ?? 1;
  const max = field.config.maxLength ?? ceiling;
  const length = Array.from(text).length;
  if (length < min) return { issue: 'TOO_SHORT', params: { min } };
  if (length > max) return { issue: 'TOO_LONG', params: { max } };
  return { value: text };
}

/** A number typed in Arabic-Indic digits or with the Arabic decimal mark is still the number. */
function numberFrom(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const text = normalizeDigits(raw.trim()).replace(/٫/g, '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** How many places after the point the number was written with. */
function decimalPlaces(raw: unknown, value: number): number {
  const text = typeof raw === 'string' ? normalizeDigits(raw.trim()).replace(/٫/g, '.') : String(value);
  if (/e/i.test(text)) return Number.isInteger(value) ? 0 : Number.POSITIVE_INFINITY;
  const point = text.indexOf('.');
  return point < 0 ? 0 : text.length - point - 1;
}

function checkBounds(value: number, min: number | undefined, max: number | undefined): One | null {
  if (Math.abs(value) > REQUEST_NUMBER_BOUND) return { issue: 'ABOVE_MAX', params: { max: REQUEST_NUMBER_BOUND } };
  if (min !== undefined && value < min) return { issue: 'BELOW_MIN', params: { min } };
  if (max !== undefined && value > max) return { issue: 'ABOVE_MAX', params: { max } };
  return null;
}

function parseInteger(field: RequestFieldOf<'INTEGER'>, raw: unknown): One {
  const value = numberFrom(raw);
  if (value === null) return { issue: 'NOT_A_NUMBER' };
  if (!Number.isInteger(value)) return { issue: 'NOT_INTEGER' };
  return checkBounds(value, field.config.min, field.config.max) ?? { value };
}

function parseDecimal(field: RequestFieldOf<'DECIMAL'>, raw: unknown): One {
  const value = numberFrom(raw);
  if (value === null) return { issue: 'NOT_A_NUMBER' };
  const decimals = field.config.decimals;
  if (decimalPlaces(raw, value) > decimals) return { issue: 'TOO_MANY_DECIMALS', params: { decimals } };
  return checkBounds(value, field.config.min, field.config.max) ?? { value };
}

function parseDate(field: RequestFieldOf<'DATE'>, raw: unknown): One {
  if (typeof raw !== 'string') return { issue: 'WRONG_TYPE' };
  const day = normalizeDigits(raw.trim());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isCalendarDay(day)) return { issue: 'NOT_A_DATE' };
  // A calendar day compares as text: the same width, most significant first.
  if (field.config.min !== undefined && day < field.config.min) return { issue: 'BEFORE_MIN_DATE', params: { min: field.config.min } };
  if (field.config.max !== undefined && day > field.config.max) return { issue: 'AFTER_MAX_DATE', params: { max: field.config.max } };
  return { value: day };
}

function parseChoices(field: RequestFieldOf<'SINGLE_CHOICE'> | RequestFieldOf<'MULTI_CHOICE'>, raw: unknown): One {
  const keys = field.config.choices.map((choice) => choice.key);
  if (field.type === 'SINGLE_CHOICE') {
    if (typeof raw !== 'string') return { issue: 'WRONG_TYPE' };
    return keys.includes(raw) ? { value: raw } : { issue: 'NOT_A_CHOICE' };
  }
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) return { issue: 'WRONG_TYPE' };
  const picked = raw as string[];
  if (picked.some((key) => !keys.includes(key))) return { issue: 'NOT_A_CHOICE' };
  if (new Set(picked).size !== picked.length) return { issue: 'DUPLICATE_CHOICE' };
  const min = field.config.minSelected ?? 1;
  const max = field.config.maxSelected ?? keys.length;
  if (picked.length < min) return { issue: 'TOO_FEW_CHOICES', params: { min } };
  if (picked.length > max) return { issue: 'TOO_MANY_CHOICES', params: { max } };
  // The order the form lists them in, whatever order they were tapped.
  return { value: keys.filter((key) => picked.includes(key)) };
}

function parseOne(field: RequestFormFieldDefinition, raw: unknown): One {
  if (missing(raw)) return { issue: 'REQUIRED' };
  switch (field.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
      return parseText(field, raw);
    case 'INTEGER':
      return parseInteger(field, raw);
    case 'DECIMAL':
      return parseDecimal(field, raw);
    case 'DATE':
      return parseDate(field, raw);
    case 'PHONE': {
      if (typeof raw !== 'string') return { issue: 'WRONG_TYPE' };
      const parsed = internationalPhone.safeParse(raw);
      return parsed.success ? { value: parsed.data } : { issue: 'INVALID_PHONE' };
    }
    case 'DOCUMENT_NUMBER': {
      if (typeof raw !== 'string') return { issue: 'WRONG_TYPE' };
      const parsed = documentNumber.safeParse(normalizeDigits(raw));
      return parsed.success ? { value: parsed.data } : { issue: 'INVALID_DOCUMENT_NUMBER' };
    }
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE':
      return parseChoices(field, raw);
    case 'YES_NO':
      return typeof raw === 'boolean' ? { value: raw } : { issue: 'NOT_YES_NO' };
    case 'FILE':
      return { issue: 'UNKNOWN_FIELD' };
  }
}

// ─── the whole form ───

/**
 * Checks every answer against the form's questions, and returns the rows to write, in the form's own order, or every
 * issue found (never just the first: a person fixes a form once).
 *
 * - A key that is no question of the form, or is a file question, is `UNKNOWN_FIELD`.
 * - A key sent for a linked question is `LINKED_FIELD_NOT_ANSWERABLE`: its value is the file's.
 * - A linked question whose source the file leaves empty is `LINKED_FIELD_EMPTY`, and the request is refused (F4).
 * - A question with no answer is `REQUIRED`.
 */
export function parseAnswers(
  fields: ReadonlyArray<RequestFormFieldDefinition>,
  raw: Readonly<Record<string, unknown>>,
  file: CitizenFileValues,
): ParseAnswersResult {
  const issues: RequestAnswerIssue[] = [];
  const answers: ParsedRequestAnswer[] = [];
  const byKey = new Map(fields.map((field) => [field.key, field]));

  for (const key of Object.keys(raw)) {
    const field = byKey.get(key);
    if (!field || field.type === 'FILE') issues.push({ fieldKey: key, code: 'UNKNOWN_FIELD' });
    else if (field.linkedSource !== null) issues.push({ fieldKey: key, code: 'LINKED_FIELD_NOT_ANSWERABLE' });
  }

  for (const field of fields) {
    if (field.type === 'FILE') continue;
    if (field.linkedSource !== null) {
      const value = linkedValueFor(field.linkedSource, file);
      if (value === null) issues.push({ fieldKey: field.key, code: 'LINKED_FIELD_EMPTY' });
      else answers.push({ fieldKey: field.key, type: field.type, value, origin: 'FROM_FILE' });
      continue;
    }
    const one = parseOne(field, raw[field.key]);
    if ('issue' in one) issues.push({ fieldKey: field.key, code: one.issue, ...(one.params ? { params: one.params } : {}) });
    else answers.push({ fieldKey: field.key, type: field.type, value: one.value, origin: 'ANSWERED' });
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, answers };
}

// ─── showing an answer to the citizen ───

/**
 * An identity or civil record number as the citizen sees it back (F8): all but its last three characters hidden, so a
 * shared screen or a screenshot does not leak the number. A number of three characters or fewer is hidden whole.
 */
export function maskIdentityNumber(value: string): string {
  const characters = Array.from(value);
  if (characters.length <= 3) return '•'.repeat(characters.length);
  return '•'.repeat(characters.length - 3) + characters.slice(-3).join('');
}

/**
 * The value of an answer for the citizen's own screens: a document number is masked, every other value is as stored. Staff
 * read the stored value (`REQUEST_READ_ROLES`); a file question's papers never come back to the citizen.
 */
export function answerValueForCitizen(type: RequestFieldType, value: RequestAnswerValue): RequestAnswerValue {
  return type === 'DOCUMENT_NUMBER' && typeof value === 'string' ? maskIdentityNumber(value) : value;
}
