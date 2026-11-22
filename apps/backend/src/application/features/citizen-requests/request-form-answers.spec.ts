import {
  REQUEST_ANSWER_ISSUE_CODES,
  answerValueForCitizen,
  answerableFields,
  emptyLinkedFields,
  fileFields,
  linkedFields,
  linkedValueFor,
  maskIdentityNumber,
  parseAnswers,
  requestFormFieldSchema,
  type CitizenFileValues,
  type RequestAnswerIssue,
  type RequestFormFieldDefinition,
} from '@mechanization/shared-schemas';

/**
 * The answers validator both apps run (Story 4, open decisions §24 F4, F8): every field is required, a linked field is
 * the file's and never typed, and each type refuses what is not its own. Each case changes one thing from an answer that
 * passes, so a failure can only be that thing.
 */
const def = (input: Record<string, unknown>): RequestFormFieldDefinition => requestFormFieldSchema.parse({ labelAr: 'سؤال', ...input });
const choices = (...keys: string[]) => keys.map((key) => ({ key, labelAr: key }));

const FILE_OF_CITIZEN: CitizenFileValues = {
  FIRST_NAME: 'علي',
  FATHER_NAME: 'حسن',
  LAST_NAME: 'ناصر',
  MOTHER_NAME: '',
  PHONE: '+96171123456',
  IDENTITY_NUMBER: '  123456789  ',
  CIVIL_RECORD_NUMBER: null,
};

/** Parses one question alone; returns its stored value or its issue. */
function one(field: Record<string, unknown>, raw: unknown): { value: unknown } | { issue: RequestAnswerIssue } {
  const definition = def({ key: 'q', ...field });
  const result = parseAnswers([definition], raw === undefined ? {} : { q: raw }, {});
  if (result.ok) return { value: result.answers[0]!.value };
  return { issue: result.issues[0]! };
}
const value = (field: Record<string, unknown>, raw: unknown) => (one(field, raw) as { value: unknown }).value;
const code = (field: Record<string, unknown>, raw: unknown) => (one(field, raw) as { issue: RequestAnswerIssue }).issue.code;

describe('every field is required', () => {
  it.each([
    ['SHORT_TEXT', {}],
    ['LONG_TEXT', {}],
    ['INTEGER', {}],
    ['DECIMAL', {}],
    ['DATE', {}],
    ['PHONE', {}],
    ['DOCUMENT_NUMBER', {}],
    ['SINGLE_CHOICE', { config: { choices: choices('a', 'b') } }],
    ['MULTI_CHOICE', { config: { choices: choices('a', 'b') } }],
    ['YES_NO', {}],
  ])('a %s with no answer, null, or blank is REQUIRED', (type, extra) => {
    for (const raw of [undefined, null, '', '   ']) {
      expect(code({ type, ...extra }, raw)).toBe('REQUIRED');
    }
  });

  it('an empty list of choices is REQUIRED', () => {
    expect(code({ type: 'MULTI_CHOICE', config: { choices: choices('a', 'b') } }, [])).toBe('REQUIRED');
  });

  it('«لا» is an answer, and so is zero', () => {
    expect(value({ type: 'YES_NO' }, false)).toBe(false);
    expect(value({ type: 'INTEGER' }, 0)).toBe(0);
    expect(value({ type: 'INTEGER' }, '٠')).toBe(0);
  });
});

