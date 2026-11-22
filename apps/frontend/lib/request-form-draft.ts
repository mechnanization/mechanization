import {
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_ATTACHMENT_MIME_TYPES,
  REQUEST_FIELD_LABEL_MAX,
  REQUEST_FORM_MAX_CHOICES,
  REQUEST_FORM_MAX_FIELDS,
  REQUEST_LINKED_SOURCE,
  REQUEST_LINKED_SOURCE_TYPE,
  formAsksForIdentityCopy,
  isCalendarDay,
  normalizeDigits,
  requestFormFieldSchema,
  type RequestAttachmentType,
  type RequestFieldType,
  type RequestFormFieldDefinition,
  type RequestFormFieldView,
  type RequestLinkedSource,
} from '@mechanization/shared-schemas';

/**
 * The form builder's state, as plain data (docs/request-forms-plan.md §6). A question is edited as text — a number is what
 * the manager typed — and `toDefinition` turns it into the shared schema's input, which is the one judge of what is valid;
 * `fieldProblems` only names, in the builder's own words, what the manager can fix. Keys are never typed: they are made here
 * (`q1`, `q2` …) and stay the same across versions, so an answer can be followed.
 */

export interface ChoiceDraft {
  uid: string;
  key: string;
  labelAr: string;
  labelEn: string;
}

export interface FieldDraft {
  /** A local identity for React and for moving a question; never sent. */
  uid: string;
  key: string;
  type: RequestFieldType;
  labelAr: string;
  labelEn: string;
  helpAr: string;
  helpEn: string;
  linkedSource: RequestLinkedSource | null;
  // text and numbers, as typed
  minLength: string;
  maxLength: string;
  min: string;
  max: string;
  decimals: string;
  minDate: string;
  maxDate: string;
  // choices
  choices: ChoiceDraft[];
  minSelected: string;
  maxSelected: string;
  // files
  attachmentType: RequestAttachmentType;
  maxFiles: string;
  accept: string[];
}

/** Why a question cannot be saved yet, said by the builder in the manager's language. */
export type FieldProblem =
  | 'LABEL_REQUIRED'
  | 'LABEL_TOO_LONG'
  | 'CHOICES_FEW'
  | 'CHOICE_LABEL_REQUIRED'
  | 'NUMBER'
  | 'RANGE'
  | 'DATE'
  | 'SELECTED_RANGE'
  | 'FILES_RANGE'
  | 'ACCEPT_EMPTY'
  | 'INVALID';

const uid = (): string => globalThis.crypto.randomUUID();

/** `q1`, `q2` … the first not taken: what a new question and a new choice are called. */
export function nextKey(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken);
  for (let n = 1; n <= REQUEST_FORM_MAX_CHOICES + REQUEST_FORM_MAX_FIELDS + 1; n++) {
    if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
  }
  return `${prefix}${used.size + 1}`;
}

export function emptyChoice(taken: readonly string[]): ChoiceDraft {
  return { uid: uid(), key: nextKey('c', taken), labelAr: '', labelEn: '' };
}

/** A new question of a type, with the options the shared schema would default to. */
export function newField(type: RequestFieldType, takenKeys: readonly string[]): FieldDraft {
  const field: FieldDraft = {
    uid: uid(),
    key: nextKey('q', takenKeys),
    type,
    labelAr: '',
    labelEn: '',
    helpAr: '',
    helpEn: '',
    linkedSource: null,
    minLength: '',
    maxLength: '',
    min: '',
    max: '',
    decimals: '2',
    minDate: '',
    maxDate: '',
    choices: [],
    minSelected: '',
    maxSelected: '',
    attachmentType: 'OTHER',
    maxFiles: '1',
    accept: [...REQUEST_ATTACHMENT_MIME_TYPES],
  };
  if (type === 'SINGLE_CHOICE' || type === 'MULTI_CHOICE') {
    const first = emptyChoice([]);
    field.choices = [first, emptyChoice([first.key])];
  }
  return field;
}

/** The same question as another type: its words stay, its options start again, and a link that no longer fits is dropped. */
export function changeType(field: FieldDraft, type: RequestFieldType): FieldDraft {
  const fresh = newField(type, []);
  const stillLinked = field.linkedSource !== null && REQUEST_LINKED_SOURCE_TYPE[field.linkedSource] === type;
  return {
    ...fresh,
    uid: field.uid,
    key: field.key,
    labelAr: field.labelAr,
    labelEn: field.labelEn,
    helpAr: field.helpAr,
    helpEn: field.helpEn,
    linkedSource: stillLinked ? field.linkedSource : null,
  };
}

