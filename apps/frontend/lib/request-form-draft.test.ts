import { describe, expect, it } from 'vitest';
import { requestFormFieldSchema, type RequestFormFieldDefinition } from '@mechanization/shared-schemas';
import {
  asksForIdentityCopy,
  changeType,
  draftProblems,
  emptyChoice,
  fieldProblems,
  fromView,
  isDirty,
  linkableSources,
  moveField,
  newField,
  nextKey,
  removeField,
  replaceField,
  toDefinition,
  toSaveFields,
  type FieldDraft,
} from './request-form-draft';

const labelled = (field: FieldDraft, labelAr = 'سؤال'): FieldDraft => ({ ...field, labelAr });
const field = (type: FieldDraft['type'], extra: Partial<FieldDraft> = {}): FieldDraft => ({ ...labelled(newField(type, [])), ...extra });

describe('keys', () => {
  it('are made, never typed: the first not taken', () => {
    expect(nextKey('q', [])).toBe('q1');
    expect(nextKey('q', ['q1', 'q2'])).toBe('q3');
    expect(nextKey('q', ['q1', 'q3'])).toBe('q2');
  });
  it('give a new question and a new choice their own', () => {
    expect(newField('YES_NO', ['q1']).key).toBe('q2');
    expect(emptyChoice(['c1']).key).toBe('c2');
  });
});

describe('a new question', () => {
  it('starts with the options the schema would default to, and a choice question with two empty choices', () => {
    expect(newField('FILE', [])).toMatchObject({ attachmentType: 'OTHER', maxFiles: '1', accept: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] });
    expect(newField('DECIMAL', []).decimals).toBe('2');
    expect(newField('SINGLE_CHOICE', []).choices.map((c) => c.key)).toEqual(['c1', 'c2']);
    expect(newField('SHORT_TEXT', []).choices).toEqual([]);
  });
  it('is not valid until it has words, then is, for every type', () => {
    for (const type of ['SHORT_TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'DATE', 'PHONE', 'DOCUMENT_NUMBER', 'YES_NO', 'FILE'] as const) {
      expect(fieldProblems(newField(type, []))).toEqual(['LABEL_REQUIRED']);
      expect(fieldProblems(field(type))).toEqual([]);
    }
  });
});

describe('what stops a question from being saved', () => {
  it('names a label that is blank or too long', () => {
    expect(fieldProblems(field('YES_NO', { labelAr: '   ' }))).toContain('LABEL_REQUIRED');
    expect(fieldProblems(field('YES_NO', { labelAr: 'ا'.repeat(201) }))).toContain('LABEL_TOO_LONG');
    expect(fieldProblems(field('YES_NO', { labelAr: 'ا'.repeat(200) }))).toEqual([]);
  });
  it('names a number that is no number, and a range that is backwards', () => {
    expect(fieldProblems(field('INTEGER', { min: 'abc' }))).toEqual(['NUMBER']);
    expect(fieldProblems(field('INTEGER', { min: '5', max: '1' }))).toEqual(['RANGE']);
    expect(fieldProblems(field('INTEGER', { min: '١', max: '٩' }))).toEqual([]);
    expect(fieldProblems(field('SHORT_TEXT', { minLength: '9', maxLength: '3' }))).toEqual(['RANGE']);
    expect(fieldProblems(field('DECIMAL', { decimals: 'x' }))).toEqual(['NUMBER']);
  });
  it('lets the schema refuse what the checks above do not name', () => {
    expect(fieldProblems(field('INTEGER', { min: '1.5' }))).toEqual(['INVALID']);
    expect(fieldProblems(field('DECIMAL', { decimals: '9' }))).toEqual(['INVALID']);
  });
  it('names a date that is not on the calendar and dates backwards', () => {
    expect(fieldProblems(field('DATE', { minDate: '2026-02-30' }))).toEqual(['DATE']);
    expect(fieldProblems(field('DATE', { minDate: '2026-05-01', maxDate: '2026-04-01' }))).toEqual(['RANGE']);
    expect(fieldProblems(field('DATE', { minDate: '2026-01-01', maxDate: '2026-12-31' }))).toEqual([]);
  });
  it('names choices that are too few or have no words, and selection limits beyond them', () => {
    expect(fieldProblems(field('SINGLE_CHOICE'))).toEqual(['CHOICE_LABEL_REQUIRED']);
    const one = field('SINGLE_CHOICE', { choices: [{ uid: 'a', key: 'c1', labelAr: 'أ', labelEn: '' }] });
    expect(fieldProblems(one)).toEqual(['CHOICES_FEW']);
    const two = [
      { uid: 'a', key: 'c1', labelAr: 'أ', labelEn: '' },
      { uid: 'b', key: 'c2', labelAr: 'ب', labelEn: '' },
    ];
    expect(fieldProblems(field('MULTI_CHOICE', { choices: two }))).toEqual([]);
    expect(fieldProblems(field('MULTI_CHOICE', { choices: two, minSelected: '3' }))).toEqual(['SELECTED_RANGE']);
    expect(fieldProblems(field('MULTI_CHOICE', { choices: two, minSelected: '2', maxSelected: '1' }))).toEqual(['SELECTED_RANGE']);
  });
  it('names a file question that takes no paper or no kind of file', () => {
    expect(fieldProblems(field('FILE', { maxFiles: '0' }))).toEqual(['FILES_RANGE']);
    expect(fieldProblems(field('FILE', { maxFiles: '11' }))).toEqual(['FILES_RANGE']);
    expect(fieldProblems(field('FILE', { maxFiles: '10' }))).toEqual([]);
    expect(fieldProblems(field('FILE', { accept: [] }))).toEqual(['ACCEPT_EMPTY']);
  });
  it('lists the problems of every question, by identity, leaving out the sound ones', () => {
    const bad = newField('YES_NO', []);
    const good = field('YES_NO');
    const problems = draftProblems([bad, good]);
    expect([...problems.keys()]).toEqual([bad.uid]);
  });
});