describe('text', () => {
  it('is trimmed', () => {
    expect(value({ type: 'SHORT_TEXT' }, '  مرحبا  ')).toBe('مرحبا');
  });
  it('counts characters, not code units', () => {
    expect(value({ type: 'SHORT_TEXT', config: { maxLength: 2 } }, '😀😀')).toBe('😀😀');
    expect(code({ type: 'SHORT_TEXT', config: { maxLength: 2 } }, '😀😀😀')).toBe('TOO_LONG');
  });
  it('is TOO_SHORT and TOO_LONG at the bounds, naming them', () => {
    const field = { type: 'SHORT_TEXT', config: { minLength: 3, maxLength: 5 } };
    expect(code(field, 'اب')).toBe('TOO_SHORT');
    expect(value(field, 'ابج')).toBe('ابج');
    expect(value(field, 'ابجده')).toBe('ابجده');
    expect(code(field, 'ابجدهو')).toBe('TOO_LONG');
    expect((one(field, 'اب') as { issue: RequestAnswerIssue }).issue.params).toEqual({ min: 3 });
    expect((one(field, 'ابجدهو') as { issue: RequestAnswerIssue }).issue.params).toEqual({ max: 5 });
  });
  it('stops a short text at 500 and a long text at 5000 when the form sets no bound', () => {
    expect(code({ type: 'SHORT_TEXT' }, 'ا'.repeat(501))).toBe('TOO_LONG');
    expect(value({ type: 'SHORT_TEXT' }, 'ا'.repeat(500))).toHaveLength(500);
    expect(code({ type: 'LONG_TEXT' }, 'ا'.repeat(5001))).toBe('TOO_LONG');
    expect(value({ type: 'LONG_TEXT' }, 'ا'.repeat(5000))).toHaveLength(5000);
  });
  it.each([5, true, ['a'], { a: 1 }])('is WRONG_TYPE for %j', (raw) => {
    expect(code({ type: 'SHORT_TEXT' }, raw)).toBe('WRONG_TYPE');
  });
});

describe('integers', () => {
  it.each([
    [7, 7],
    ['7', 7],
    ['  -7 ', -7],
    ['٧', 7],
    ['۱۲', 12],
    [7.0, 7],
  ])('reads %j as %j', (raw, expected) => {
    expect(value({ type: 'INTEGER' }, raw)).toBe(expected);
  });
  it.each(['abc', '7.5.1', '1e3', '٧٫٥٫٥', '--7', '7,000', true, Number.NaN, Number.POSITIVE_INFINITY])('is NOT_A_NUMBER for %j', (raw) => {
    expect(code({ type: 'INTEGER' }, raw)).toBe('NOT_A_NUMBER');
  });
  it.each([7.5, '7.5', '٧٫٥'])('is NOT_INTEGER for %j', (raw) => {
    expect(code({ type: 'INTEGER' }, raw)).toBe('NOT_INTEGER');
  });
  it('holds the bounds, inclusive', () => {
    const field = { type: 'INTEGER', config: { min: 1, max: 10 } };
    expect(code(field, 0)).toBe('BELOW_MIN');
    expect(value(field, 1)).toBe(1);
    expect(value(field, 10)).toBe(10);
    expect(code(field, 11)).toBe('ABOVE_MAX');
    expect((one(field, 0) as { issue: RequestAnswerIssue }).issue.params).toEqual({ min: 1 });
  });
  it('is never past the bound a JSON number holds exactly', () => {
    expect(code({ type: 'INTEGER' }, 1_000_000_000_000)).toBe('ABOVE_MAX');
    expect(code({ type: 'INTEGER' }, -1_000_000_000_000)).toBe('ABOVE_MAX');
    expect(value({ type: 'INTEGER' }, 999_999_999_999)).toBe(999_999_999_999);
  });
});

describe('decimals', () => {
  it.each([
    ['1.5', 1.5],
    ['١٫٥', 1.5],
    [1.25, 1.25],
    ['3', 3],
  ])('reads %j as %j', (raw, expected) => {
    expect(value({ type: 'DECIMAL' }, raw)).toBe(expected);
  });
  it('refuses more places than the question asks for, by default two', () => {
    expect(code({ type: 'DECIMAL' }, '1.234')).toBe('TOO_MANY_DECIMALS');
    expect(code({ type: 'DECIMAL' }, 1.234)).toBe('TOO_MANY_DECIMALS');
    expect(value({ type: 'DECIMAL', config: { decimals: 3 } }, '1.234')).toBe(1.234);
    expect(code({ type: 'DECIMAL', config: { decimals: 1 } }, '1.25')).toBe('TOO_MANY_DECIMALS');
  });
  it('refuses a number so small it is written with an exponent', () => {
    expect(code({ type: 'DECIMAL' }, 1e-7)).toBe('TOO_MANY_DECIMALS');
  });
  it('holds the bounds, inclusive', () => {
    const field = { type: 'DECIMAL', config: { min: 0.5, max: 2.5, decimals: 2 } };
    expect(code(field, 0.49)).toBe('BELOW_MIN');
    expect(value(field, 0.5)).toBe(0.5);
    expect(value(field, 2.5)).toBe(2.5);
    expect(code(field, 2.51)).toBe('ABOVE_MAX');
  });
  it('is NOT_A_NUMBER for text', () => {
    expect(code({ type: 'DECIMAL' }, 'x')).toBe('NOT_A_NUMBER');
  });
});

