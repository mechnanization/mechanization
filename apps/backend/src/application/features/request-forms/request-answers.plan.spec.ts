import {
  answerViewsOf,
  citizenFileValues,
  fieldKeyOfPaper,
  formRefOf,
  missingPapersOf,
  normaliseOwnFields,
  sameTypedAnswers,
  type FormAsks,
  type RequestFormRow,
} from './request-answers.plan';

const ID = '11111111-1111-4111-8111-111111111111';
const CARD = '22222222-2222-4222-8222-222222222222';
const UNIT = '33333333-3333-4333-8333-333333333333';

describe('the request\'s own fields beside the form\'s questions', () => {
  const asks = (extra: Partial<FormAsks> = {}): FormAsks => ({ propertyMode: 'OPTIONAL', askCapacity: false, askPurpose: false, ...extra });

  it('keeps the capacity, card, unit and purpose a form asks for', () => {
    const own = normaliseOwnFields(asks({ askCapacity: true, askPurpose: true }), {
      applicantCapacity: 'OWNER',
      propertyEntryId: CARD,
      buildingUnitId: UNIT,
      purpose: 'للمدرسة',
    });
    expect(own).toMatchObject({ applicantCapacity: 'OWNER', propertyEntryId: CARD, buildingUnitId: UNIT, purpose: 'للمدرسة', issues: [], propertyMissing: false });
  });

  it('drops what the form does not ask, so a client that still sends it is not turned away and a retry compares equal', () => {
    const own = normaliseOwnFields(asks({ propertyMode: 'NONE' }), {
      applicantCapacity: 'OWNER',
      propertyEntryId: CARD,
      buildingUnitId: UNIT,
      purpose: 'x',
    });
    expect(own).toMatchObject({ applicantCapacity: null, propertyEntryId: null, buildingUnitId: null, purpose: null, issues: [], propertyMissing: false });
  });

  it('asks for the capacity when the form does: a missing one is the REQUIRED issue under its own key', () => {
    expect(normaliseOwnFields(asks({ askCapacity: true }), {}).issues).toEqual([{ fieldKey: 'applicantCapacity', code: 'REQUIRED' }]);
  });

  it('needs a card only when the form says REQUIRED', () => {
    expect(normaliseOwnFields(asks({ propertyMode: 'REQUIRED' }), {}).propertyMissing).toBe(true);
    expect(normaliseOwnFields(asks({ propertyMode: 'REQUIRED' }), { propertyEntryId: CARD }).propertyMissing).toBe(false);
    expect(normaliseOwnFields(asks({ propertyMode: 'OPTIONAL' }), {}).propertyMissing).toBe(false);
  });

  it('never keeps a unit line without its card', () => {
    expect(normaliseOwnFields(asks(), { buildingUnitId: UNIT })).toMatchObject({ propertyEntryId: null, buildingUnitId: null });
  });

  it('leaves the purpose optional when asked', () => {
    expect(normaliseOwnFields(asks({ askPurpose: true }), {})).toMatchObject({ purpose: null, issues: [] });
  });
});

describe('the citizen\'s file as the linked questions read it', () => {
  it('maps each source to its column, the father\'s name being the middle name', () => {
    expect(
      citizenFileValues({
        firstName: 'علي',
        middleName: 'حسن',
        lastName: 'ناصر',
        motherName: 'زينب',
        phone: '+96171123456',
        identityDocNumber: '123456789',
        civilRecordNumber: '45',
      }),
    ).toEqual({
      FIRST_NAME: 'علي',
      FATHER_NAME: 'حسن',
      LAST_NAME: 'ناصر',
      MOTHER_NAME: 'زينب',
      PHONE: '+96171123456',
      IDENTITY_NUMBER: '123456789',
      CIVIL_RECORD_NUMBER: '45',
    });
  });

  it('has no source for a رقم مرجعي: a credential is never a form\'s to read', () => {
    const values = citizenFileValues({
      firstName: 'a',
      middleName: null,
      lastName: 'b',
      motherName: null,
      phone: null,
      identityDocNumber: null,
      civilRecordNumber: null,
    });
    expect(Object.keys(values).sort()).toEqual(
      ['CIVIL_RECORD_NUMBER', 'FATHER_NAME', 'FIRST_NAME', 'IDENTITY_NUMBER', 'LAST_NAME', 'MOTHER_NAME', 'PHONE'].sort(),
    );
  });
});