/** The sources of the citizen's file a question of this type may copy from (F4). */
export function linkableSources(type: RequestFieldType): RequestLinkedSource[] {
  return REQUEST_LINKED_SOURCE.filter((source) => REQUEST_LINKED_SOURCE_TYPE[source] === type);
}

const text = (value: number | undefined): string => (value === undefined ? '' : String(value));

/** A stored question as the builder edits it. */
export function fromView(view: RequestFormFieldView | RequestFormFieldDefinition): FieldDraft {
  const draft = newField(view.type, []);
  const base: FieldDraft = {
    ...draft,
    key: view.key,
    labelAr: view.labelAr,
    labelEn: view.labelEn ?? '',
    helpAr: view.helpAr ?? '',
    helpEn: view.helpEn ?? '',
    linkedSource: view.linkedSource,
    choices: [],
  };
  switch (view.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
      return { ...base, minLength: text(view.config.minLength), maxLength: text(view.config.maxLength) };
    case 'INTEGER':
      return { ...base, min: text(view.config.min), max: text(view.config.max) };
    case 'DECIMAL':
      return { ...base, min: text(view.config.min), max: text(view.config.max), decimals: String(view.config.decimals) };
    case 'DATE':
      return { ...base, minDate: view.config.min ?? '', maxDate: view.config.max ?? '' };
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE': {
      const multi = view.type === 'MULTI_CHOICE' ? view.config : null;
      return {
        ...base,
        choices: view.config.choices.map((choice) => ({ uid: uid(), key: choice.key, labelAr: choice.labelAr, labelEn: choice.labelEn ?? '' })),
        minSelected: text(multi?.minSelected),
        maxSelected: text(multi?.maxSelected),
      };
    }
    case 'FILE':
      return { ...base, attachmentType: view.config.attachmentType, maxFiles: String(view.config.maxFiles), accept: [...view.config.accept] };
    default:
      return base;
  }
}