describe('dates', () => {
  it('takes a calendar day, also in Arabic-Indic digits', () => {
    expect(value({ type: 'DATE' }, '2026-02-28')).toBe('2026-02-28');
    expect(value({ type: 'DATE' }, '٢٠٢٦-٠٢-٢٨')).toBe('2026-02-28');
  });
  it.each(['2026-02-30', '2026-13-01', '2026-2-3', '28/02/2026', 'yesterday', '2026-10-00'])('is NOT_A_DATE for %j', (raw) => {
    expect(code({ type: 'DATE' }, raw)).toBe('NOT_A_DATE');
  });
  it('is WRONG_TYPE for a number', () => {
    expect(code({ type: 'DATE' }, 20260228)).toBe('WRONG_TYPE');
  });
  it('holds the bounds, inclusive', () => {
    const field = { type: 'DATE', config: { min: '2026-01-01', max: '2026-12-31' } };
    expect(code(field, '2025-12-31')).toBe('BEFORE_MIN_DATE');
    expect(value(field, '2026-01-01')).toBe('2026-01-01');
    expect(value(field, '2026-12-31')).toBe('2026-12-31');
    expect(code(field, '2027-01-01')).toBe('AFTER_MAX_DATE');
  });
});

describe('phone and document numbers', () => {
  it('stores a phone as the primitive does, E.164', () => {
    expect(value({ type: 'PHONE' }, '71 123 456')).toBe('+96171123456');
    expect(value({ type: 'PHONE' }, '+33 1 23 45 67 89')).toBe('+33123456789');
  });
  it('refuses a phone that is not one', () => {
    expect(code({ type: 'PHONE' }, '12')).toBe('INVALID_PHONE');
    expect(code({ type: 'PHONE' }, 'abc')).toBe('INVALID_PHONE');
    expect(code({ type: 'PHONE' }, 71123456)).toBe('WRONG_TYPE');
  });
  it('trims a document number and reads Arabic-Indic digits', () => {
    expect(value({ type: 'DOCUMENT_NUMBER' }, '  ١٢٣٤٥٦  ')).toBe('123456');
  });
  it('refuses a document number that is too short or too long', () => {
    expect(code({ type: 'DOCUMENT_NUMBER' }, '12')).toBe('INVALID_DOCUMENT_NUMBER');
    expect(code({ type: 'DOCUMENT_NUMBER' }, '1'.repeat(41))).toBe('INVALID_DOCUMENT_NUMBER');
    expect(code({ type: 'DOCUMENT_NUMBER' }, 123456)).toBe('WRONG_TYPE');
  });
});

