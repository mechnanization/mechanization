import { describe, expect, it } from 'vitest';
import { requestFormFieldSchema, type OfferedRequestForm } from '@mechanization/shared-schemas';
import {
  answerIssues,
  answersToSend,
  asksOwnFields,
  blockedFields,
  copiedFields,
  fileOf,
  firstMissingStep,
  hasIdentityQuestion,
  issuesOfRefusal,
  paperFields,
  stepsFor,
  typedFields,
  unansweredPapers,
} from './request-form-fill';

let n = 0;
const field = (input: Record<string, unknown>, linkedValue?: string | null) => {
  n += 1;
  const parsed = requestFormFieldSchema.parse({ key: `q${n}`, type: 'SHORT_TEXT', labelAr: 'سؤال', ...input });
  return { ...parsed, id: `id-${n}`, position: n, ...(linkedValue !== undefined ? { linkedValue } : {}) };
};

const form = (fields: ReturnType<typeof field>[], extra: Partial<OfferedRequestForm> = {}): OfferedRequestForm => ({
  id: 'f',
  versionId: 'v',
  nameAr: 'نموذج',
  nameEn: null,
  feeAmount: 0,
  propertyMode: 'NONE',
  askCapacity: false,
  askPurpose: false,
  fields,
  ...extra,
});

describe('the questions of a form, by how they are answered', () => {
  const typed = field({ key: 'reason' });
  const copied = field({ key: 'first', linkedSource: 'FIRST_NAME' }, 'علي');
  const empty = field({ key: 'mother', linkedSource: 'MOTHER_NAME' }, null);
  const paper = field({ key: 'lease', type: 'FILE' });
  const f = form([typed, copied, empty, paper]);

  it('splits typed, copied and paper', () => {
    expect(typedFields(f).map((x) => x.key)).toEqual(['reason']);
    expect(copiedFields(f).map((x) => x.key)).toEqual(['first', 'mother']);
    expect(paperFields(f).map((x) => x.key)).toEqual(['lease']);
  });
  it('names the copied questions the file cannot fill, and none at the counter before a citizen is chosen', () => {
    expect(blockedFields(f).map((x) => x.key)).toEqual(['mother']);
    const noCitizen = form([field({ key: 'first2', linkedSource: 'FIRST_NAME' })]);
    expect(blockedFields(noCitizen)).toEqual([]);
  });
  it('rebuilds the file the validator reads from the values the server sent', () => {
    expect(fileOf(f)).toEqual({ FIRST_NAME: 'علي', MOTHER_NAME: null });
  });
});

describe('the steps a choice has', () => {
  it('are the four of a built-in type', () => {
    expect(stepsFor(null)).toEqual(['type', 'property', 'papers', 'review']);
  });
  it('leave out what a form does not ask, and always keep the papers', () => {
    expect(stepsFor(form([field({})]))).toEqual(['type', 'answers', 'papers', 'review']);
    expect(stepsFor(form([field({})], { propertyMode: 'OPTIONAL' }))).toEqual(['type', 'property', 'answers', 'papers', 'review']);
    expect(stepsFor(form([field({ type: 'FILE' })]))).toEqual(['type', 'papers', 'review']);
    expect(stepsFor(form([field({ linkedSource: 'FIRST_NAME' }, 'علي')]))).toEqual(['type', 'answers', 'papers', 'review']);
  });
  it('know when a form asks for its own fields', () => {
    expect(asksOwnFields(form([]))).toBe(false);
    expect(asksOwnFields(form([], { askCapacity: true }))).toBe(true);
    expect(asksOwnFields(form([], { askPurpose: true }))).toBe(true);
    expect(asksOwnFields(form([], { propertyMode: 'REQUIRED' }))).toBe(true);
  });
  it('see a form\'s own identity question', () => {
    expect(hasIdentityQuestion(form([field({ type: 'FILE', config: { attachmentType: 'IDENTITY' } })]))).toBe(true);
    expect(hasIdentityQuestion(form([field({ type: 'FILE' })]))).toBe(false);
  });
});