describe('a retried press', () => {
  const row = (fieldKey: string, value: unknown, origin: 'ANSWERED' | 'FROM_FILE' = 'ANSWERED') => ({ fieldKey, value, origin });

  it('is the same when every typed answer is the same, whatever order they come in', () => {
    expect(sameTypedAnswers([row('a', 'x'), row('b', 4)], [row('b', 4), row('a', 'x')])).toBe(true);
  });
  it('is another request when one answer differs, one is added or one is missing', () => {
    expect(sameTypedAnswers([row('a', 'x')], [row('a', 'y')])).toBe(false);
    expect(sameTypedAnswers([row('a', 'x')], [row('a', 'x'), row('b', 1)])).toBe(false);
    expect(sameTypedAnswers([row('a', 'x'), row('b', 1)], [row('a', 'x')])).toBe(false);
  });
  it('tells a yes from a no, a number from its text, and a list from another order', () => {
    expect(sameTypedAnswers([row('a', true)], [row('a', false)])).toBe(false);
    expect(sameTypedAnswers([row('a', 4)], [row('a', '4')])).toBe(false);
    expect(sameTypedAnswers([row('a', ['x', 'y'])], [row('a', ['y', 'x'])])).toBe(false);
  });
  it('does not compare what the file supplied: it may have been completed since', () => {
    expect(sameTypedAnswers([row('a', 'x'), row('n', 'علي', 'FROM_FILE')], [row('a', 'x'), row('n', 'غيره', 'FROM_FILE')])).toBe(true);
  });
});

describe('a request read back', () => {
  const FILE_FIELD = 'f-1';
  const row: RequestFormRow = {
    formVersion: {
      id: 'v-2',
      versionNumber: 2,
      form: { id: 'form-1', nameAr: 'إفادة سكن', nameEn: 'Residence statement' },
      fields: [
        { id: FILE_FIELD, key: 'id_copy', labelAr: 'صورة الهوية', labelEn: 'ID copy' },
        { id: 'f-2', key: 'lease', labelAr: 'عقد الإيجار', labelEn: null },
      ],
    },
    answers: [
      { value: '123456789', origin: 'ANSWERED', field: { key: 'idn', position: 2, type: 'DOCUMENT_NUMBER', labelAr: 'رقم الهوية', labelEn: null } },
      { value: 'سبب', origin: 'ANSWERED', field: { key: 'reason', position: 0, type: 'SHORT_TEXT', labelAr: 'السبب', labelEn: null } },
      { value: '+96171123456', origin: 'FROM_FILE', field: { key: 'phone', position: 1, type: 'PHONE', labelAr: 'الهاتف', labelEn: null } },
    ],
    attachments: [{ fieldId: FILE_FIELD }, { fieldId: null }],
  };

  it('names the form and the version the request kept', () => {
    expect(formRefOf(row)).toEqual({ id: 'form-1', versionId: 'v-2', versionNumber: 2, nameAr: 'إفادة سكن', nameEn: 'Residence statement' });
    expect(formRefOf({ formVersion: null })).toBeNull();
  });

  it('lists the answers in the form\'s order, with where each came from', () => {
    expect(answerViewsOf(row, 'STAFF').map((a) => [a.fieldKey, a.origin])).toEqual([
      ['reason', 'ANSWERED'],
      ['phone', 'FROM_FILE'],
      ['idn', 'ANSWERED'],
    ]);
  });

  it('gives staff the stored value and the citizen an identity number masked to its last three characters', () => {
    expect(answerViewsOf(row, 'STAFF').find((a) => a.fieldKey === 'idn')?.value).toBe('123456789');
    const mine = answerViewsOf(row, 'CITIZEN');
    expect(mine.find((a) => a.fieldKey === 'idn')?.value).toBe('••••••789');
    expect(mine.find((a) => a.fieldKey === 'reason')?.value).toBe('سبب');
    expect(JSON.stringify(mine)).not.toContain('123456789');
  });

  it('does not reorder or touch the rows it was given', () => {
    const copy = JSON.stringify(row);
    answerViewsOf(row, 'CITIZEN');
    expect(JSON.stringify(row)).toBe(copy);
  });

  it('lists the file questions that hold no paper', () => {
    expect(missingPapersOf(row)).toEqual([{ fieldKey: 'lease', labelAr: 'عقد الإيجار', labelEn: null }]);
    expect(missingPapersOf({ ...row, attachments: [{ fieldId: FILE_FIELD }, { fieldId: 'f-2' }] })).toEqual([]);
    expect(missingPapersOf({ formVersion: null, attachments: [] })).toEqual([]);
  });

  it('names the question a paper answers', () => {
    expect(fieldKeyOfPaper(row, { fieldId: FILE_FIELD })).toBe('id_copy');
    expect(fieldKeyOfPaper(row, { fieldId: null })).toBeNull();
    expect(fieldKeyOfPaper(row, { fieldId: 'unknown' })).toBeNull();
    expect(ID.length).toBeGreaterThan(0);
  });
});