describe('choices', () => {
  const single = { type: 'SINGLE_CHOICE', config: { choices: choices('a', 'b', 'c') } };
  const multi = (extra: Record<string, unknown> = {}) => ({ type: 'MULTI_CHOICE', config: { choices: choices('a', 'b', 'c'), ...extra } });

  it('takes the key of one choice', () => {
    expect(value(single, 'b')).toBe('b');
  });
  it('refuses a key that is not a choice, and a label', () => {
    expect(code(single, 'z')).toBe('NOT_A_CHOICE');
    expect(code(single, 'خيار')).toBe('NOT_A_CHOICE');
    expect(code(single, ['a'])).toBe('WRONG_TYPE');
  });
  it('takes several keys, kept in the order the form lists them', () => {
    expect(value(multi(), ['c', 'a'])).toEqual(['a', 'c']);
  });
  it('refuses a key that is not a choice, a repeat, and a non-list', () => {
    expect(code(multi(), ['a', 'z'])).toBe('NOT_A_CHOICE');
    expect(code(multi(), ['a', 'a'])).toBe('DUPLICATE_CHOICE');
    expect(code(multi(), 'a')).toBe('WRONG_TYPE');
    expect(code(multi(), ['a', 1])).toBe('WRONG_TYPE');
  });
  it('holds the number selected, one at least by default', () => {
    expect(value(multi(), ['a'])).toEqual(['a']);
    expect(code(multi({ minSelected: 2 }), ['a'])).toBe('TOO_FEW_CHOICES');
    expect(value(multi({ minSelected: 2, maxSelected: 2 }), ['a', 'b'])).toEqual(['a', 'b']);
    expect(code(multi({ maxSelected: 2 }), ['a', 'b', 'c'])).toBe('TOO_MANY_CHOICES');
  });
});

describe('yes or no', () => {
  it('takes a boolean only', () => {
    expect(value({ type: 'YES_NO' }, true)).toBe(true);
    for (const raw of ['true', 'نعم', 1, 0, 'yes']) expect(code({ type: 'YES_NO' }, raw)).toBe('NOT_YES_NO');
  });
});

describe('a whole form', () => {
  const form = [
    def({ key: 'first_name', type: 'SHORT_TEXT', linkedSource: 'FIRST_NAME' }),
    def({ key: 'mother', type: 'SHORT_TEXT', linkedSource: 'MOTHER_NAME' }),
    def({ key: 'civil', type: 'DOCUMENT_NUMBER', linkedSource: 'CIVIL_RECORD_NUMBER' }),
    def({ key: 'reason', type: 'LONG_TEXT' }),
    def({ key: 'family', type: 'INTEGER' }),
    def({ key: 'id_copy', type: 'FILE', config: { attachmentType: 'IDENTITY' } }),
  ];
  const completeFile: CitizenFileValues = { ...FILE_OF_CITIZEN, MOTHER_NAME: 'زينب', CIVIL_RECORD_NUMBER: '45' };
  const typed = { reason: 'سبب', family: '4' };

  it('returns the rows in the form\'s order, a file question holding none', () => {
    const result = parseAnswers(form, typed, completeFile);
    expect(result).toEqual({
      ok: true,
      answers: [
        { fieldKey: 'first_name', type: 'SHORT_TEXT', value: 'علي', origin: 'FROM_FILE' },
        { fieldKey: 'mother', type: 'SHORT_TEXT', value: 'زينب', origin: 'FROM_FILE' },
        { fieldKey: 'civil', type: 'DOCUMENT_NUMBER', value: '45', origin: 'FROM_FILE' },
        { fieldKey: 'reason', type: 'LONG_TEXT', value: 'سبب', origin: 'ANSWERED' },
        { fieldKey: 'family', type: 'INTEGER', value: 4, origin: 'ANSWERED' },
      ],
    });
  });

  it('copies the file\'s value trimmed, and does not check it against the question\'s own rules', () => {
    const result = parseAnswers([def({ key: 'idn', type: 'DOCUMENT_NUMBER', linkedSource: 'IDENTITY_NUMBER' })], {}, FILE_OF_CITIZEN);
    expect(result).toMatchObject({ ok: true, answers: [{ value: '123456789', origin: 'FROM_FILE' }] });
  });

  it('refuses a request whose file leaves a linked question empty, blank or null alike (F4)', () => {
    const result = parseAnswers(form, typed, FILE_OF_CITIZEN);
    expect(result).toEqual({
      ok: false,
      issues: [
        { fieldKey: 'mother', code: 'LINKED_FIELD_EMPTY' },
        { fieldKey: 'civil', code: 'LINKED_FIELD_EMPTY' },
      ],
    });
  });

  it('refuses a value sent for a linked question: it is the file\'s', () => {
    const result = parseAnswers(form, { ...typed, first_name: 'غيره' }, completeFile);
    expect(result).toEqual({ ok: false, issues: [{ fieldKey: 'first_name', code: 'LINKED_FIELD_NOT_ANSWERABLE' }] });
  });

  it('refuses a key that is no question, and a file question\'s key', () => {
    const result = parseAnswers(form, { ...typed, nope: 'x', id_copy: 'x' }, completeFile);
    expect(result).toEqual({
      ok: false,
      issues: [
        { fieldKey: 'nope', code: 'UNKNOWN_FIELD' },
        { fieldKey: 'id_copy', code: 'UNKNOWN_FIELD' },
      ],
    });
  });

  it('reports every issue at once, not the first', () => {
    const result = parseAnswers(form, { family: 'x' }, completeFile);
    expect(result).toEqual({
      ok: false,
      issues: [
        { fieldKey: 'reason', code: 'REQUIRED' },
        { fieldKey: 'family', code: 'NOT_A_NUMBER' },
      ],
    });
  });

  it('is a success with no answers for a form with no typed question', () => {
    expect(parseAnswers([def({ key: 'id_copy', type: 'FILE' })], {}, {})).toEqual({ ok: true, answers: [] });
  });

  it('does not mutate what it was given', () => {
    const raw = { reason: '  سبب  ', family: '4' };
    parseAnswers(form, raw, completeFile);
    expect(raw).toEqual({ reason: '  سبب  ', family: '4' });
  });

  it('splits a form into what is typed, what is copied, and what is a paper', () => {
    expect(answerableFields(form).map((f) => f.key)).toEqual(['reason', 'family']);
    expect(linkedFields(form).map((f) => f.key)).toEqual(['first_name', 'mother', 'civil']);
    expect(fileFields(form).map((f) => f.key)).toEqual(['id_copy']);
    expect(emptyLinkedFields(form, FILE_OF_CITIZEN).map((f) => f.key)).toEqual(['mother', 'civil']);
    expect(emptyLinkedFields(form, completeFile)).toEqual([]);
  });
});