/** A number typed in any digits, or undefined for blank; `NaN` for text that is no number. */
function typedNumber(value: string): number | undefined {
  const trimmed = normalizeDigits(value.trim()).replace(/٫/g, '.');
  if (trimmed === '') return undefined;
  return /^-?\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

const noneIfBlank = (value: string): string | undefined => (value.trim() === '' ? undefined : value.trim());

/** The shared schema's input for a question. Numbers that are not numbers stay `NaN`, which the schema refuses. */
export function toDefinition(field: FieldDraft): unknown {
  const base = {
    key: field.key,
    type: field.type,
    labelAr: field.labelAr,
    labelEn: noneIfBlank(field.labelEn),
    helpAr: noneIfBlank(field.helpAr),
    helpEn: noneIfBlank(field.helpEn),
    linkedSource: field.linkedSource,
  };
  const choices = field.choices.map((choice) => ({ key: choice.key, labelAr: choice.labelAr, labelEn: noneIfBlank(choice.labelEn) }));
  switch (field.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT':
      return { ...base, config: { minLength: typedNumber(field.minLength), maxLength: typedNumber(field.maxLength) } };
    case 'INTEGER':
      return { ...base, config: { min: typedNumber(field.min), max: typedNumber(field.max) } };
    case 'DECIMAL':
      return { ...base, config: { min: typedNumber(field.min), max: typedNumber(field.max), decimals: typedNumber(field.decimals) } };
    case 'DATE':
      return { ...base, config: { min: noneIfBlank(field.minDate), max: noneIfBlank(field.maxDate) } };
    case 'SINGLE_CHOICE':
      return { ...base, config: { choices } };
    case 'MULTI_CHOICE':
      return { ...base, config: { choices, minSelected: typedNumber(field.minSelected), maxSelected: typedNumber(field.maxSelected) } };
    case 'FILE':
      return { ...base, config: { attachmentType: field.attachmentType, maxFiles: typedNumber(field.maxFiles), accept: field.accept } };
    default:
      return { ...base, config: {} };
  }
}

/**
 * What stops one question from being saved, in the order the manager reads the card. The shared schema is the judge: anything it
 * refuses that none of these names is `INVALID`.
 */
export function fieldProblems(field: FieldDraft): FieldProblem[] {
  const problems: FieldProblem[] = [];
  const label = field.labelAr.trim();
  if (label === '') problems.push('LABEL_REQUIRED');
  else if (Array.from(label).length > REQUEST_FIELD_LABEL_MAX) problems.push('LABEL_TOO_LONG');

  const numbers = (values: string[]) => values.map(typedNumber);
  switch (field.type) {
    case 'SHORT_TEXT':
    case 'LONG_TEXT': {
      const [lo, hi] = numbers([field.minLength, field.maxLength]);
      if (Number.isNaN(lo) || Number.isNaN(hi)) problems.push('NUMBER');
      else if (lo !== undefined && hi !== undefined && lo > hi) problems.push('RANGE');
      break;
    }
    case 'INTEGER':
    case 'DECIMAL': {
      const [lo, hi, places] = numbers([field.min, field.max, field.type === 'DECIMAL' ? field.decimals : '']);
      if (Number.isNaN(lo) || Number.isNaN(hi) || Number.isNaN(places)) problems.push('NUMBER');
      else if (lo !== undefined && hi !== undefined && lo > hi) problems.push('RANGE');
      break;
    }
    case 'DATE': {
      const lo = field.minDate.trim();
      const hi = field.maxDate.trim();
      if ((lo !== '' && !isCalendarDay(lo)) || (hi !== '' && !isCalendarDay(hi))) problems.push('DATE');
      else if (lo !== '' && hi !== '' && lo > hi) problems.push('RANGE');
      break;
    }
    case 'SINGLE_CHOICE':
    case 'MULTI_CHOICE': {
      if (field.choices.length < 2) problems.push('CHOICES_FEW');
      if (field.choices.some((choice) => choice.labelAr.trim() === '')) problems.push('CHOICE_LABEL_REQUIRED');
      if (field.type === 'MULTI_CHOICE') {
        const [lo, hi] = numbers([field.minSelected, field.maxSelected]);
        if (Number.isNaN(lo) || Number.isNaN(hi)) problems.push('NUMBER');
        else if (
          (lo !== undefined && lo > field.choices.length) ||
          (hi !== undefined && hi > field.choices.length) ||
          (lo !== undefined && hi !== undefined && lo > hi)
        ) {
          problems.push('SELECTED_RANGE');
        }
      }
      break;
    }
    case 'FILE': {
      const files = typedNumber(field.maxFiles);
      if (files === undefined || Number.isNaN(files) || !Number.isInteger(files) || files < 1 || files > REQUEST_ATTACHMENTS_MAX) {
        problems.push('FILES_RANGE');
      }
      if (field.accept.length === 0) problems.push('ACCEPT_EMPTY');
      break;
    }
    default:
      break;
  }
  if (problems.length === 0 && !requestFormFieldSchema.safeParse(toDefinition(field)).success) problems.push('INVALID');
  return problems;
}

/** Every question's problems, by its `uid`; a question with none is left out. */
export function draftProblems(fields: readonly FieldDraft[]): Map<string, FieldProblem[]> {
  const out = new Map<string, FieldProblem[]>();
  for (const field of fields) {
    const problems = fieldProblems(field);
    if (problems.length > 0) out.set(field.uid, problems);
  }
  return out;
}

/** The questions as the draft save takes them, or null while any is not valid. */
export function toSaveFields(fields: readonly FieldDraft[]): RequestFormFieldDefinition[] | null {
  if (fields.length > REQUEST_FORM_MAX_FIELDS) return null;
  const out: RequestFormFieldDefinition[] = [];
  for (const field of fields) {
    const parsed = requestFormFieldSchema.safeParse(toDefinition(field));
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

/** Whether the questions differ from those the server holds. */
export function isDirty(saved: readonly FieldDraft[], current: readonly FieldDraft[]): boolean {
  const shape = (fields: readonly FieldDraft[]) => JSON.stringify(fields.map(toDefinition));
  return shape(saved) !== shape(current);
}

export function moveField(fields: readonly FieldDraft[], index: number, delta: -1 | 1): FieldDraft[] {
  const target = index + delta;
  if (index < 0 || index >= fields.length || target < 0 || target >= fields.length) return [...fields];
  const next = [...fields];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved!);
  return next;
}

export function removeField(fields: readonly FieldDraft[], uidToRemove: string): FieldDraft[] {
  return fields.filter((field) => field.uid !== uidToRemove);
}

export function replaceField(fields: readonly FieldDraft[], next: FieldDraft): FieldDraft[] {
  return fields.map((field) => (field.uid === next.uid ? next : field));
}

/** Whether the form already asks for an identity copy (F12); when it does not, the portal adds the standard step. */
export function asksForIdentityCopy(fields: readonly FieldDraft[]): boolean {
  const valid = toSaveFields(fields);
  if (valid) return formAsksForIdentityCopy(valid);
  return fields.some((field) => field.type === 'FILE' && field.attachmentType === 'IDENTITY');
}