describe('the shared schema\'s input', () => {
  it('has numbers as numbers and blank as none', () => {
    expect(toDefinition(field('INTEGER', { min: '1', max: '' }))).toMatchObject({ type: 'INTEGER', config: { min: 1, max: undefined } });
    expect(toDefinition(field('SHORT_TEXT', { labelEn: '  ' }))).toMatchObject({ labelEn: undefined });
  });
  it('is accepted by the schema once the question is sound, with its defaults filled', () => {
    const parsed = requestFormFieldSchema.parse(toDefinition(field('DECIMAL')));
    expect(parsed).toMatchObject({ type: 'DECIMAL', config: { decimals: 2 }, linkedSource: null });
  });
  it('turns a list of sound questions into the draft save, in order, and none while one is not sound', () => {
    expect(toSaveFields([field('YES_NO'), field('PHONE')])?.map((f) => f.type)).toEqual(['YES_NO', 'PHONE']);
    expect(toSaveFields([field('YES_NO'), newField('PHONE', [])])).toBeNull();
  });
  it('refuses more questions than a form takes', () => {
    const many = Array.from({ length: 41 }, (_, i) => field('YES_NO', { key: `q${i + 1}`, uid: `u${i}` }));
    expect(toSaveFields(many)).toBeNull();
    expect(toSaveFields(many.slice(0, 40))).toHaveLength(40);
  });
});

describe('a stored question in the builder, and back', () => {
  const stored = (input: Record<string, unknown>): RequestFormFieldDefinition =>
    requestFormFieldSchema.parse({ key: 'reason', type: 'SHORT_TEXT', labelAr: 'السبب', ...input });

  it.each([
    stored({ labelEn: 'Reason', helpAr: 'اشرح', config: { minLength: 3, maxLength: 30 } }),
    stored({ type: 'INTEGER', config: { min: 1, max: 9 } }),
    stored({ type: 'DECIMAL', config: { min: 0.5, decimals: 3 } }),
    stored({ type: 'DATE', config: { min: '2026-01-01', max: '2026-12-31' } }),
    stored({ type: 'PHONE', linkedSource: 'PHONE' }),
    stored({ type: 'SINGLE_CHOICE', config: { choices: [{ key: 'a', labelAr: 'أ' }, { key: 'b', labelAr: 'ب', labelEn: 'B' }] } }),
    stored({ type: 'MULTI_CHOICE', config: { choices: [{ key: 'a', labelAr: 'أ' }, { key: 'b', labelAr: 'ب' }], minSelected: 1, maxSelected: 2 } }),
    stored({ type: 'FILE', config: { attachmentType: 'IDENTITY', maxFiles: 3, accept: ['application/pdf'] } }),
    stored({ type: 'YES_NO' }),
  ])('round-trips $type to the same definition', (definition) => {
    const draft = fromView(definition);
    expect(draft.key).toBe(definition.key);
    expect(requestFormFieldSchema.parse(toDefinition(draft))).toEqual(definition);
  });
});

