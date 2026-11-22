import { requestFormFieldSchema, type RequestFormFieldDefinition } from '@mechanization/shared-schemas';
import { deleteRefusal, enableRefusal, fieldRow, fieldView, firstDuplicateKey, type StoredField } from './request-form.plan';

const def = (input: Record<string, unknown>): RequestFormFieldDefinition =>
  requestFormFieldSchema.parse({ key: 'reason', type: 'SHORT_TEXT', labelAr: 'السبب', ...input });

describe('the row a question is stored as', () => {
  it('carries the position the array gives it and nulls what was left out', () => {
    expect(fieldRow(def({}), 3)).toEqual({
      key: 'reason',
      position: 3,
      type: 'SHORT_TEXT',
      labelAr: 'السبب',
      labelEn: null,
      helpAr: null,
      helpEn: null,
      config: {},
      linkedSource: null,
    });
  });

  it('keeps a linked source and a config', () => {
    const row = fieldRow(def({ key: 'n', linkedSource: 'FIRST_NAME', config: { maxLength: 50 }, labelEn: 'Name' }), 0);
    expect(row).toMatchObject({ linkedSource: 'FIRST_NAME', config: { maxLength: 50 }, labelEn: 'Name' });
  });

  it.each([-1, 40, 1.5, Number.NaN])('refuses position %s: a form takes positions 0 to 39', (position) => {
    expect(() => fieldRow(def({}), position)).toThrow(RangeError);
  });

  it('accepts the first and the last position', () => {
    expect(fieldRow(def({}), 0).position).toBe(0);
    expect(fieldRow(def({}), 39).position).toBe(39);
  });
});

describe('a stored question read back', () => {
  const stored = (overrides: Partial<StoredField> = {}): StoredField => ({
    id: '11111111-1111-4111-8111-111111111111',
    ...fieldRow(def({ type: 'YES_NO' }), 2),
    ...overrides,
  });

  it('is the same question with its id and position', () => {
    expect(fieldView(stored())).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', position: 2, key: 'reason', type: 'YES_NO', linkedSource: null });
  });

  it('round-trips every field the row holds', () => {
    const original = def({ type: 'DECIMAL', config: { decimals: 3, min: 1 }, helpAr: 'مساعدة', labelEn: 'Area' });
    const view = fieldView({ id: 'x', ...fieldRow(original, 0) });
    expect(view).toMatchObject({ type: 'DECIMAL', config: { decimals: 3, min: 1 }, helpAr: 'مساعدة', labelEn: 'Area' });
  });

  it('is null for a row that no longer satisfies the schema, never half a question', () => {
    expect(fieldView(stored({ key: 'Not A Key' }))).toBeNull();
    expect(fieldView(stored({ config: { pattern: '.*' } }))).toBeNull();
    expect(fieldView(stored({ type: 'SINGLE_CHOICE', config: {} }))).toBeNull();
    expect(fieldView(stored({ linkedSource: 'PHONE' }))).toBeNull();
  });
});

describe('when a form may be deleted (F7)', () => {
  it('is when it is no built-in form and nobody filed on it', () => {
    expect(deleteRefusal({ systemType: null, requestCount: 0 })).toBeNull();
  });
  it('is never for a built-in form, whatever its requests', () => {
    expect(deleteRefusal({ systemType: 'CLEARANCE', requestCount: 0 })).toBe('SYSTEM_FORM');
    expect(deleteRefusal({ systemType: 'CLEARANCE', requestCount: 5 })).toBe('SYSTEM_FORM');
  });
  it('is never once a request was filed', () => {
    expect(deleteRefusal({ systemType: null, requestCount: 1 })).toBe('HAS_REQUESTS');
  });
});

describe('the first key two questions share', () => {
  it('is null when every key is its own', () => {
    expect(firstDuplicateKey([])).toBeNull();
    expect(firstDuplicateKey([{ key: 'a' }, { key: 'b' }])).toBeNull();
  });
  it('is the key at its second use', () => {
    expect(firstDuplicateKey([{ key: 'a' }, { key: 'b' }, { key: 'b' }, { key: 'a' }])).toBe('b');
  });
});

describe('switching a form on', () => {
  it('needs a published version', () => {
    expect(enableRefusal({ archivedAt: null, currentVersionId: null })).toBe('NOT_PUBLISHED');
    expect(enableRefusal({ archivedAt: null, currentVersionId: 'v' })).toBeNull();
  });
  it('is never for an archived form, which is told apart from an unfinished one', () => {
    expect(enableRefusal({ archivedAt: new Date(), currentVersionId: 'v' })).toBe('ARCHIVED');
    expect(enableRefusal({ archivedAt: new Date(), currentVersionId: null })).toBe('ARCHIVED');
  });
});