describe('what is sent', () => {
  const a = field({ key: 'a' });
  const b = field({ key: 'b', type: 'INTEGER' });
  const c = field({ key: 'c', type: 'YES_NO' });
  const d = field({ key: 'd', type: 'MULTI_CHOICE', config: { choices: [{ key: 'x', labelAr: 'س' }, { key: 'y', labelAr: 'ص' }] } });
  const link = field({ key: 'l', linkedSource: 'FIRST_NAME' }, 'علي');
  const f = form([a, b, c, d, link]);

  it('is the typed answers, trimmed, with blanks and empty lists left out and never the copied question', () => {
    expect(answersToSend(f, { a: '  نص  ', b: '', c: false, d: [], l: 'x' })).toEqual({ a: 'نص', c: false });
    expect(answersToSend(f, { a: 'x', b: '٣', d: ['y'] })).toEqual({ a: 'x', b: '٣', d: ['y'] });
  });
});

describe('the validator\'s verdict, by question', () => {
  const a = field({ key: 'a' });
  const b = field({ key: 'b', type: 'INTEGER', config: { min: 1, max: 5 } });
  const link = field({ key: 'l', linkedSource: 'FIRST_NAME' }, 'علي');
  const f = form([a, b, link]);

  it('is empty when every question holds a good answer', () => {
    expect(answerIssues(f, { a: 'نص', b: '3' })).toEqual({});
  });
  it('names the first code of each question that is not', () => {
    expect(answerIssues(f, { b: '9' })).toEqual({ a: 'REQUIRED', b: 'ABOVE_MAX' });
  });
  it('leaves a copied question the file cannot fill to its own notice', () => {
    const blocked = form([a, field({ key: 'm', linkedSource: 'MOTHER_NAME' }, null)]);
    expect(answerIssues(blocked, { a: 'نص' })).toEqual({});
  });
});

describe('a refusal\'s issues', () => {
  it('are read by question key, the first of each, and nothing from a refusal without them', () => {
    expect(
      issuesOfRefusal({
        issues: [
          { fieldKey: 'a', code: 'REQUIRED' },
          { fieldKey: 'a', code: 'TOO_LONG' },
          { fieldKey: 'b', code: 'NOT_A_DATE' },
        ],
      }),
    ).toEqual({ a: 'REQUIRED', b: 'NOT_A_DATE' });
    expect(issuesOfRefusal(undefined)).toEqual({});
    expect(issuesOfRefusal({ issues: 'nope' })).toEqual({});
    expect(issuesOfRefusal({ issues: [{ fieldKey: 1 }] })).toEqual({});
  });
});

describe('the papers still to pick', () => {
  const f = form([field({ key: 'id_copy', type: 'FILE' }), field({ key: 'lease', type: 'FILE' }), field({ key: 'x' })]);
  it('are the file questions with nothing queued', () => {
    expect(unansweredPapers(f, []).map((x) => x.key)).toEqual(['id_copy', 'lease']);
    expect(unansweredPapers(f, ['lease', undefined]).map((x) => x.key)).toEqual(['id_copy']);
    expect(unansweredPapers(f, ['id_copy', 'lease'])).toEqual([]);
  });
});

describe('the first step missing its answer', () => {
  const base = {
    steps: ['type', 'property', 'answers', 'papers', 'review'] as const,
    chosen: true,
    needsProperty: false,
    hasProperty: false,
    capacityMissing: false,
    answersMissing: false,
    blocked: false,
    papersMissing: false,
  };
  it('is review when nothing is missing', () => {
    expect(firstMissingStep(base)).toBe('review');
  });
  it('walks the steps in order', () => {
    expect(firstMissingStep({ ...base, chosen: false })).toBe('type');
    expect(firstMissingStep({ ...base, blocked: true })).toBe('type');
    expect(firstMissingStep({ ...base, needsProperty: true })).toBe('property');
    expect(firstMissingStep({ ...base, capacityMissing: true, answersMissing: true })).toBe('property');
    expect(firstMissingStep({ ...base, answersMissing: true, papersMissing: true })).toBe('answers');
    expect(firstMissingStep({ ...base, papersMissing: true })).toBe('papers');
  });
  it('skips a step the choice does not have', () => {
    const steps = ['type', 'papers', 'review'] as const;
    expect(firstMissingStep({ ...base, steps, needsProperty: true, answersMissing: true })).toBe('review');
  });
});