describe('linkedValueFor', () => {
  it('is the trimmed value, or null for nothing', () => {
    expect(linkedValueFor('FIRST_NAME', FILE_OF_CITIZEN)).toBe('علي');
    expect(linkedValueFor('IDENTITY_NUMBER', FILE_OF_CITIZEN)).toBe('123456789');
    expect(linkedValueFor('MOTHER_NAME', FILE_OF_CITIZEN)).toBeNull();
    expect(linkedValueFor('CIVIL_RECORD_NUMBER', FILE_OF_CITIZEN)).toBeNull();
    expect(linkedValueFor('LAST_NAME', {})).toBeNull();
  });
});

describe('what the citizen reads back (F8)', () => {
  it('masks an identity number to its last three characters', () => {
    expect(maskIdentityNumber('123456789')).toBe('••••••789');
    expect(maskIdentityNumber('1234')).toBe('•234');
  });
  it('hides a number of three characters or fewer whole', () => {
    expect(maskIdentityNumber('123')).toBe('•••');
    expect(maskIdentityNumber('45')).toBe('••');
    expect(maskIdentityNumber('')).toBe('');
  });
  it('masks whole characters, not halves of one', () => {
    expect(maskIdentityNumber('ab😀😀😀')).toBe('••😀😀😀');
  });
  it('masks a document number and leaves every other answer as stored', () => {
    expect(answerValueForCitizen('DOCUMENT_NUMBER', '123456789')).toBe('••••••789');
    expect(answerValueForCitizen('PHONE', '+96171123456')).toBe('+96171123456');
    expect(answerValueForCitizen('SHORT_TEXT', '123456789')).toBe('123456789');
    expect(answerValueForCitizen('MULTI_CHOICE', ['a', 'b'])).toEqual(['a', 'b']);
    expect(answerValueForCitizen('YES_NO', false)).toBe(false);
  });
});

describe('the issue codes', () => {
  it('are unique', () => {
    expect(new Set(REQUEST_ANSWER_ISSUE_CODES).size).toBe(REQUEST_ANSWER_ISSUE_CODES.length);
  });
});