describe('changing a question\'s type', () => {
  it('keeps its words and key and starts its options again', () => {
    const before = field('INTEGER', { key: 'q7', labelAr: 'العدد', labelEn: 'Count', min: '1', max: '5' });
    const after = changeType(before, 'SHORT_TEXT');
    expect(after).toMatchObject({ uid: before.uid, key: 'q7', labelAr: 'العدد', labelEn: 'Count', type: 'SHORT_TEXT', min: '', max: '' });
  });
  it('keeps a link to the file only where it still fits', () => {
    const name = field('SHORT_TEXT', { linkedSource: 'FIRST_NAME' });
    expect(changeType(name, 'SHORT_TEXT').linkedSource).toBe('FIRST_NAME');
    expect(changeType(name, 'PHONE').linkedSource).toBeNull();
    expect(changeType(name, 'LONG_TEXT').linkedSource).toBeNull();
  });
  it('knows which sources a type may copy from, and a رقم مرجعي is none', () => {
    expect(linkableSources('SHORT_TEXT')).toEqual(['FIRST_NAME', 'FATHER_NAME', 'LAST_NAME', 'MOTHER_NAME']);
    expect(linkableSources('PHONE')).toEqual(['PHONE']);
    expect(linkableSources('DOCUMENT_NUMBER')).toEqual(['IDENTITY_NUMBER', 'CIVIL_RECORD_NUMBER']);
    expect(linkableSources('YES_NO')).toEqual([]);
    expect(linkableSources('FILE')).toEqual([]);
  });
});

describe('ordering', () => {
  const [a, b, c] = ['a', 'b', 'c'].map((key) => field('YES_NO', { key, uid: key }));
  it('moves a question one place, and not past either end', () => {
    expect(moveField([a!, b!, c!], 1, -1).map((f) => f.key)).toEqual(['b', 'a', 'c']);
    expect(moveField([a!, b!, c!], 1, 1).map((f) => f.key)).toEqual(['a', 'c', 'b']);
    expect(moveField([a!, b!, c!], 0, -1).map((f) => f.key)).toEqual(['a', 'b', 'c']);
    expect(moveField([a!, b!, c!], 2, 1).map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });
  it('removes and replaces by identity, without touching the list it was given', () => {
    const list = [a!, b!, c!];
    expect(removeField(list, 'b').map((f) => f.key)).toEqual(['a', 'c']);
    expect(replaceField(list, { ...b!, labelAr: 'جديد' })[1]!.labelAr).toBe('جديد');
    expect(list.map((f) => f.key)).toEqual(['a', 'b', 'c']);
  });
});

describe('unsaved changes', () => {
  it('see a changed word, a moved question and an added one; not a copy of the same', () => {
    const saved = [field('YES_NO', { uid: 'x', key: 'q1' }), field('PHONE', { uid: 'y', key: 'q2' })];
    expect(isDirty(saved, saved.map((f) => ({ ...f })))).toBe(false);
    expect(isDirty(saved, [{ ...saved[0]!, labelAr: 'غيره' }, saved[1]!])).toBe(true);
    expect(isDirty(saved, moveField(saved, 0, 1))).toBe(true);
    expect(isDirty(saved, [...saved, field('YES_NO', { key: 'q3' })])).toBe(true);
  });
});

describe('the identity copy every online request carries (F12)', () => {
  it('is noticed in a file question filed as an identity paper', () => {
    expect(asksForIdentityCopy([field('FILE', { attachmentType: 'IDENTITY' })])).toBe(true);
    expect(asksForIdentityCopy([field('FILE'), field('YES_NO')])).toBe(false);
    expect(asksForIdentityCopy([])).toBe(false);
  });
  it('is noticed while another question is not yet sound', () => {
    expect(asksForIdentityCopy([newField('YES_NO', []), field('FILE', { attachmentType: 'IDENTITY' })])).toBe(true);
  });
});
