import {
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_FORM_MAX_FIELDS,
  counterRequestBodySchema,
  createRequestFormSchema,
  formAsksForIdentityCopy,
  formPublishIssues,
  isFormRequestBody,
  onlineRequestBodySchema,
  requestFormFieldSchema,
  requestFeeAmountSchema,
  saveRequestFormDraftSchema,
  submitOnlineFormRequestSchema,
  updateRequestTypeSettingSchema,
  type RequestFormFieldDefinition,
} from '@mechanization/shared-schemas';

/**
 * The request form contract (Story 4, docs/request-forms-plan.md): the field catalogue, the manager's inputs and the
 * two shapes of a request body. Each case changes one thing from a body that passes, so a failure can only be that thing.
 */
const ID = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';

const field = (overrides: Record<string, unknown> = {}) => ({
  key: 'reason',
  type: 'SHORT_TEXT',
  labelAr: 'السبب',
  ...overrides,
});

const parse = (input: unknown) => requestFormFieldSchema.safeParse(input);
const parsed = (input: unknown): RequestFormFieldDefinition => {
  const result = parse(input);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data;
};

describe('a field definition', () => {
  it('takes the smallest valid question and fills the rest', () => {
    const definition = parsed(field());
    expect(definition).toMatchObject({ key: 'reason', type: 'SHORT_TEXT', labelAr: 'السبب', linkedSource: null, config: {} });
    expect(definition.labelEn).toBeUndefined();
  });

  it('trims the label and reads a blank English label as none', () => {
    const definition = parsed(field({ labelAr: '  السبب  ', labelEn: '   ' }));
    expect(definition.labelAr).toBe('السبب');
    expect(definition.labelEn).toBeUndefined();
  });

  it.each([
    ['an upper case key', { key: 'Reason' }],
    ['a key starting with a digit', { key: '1reason' }],
    ['a key with a space', { key: 'my reason' }],
    ['a key of 41 characters', { key: `a${'b'.repeat(40)}` }],
    ['an Arabic key', { key: 'سبب' }],
    ['no Arabic label', { labelAr: '' }],
    ['a label of 201 characters', { labelAr: 'ا'.repeat(201) }],
    ['help of 501 characters', { helpAr: 'ا'.repeat(501) }],
    ['a type the catalogue does not have', { type: 'REGEX' }],
    ['a key the field does not know', { required: false }],
    ['a pattern the manager typed', { config: { pattern: '.*' } }],
  ])('refuses %s', (_name, overrides) => {
    expect(parse(field(overrides)).success).toBe(false);
  });

  it('accepts a 40 character key', () => {
    expect(parse(field({ key: `a${'b'.repeat(39)}` })).success).toBe(true);
  });

  describe('text', () => {
    it('refuses a minimum above the maximum', () => {
      expect(parse(field({ config: { minLength: 10, maxLength: 5 } })).success).toBe(false);
    });
    it('refuses a maximum above the ceiling of the type', () => {
      expect(parse(field({ config: { maxLength: 501 } })).success).toBe(false);
      expect(parse(field({ type: 'LONG_TEXT', config: { maxLength: 5000 } })).success).toBe(true);
      expect(parse(field({ type: 'LONG_TEXT', config: { maxLength: 5001 } })).success).toBe(false);
    });
  });

  describe('numbers', () => {
    it('refuses a minimum above the maximum', () => {
      expect(parse(field({ type: 'INTEGER', config: { min: 5, max: 1 } })).success).toBe(false);
      expect(parse(field({ type: 'DECIMAL', config: { min: 5, max: 1 } })).success).toBe(false);
    });
    it('refuses a bound that is not a whole number on an integer question', () => {
      expect(parse(field({ type: 'INTEGER', config: { min: 0.5 } })).success).toBe(false);
    });
    it('defaults a decimal question to two places and refuses more than four', () => {
      expect(parsed(field({ type: 'DECIMAL' }))).toMatchObject({ config: { decimals: 2 } });
      expect(parse(field({ type: 'DECIMAL', config: { decimals: 4 } })).success).toBe(true);
      expect(parse(field({ type: 'DECIMAL', config: { decimals: 5 } })).success).toBe(false);
      expect(parse(field({ type: 'DECIMAL', config: { decimals: 0 } })).success).toBe(false);
    });
  });

  describe('dates', () => {
    it('refuses a day that is not on the calendar', () => {
      expect(parse(field({ type: 'DATE', config: { min: '2026-02-30' } })).success).toBe(false);
    });
    it('refuses a minimum after the maximum', () => {
      expect(parse(field({ type: 'DATE', config: { min: '2026-05-01', max: '2026-04-01' } })).success).toBe(false);
      expect(parse(field({ type: 'DATE', config: { min: '2026-04-01', max: '2026-04-01' } })).success).toBe(true);
    });
  });

  describe('choices', () => {
    const choices = (keys: string[]) => keys.map((key) => ({ key, labelAr: `خيار ${key}` }));

    it('needs two choices', () => {
      expect(parse(field({ type: 'SINGLE_CHOICE', config: { choices: choices(['a']) } })).success).toBe(false);
      expect(parse(field({ type: 'SINGLE_CHOICE', config: { choices: choices(['a', 'b']) } })).success).toBe(true);
    });
    it('refuses a question with no choices at all', () => {
      expect(parse(field({ type: 'SINGLE_CHOICE' })).success).toBe(false);
      expect(parse(field({ type: 'MULTI_CHOICE', config: {} })).success).toBe(false);
    });
    it('refuses two choices with one key, and says which', () => {
      const result = parse(field({ type: 'SINGLE_CHOICE', config: { choices: choices(['a', 'b', 'a']) } }));
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toContain('config.choices.2.key');
    });
    it('takes at most 50 choices', () => {
      const keys = Array.from({ length: 51 }, (_, i) => `k${i}`);
      expect(parse(field({ type: 'SINGLE_CHOICE', config: { choices: choices(keys) } })).success).toBe(false);
      expect(parse(field({ type: 'SINGLE_CHOICE', config: { choices: choices(keys.slice(0, 50)) } })).success).toBe(true);
    });
    it('keeps the selection limits of a multiple choice inside the choices', () => {
      const base = { type: 'MULTI_CHOICE' };
      const cfg = (extra: Record<string, unknown>) => ({ choices: choices(['a', 'b', 'c']), ...extra });
      expect(parse(field({ ...base, config: cfg({ minSelected: 1, maxSelected: 3 }) })).success).toBe(true);
      expect(parse(field({ ...base, config: cfg({ minSelected: 4 }) })).success).toBe(false);
      expect(parse(field({ ...base, config: cfg({ maxSelected: 4 }) })).success).toBe(false);
      expect(parse(field({ ...base, config: cfg({ minSelected: 3, maxSelected: 2 }) })).success).toBe(false);
    });
  });

  describe('files', () => {
    it('defaults to one paper of any kind the request takes, filed as «مستند آخر»', () => {
      const definition = parsed(field({ type: 'FILE' }));
      expect(definition).toMatchObject({ config: { attachmentType: 'OTHER', maxFiles: 1 } });
      expect((definition.config as { accept: string[] }).accept).toEqual(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
    });
    it('never promises more papers than a request takes', () => {
      expect(parse(field({ type: 'FILE', config: { maxFiles: REQUEST_ATTACHMENTS_MAX } })).success).toBe(true);
      expect(parse(field({ type: 'FILE', config: { maxFiles: REQUEST_ATTACHMENTS_MAX + 1 } })).success).toBe(false);
      expect(parse(field({ type: 'FILE', config: { maxFiles: 0 } })).success).toBe(false);
    });
    it('takes only the kinds of file the server sniffs, once each', () => {
      expect(parse(field({ type: 'FILE', config: { accept: ['application/pdf'] } })).success).toBe(true);
      expect(parse(field({ type: 'FILE', config: { accept: ['application/zip'] } })).success).toBe(false);
      expect(parse(field({ type: 'FILE', config: { accept: [] } })).success).toBe(false);
      expect(parse(field({ type: 'FILE', config: { accept: ['application/pdf', 'application/pdf'] } })).success).toBe(false);
    });
    it('does not take a size: the request\'s own limit stands', () => {
      expect(parse(field({ type: 'FILE', config: { maxBytes: 10_000_000 } })).success).toBe(false);
    });
  });

  describe('linked to the file', () => {
    it.each([
      ['SHORT_TEXT', 'FIRST_NAME'],
      ['SHORT_TEXT', 'FATHER_NAME'],
      ['SHORT_TEXT', 'LAST_NAME'],
      ['SHORT_TEXT', 'MOTHER_NAME'],
      ['PHONE', 'PHONE'],
      ['DOCUMENT_NUMBER', 'IDENTITY_NUMBER'],
      ['DOCUMENT_NUMBER', 'CIVIL_RECORD_NUMBER'],
    ])('lets a %s question be linked to %s', (type, linkedSource) => {
      expect(parsed(field({ type, linkedSource }))).toMatchObject({ linkedSource });
    });

    it.each([
      ['a phone source on a text question', 'SHORT_TEXT', 'PHONE'],
      ['a name source on a phone question', 'PHONE', 'FIRST_NAME'],
      ['an identity source on a text question', 'SHORT_TEXT', 'IDENTITY_NUMBER'],
      ['any source on a long text question', 'LONG_TEXT', 'FIRST_NAME'],
      ['any source on a yes or no question', 'YES_NO', 'FIRST_NAME'],
      ['any source on a file question', 'FILE', 'IDENTITY_NUMBER'],
      ['a source that does not exist (a رقم مرجعي is never a source)', 'DOCUMENT_NUMBER', 'REFERENCE_NUMBER'],
    ])('refuses %s', (_name, type, linkedSource) => {
      expect(parse(field({ type, linkedSource })).success).toBe(false);
    });
  });
});

describe('the manager\'s inputs', () => {
  const settings = {
    nameAr: 'إفادة سكن',
    feeAmount: 50_000,
    propertyMode: 'OPTIONAL',
    askCapacity: false,
    askPurpose: true,
  };

  it('creates a form from its settings', () => {
    expect(createRequestFormSchema.parse(settings)).toMatchObject({ nameAr: 'إفادة سكن', feeAmount: 50_000, sortOrder: 0 });
  });

  it.each([
    ['no name', { nameAr: '  ' }],
    ['a name of 201 characters', { nameAr: 'ا'.repeat(201) }],
    ['a negative fee', { feeAmount: -1 }],
    ['a fee with piastres', { feeAmount: 1.5 }],
    ['a fee a billion over', { feeAmount: 1_000_000_001 }],
    ['an unknown property mode', { propertyMode: 'MAYBE' }],
    ['a template of 5001 characters', { statementTemplate: 'ا'.repeat(5001) }],
    ['a setting that is not one', { enabled: true }],
  ])('refuses %s', (_name, overrides) => {
    expect(createRequestFormSchema.safeParse({ ...settings, ...overrides }).success).toBe(false);
  });

  it('shares the fee rule with the request type setting', () => {
    for (const fee of [0, 50_000, '50000', 1_000_000_000]) {
      expect(requestFeeAmountSchema.safeParse(fee).success).toBe(true);
      expect(updateRequestTypeSettingSchema.safeParse({ enabled: true, feeAmount: fee }).success).toBe(true);
    }
    for (const fee of [-1, 0.5, 1_000_000_001, 'abc']) {
      expect(requestFeeAmountSchema.safeParse(fee).success).toBe(false);
      expect(updateRequestTypeSettingSchema.safeParse({ enabled: true, feeAmount: fee }).success).toBe(false);
    }
  });

  describe('saving a draft', () => {
    const draft = (fields: unknown[], expectedRevision: unknown = 1) => ({ expectedRevision, fields });

    it('takes questions in order', () => {
      const result = saveRequestFormDraftSchema.parse(draft([field(), field({ key: 'other', type: 'YES_NO' })]));
      expect(result.fields.map((f) => f.key)).toEqual(['reason', 'other']);
    });
    it('takes an empty draft: publishing is what needs a question', () => {
      expect(saveRequestFormDraftSchema.safeParse(draft([])).success).toBe(true);
    });
    it('needs the revision the editor read', () => {
      expect(saveRequestFormDraftSchema.safeParse({ fields: [] }).success).toBe(false);
      expect(saveRequestFormDraftSchema.safeParse(draft([], 0)).success).toBe(false);
      expect(saveRequestFormDraftSchema.safeParse(draft([], 1.5)).success).toBe(false);
    });
    it('refuses two questions with one key', () => {
      expect(saveRequestFormDraftSchema.safeParse(draft([field(), field()])).success).toBe(false);
    });
    it('takes at most 40 questions', () => {
      const many = (n: number) => Array.from({ length: n }, (_, i) => field({ key: `q${i}` }));
      expect(saveRequestFormDraftSchema.safeParse(draft(many(REQUEST_FORM_MAX_FIELDS))).success).toBe(true);
      expect(saveRequestFormDraftSchema.safeParse(draft(many(REQUEST_FORM_MAX_FIELDS + 1))).success).toBe(false);
    });
  });
});

describe('what stops a draft being published', () => {
  const fields = (...input: unknown[]) => input.map(parsed);

  it('is nothing for a form with questions', () => {
    expect(formPublishIssues(fields(field()))).toEqual([]);
  });
  it('is no questions', () => {
    expect(formPublishIssues([])).toEqual([{ code: 'NO_FIELDS' }]);
  });
  it('is a duplicate key, naming it', () => {
    expect(formPublishIssues(fields(field(), field()))).toEqual([{ code: 'DUPLICATE_KEY', fieldKey: 'reason' }]);
  });
});

describe('the identity copy every online request carries (F12)', () => {
  it('is asked by a file question filed as an identity paper', () => {
    expect(formAsksForIdentityCopy(fields(field({ key: 'id_copy', type: 'FILE', config: { attachmentType: 'IDENTITY' } })))).toBe(true);
  });
  it('is not asked by a question of another kind, or a file of another paper', () => {
    expect(formAsksForIdentityCopy([])).toBe(false);
    expect(formAsksForIdentityCopy(fields(field()))).toBe(false);
    expect(formAsksForIdentityCopy(fields(field({ type: 'FILE' })))).toBe(false);
  });

  function fields(...input: unknown[]) {
    return input.map(parsed);
  }
});

describe('a request body', () => {
  const answers = { reason: 'سبب' };
  const onForm = { formId: ID, answers, clientRequestId: KEY };
  const legacy = { requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: KEY };

  it('on a form carries the form, its answers and a retry key', () => {
    expect(submitOnlineFormRequestSchema.parse(onForm)).toMatchObject({ formId: ID, answers });
  });

  it('on a form needs no capacity, and answers default to none', () => {
    const { answers: _answers, ...bare } = onForm;
    expect(submitOnlineFormRequestSchema.parse(bare).answers).toEqual({});
  });

  it('on a form refuses a request type beside the form id: two requests in one', () => {
    expect(submitOnlineFormRequestSchema.safeParse({ ...onForm, requestType: 'OTHER' }).success).toBe(false);
  });

  it('on a form refuses a unit with no card', () => {
    expect(submitOnlineFormRequestSchema.safeParse({ ...onForm, buildingUnitId: ID }).success).toBe(false);
    expect(submitOnlineFormRequestSchema.safeParse({ ...onForm, buildingUnitId: ID, propertyEntryId: ID }).success).toBe(true);
  });

  it.each([
    ['a key that is not a field key', { 'Bad Key': 'x' }],
    ['an object as an answer', { reason: { a: 1 } }],
    ['a list of non-text', { reason: [1, 2] }],
    ['a text of 5001 characters', { reason: 'ا'.repeat(5001) }],
    ['an infinite number', { reason: Number.POSITIVE_INFINITY }],
  ])('on a form refuses %s', (_name, bad) => {
    expect(submitOnlineFormRequestSchema.safeParse({ ...onForm, answers: bad }).success).toBe(false);
  });

  it('on a form refuses more than 40 answers', () => {
    const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`q${i}`, 'x']));
    expect(submitOnlineFormRequestSchema.safeParse({ ...onForm, answers: many }).success).toBe(false);
  });

  describe('the route\'s body: the request of 0092, or a request on a form', () => {
    it('reads a body with no form id as the request of 0092, untouched', () => {
      expect(onlineRequestBodySchema.parse(legacy)).toMatchObject({ requestType: 'OTHER', applicantCapacity: 'OWNER' });
    });
    it('reads a body with a form id as a request on a form', () => {
      const body = onlineRequestBodySchema.parse(onForm);
      expect(isFormRequestBody(body)).toBe(true);
      expect(isFormRequestBody(onlineRequestBodySchema.parse(legacy))).toBe(false);
    });
    it('keeps the error of the schema it chose, with its path', () => {
      const result = onlineRequestBodySchema.safeParse({ ...onForm, formId: 'nope' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues.map((i) => i.path.join('.'))).toEqual(['formId']);
      const old = onlineRequestBodySchema.safeParse({ ...legacy, applicantCapacity: 'NOBODY' });
      expect(old.success).toBe(false);
      if (!old.success) expect(old.error.issues.map((i) => i.path.join('.'))).toEqual(['applicantCapacity']);
    });
    it('refuses something that is not an object', () => {
      expect(onlineRequestBodySchema.safeParse(null).success).toBe(false);
      expect(onlineRequestBodySchema.safeParse('x').success).toBe(false);
    });
    it('the counter\'s names the citizen in both shapes', () => {
      expect(counterRequestBodySchema.safeParse({ ...onForm, citizenId: ID }).success).toBe(true);
      expect(counterRequestBodySchema.safeParse(onForm).success).toBe(false);
      expect(counterRequestBodySchema.safeParse({ ...legacy, citizenId: ID }).success).toBe(true);
      expect(counterRequestBodySchema.safeParse(legacy).success).toBe(false);
    });
  });
});
