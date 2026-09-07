import {
  adminCreateCitizenSchema,
  buildCitizenPayload,
  referenceOnlyLoginSchema,
  settlePaymentSchema,
  type ImportRow,
} from '@mechanization/shared-schemas';

/**
 * The bulk import shapes a flat spreadsheet row into the nested payload the
 * single-citizen form already validates against. It owns no validation of its
 * own, so what is worth testing is that the *translation* is faithful across
 * every branch — four property types, two occupancy types, Lebanese and
 * foreign — and, more importantly, that a row the form would reject is still
 * rejected once it arrives as a spreadsheet line.
 *
 * These run the real schema, not a stub: a mapping that quietly satisfies a
 * mock while producing something `adminCreateCitizenSchema` refuses is exactly
 * the bug this guards.
 */

const BASE: ImportRow = {
  firstName: 'علي',
  middleName: 'حسين',
  lastName: 'خليل',
  gender: 'ذكر',
  bloodType: 'A+',
  isLebanese: 'نعم',
  nationality: 'لبناني',
  residentStatus: 'من سكان الضيعة',
  identityDocType: 'هوية',
  identityDocNumber: '1234567',
  civilRecordNumber: '12',
  maritalStatus: 'متزوج',
  phone: '03123456',
  totalRegisteredMembers: '5',
  actualHouseholdMembers: '5',
  occupancyType: 'مالك',
  neighborhood: 'الحي الشرقي',
  propertyNumber: '1024',
};

const parse = (row: ImportRow) => adminCreateCitizenSchema.safeParse(buildCitizenPayload(row));

/** Fails the test with the schema's own message when a row was meant to pass. */
function expectAccepted(row: ImportRow) {
  const result = parse(row);
  if (!result.success) {
    throw new Error(
      `expected the row to validate, but got: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.data;
}

describe('buildCitizenPayload — property branches', () => {
  it('maps a house', () => {
    const data = expectAccepted({
      ...BASE,
      propertyType: 'منزل',
      buildingName: 'منزل خليل',
      unitArea: '180',
    });
    expect(data.properties[0]).toMatchObject({ propertyType: 'HOUSE', unitArea: 180 });
  });

  it('maps land, including its land type and shares', () => {
    const data = expectAccepted({
      ...BASE,
      propertyType: 'أرض',
      landType: 'زراعي',
      unitArea: '2500',
      shares: '400',
    });
    expect(data.properties[0]).toMatchObject({
      propertyType: 'LAND',
      landType: 'AGRICULTURAL',
      shares: 400,
    });
  });

  /**
   * A building holds many units and a row holds one, so the import folds the
   * `unit*` columns into a single-entry `units` array. Multi-unit blocks go
   * through the form — the point here is that the one unit is not lost.
   */
  it('maps a building into a one-unit array', () => {
    const data = expectAccepted({
      ...BASE,
      propertyType: 'مبنى',
      buildingName: 'مبنى خليل',
      unitType: 'شقة',
      unitFloor: 'الأول',
      unitArea: '120',
    });
    const property = data.properties[0] as { units?: Array<Record<string, unknown>> };
    expect(property.units).toHaveLength(1);
    expect(property.units?.[0]).toMatchObject({ unitType: 'APARTMENT', floor: 'الأول' });
  });

  it('maps a tent for a refugee', () => {
    const data = expectAccepted({
      ...BASE,
      isLebanese: 'لا',
      nationality: 'سوري',
      residentStatus: 'لاجئ',
      identityDocType: 'جواز سفر',
      identityDocNumber: 'P998877',
      civilRecordNumber: '',
      propertyType: 'خيمة',
      tentLocation: 'مخيّم الطريق الشرقي',
    });
    expect(data.properties[0]).toMatchObject({ propertyType: 'TENT' });
  });

  it("carries a tenant's landlord across", () => {
    const data = expectAccepted({
      ...BASE,
      occupancyType: 'مستأجر',
      landlordName: 'حسن مراد',
      landlordPhone: '70111222',
      propertyType: 'منزل',
      buildingName: 'بناية مراد',
      unitArea: '95',
    });
    expect(data.properties[0]).toMatchObject({
      occupancyType: 'TENANT',
      landlordName: 'حسن مراد',
    });
  });
});

describe('buildCitizenPayload — how a register is actually typed', () => {
  const house = { propertyType: 'منزل', buildingName: 'منزل خليل', unitArea: '180' };

  it('accepts machine enum values as well as Arabic labels', () => {
    expectAccepted({
      ...BASE,
      gender: 'MALE',
      residentStatus: 'VILLAGE_RESIDENT',
      identityDocType: 'NATIONAL_ID',
      maritalStatus: 'MARRIED',
      occupancyType: 'OWNER',
      propertyType: 'HOUSE',
      buildingName: 'منزل خليل',
      unitArea: '180',
    });
  });

  /** Registers typed over years contain مطلّق and مطلق; both are the same word. */
  it('folds optional diacritics', () => {
    const data = expectAccepted({ ...BASE, ...house, maritalStatus: 'مطلق' });
    expect(data.contact.maritalStatus).toBe('DIVORCED');
  });

  it('reads Arabic-Indic digits in numeric columns', () => {
    const data = expectAccepted({
      ...BASE,
      ...house,
      totalRegisteredMembers: '٤',
      actualHouseholdMembers: '٤',
      unitArea: '١٥٠',
    });
    expect(data.contact.totalRegisteredMembers).toBe(4);
    expect(data.contact.actualHouseholdMembers).toBe(4);
    expect(data.properties[0]).toMatchObject({ unitArea: 150 });
  });

  /**
   * A blank الواتساب column means "same as the phone", not "no WhatsApp" — the
   * municipality sends receipts to it, so defaulting it to empty would silently
   * cut off the citizen's copy.
   */
  it('treats a blank whatsapp column as the phone number', () => {
    const data = expectAccepted({ ...BASE, ...house });
    expect(data.contact.whatsapp).toBe(data.contact.phone);
  });

  it('keeps an explicit whatsapp number when one is given', () => {
    const data = expectAccepted({ ...BASE, ...house, whatsapp: '70999888' });
    expect(data.contact.whatsapp).not.toBe(data.contact.phone);
  });
});

describe('buildCitizenPayload — rows the form would reject', () => {
  const house = { propertyType: 'منزل', buildingName: 'منزل خليل', unitArea: '180' };

  /** Each case names the field whose rule must survive the spreadsheet route. */
  it.each([
    ['a tent for a non-refugee', { ...BASE, propertyType: 'خيمة', tentLocation: 'خلف المدرسة' }],
    [
      'a tenant with no landlord',
      { ...BASE, ...house, occupancyType: 'مستأجر' },
    ],
    [
      'a Lebanese citizen with no civil record number',
      { ...BASE, ...house, civilRecordNumber: '' },
    ],
    ['an invalid phone number', { ...BASE, ...house, phone: '12345' }],
    ['an unrecognised property type', { ...BASE, propertyType: 'قصر', unitArea: '180' }],
    ['a missing name', { ...BASE, ...house, firstName: '' }],
    ['a missing father name', { ...BASE, ...house, middleName: '' }],
    ['a missing blood type', { ...BASE, ...house, bloodType: '' }],
    ['a total registered members of zero', { ...BASE, ...house, totalRegisteredMembers: '0' }],
    [
      'actual household members exceeding total registered',
      { ...BASE, ...house, totalRegisteredMembers: '3', actualHouseholdMembers: '5' },
    ],
  ])('rejects %s', (_label, row) => {
    expect(parse(row as ImportRow).success).toBe(false);
  });
});

/**
 * The portal's front door takes this string and nothing else, so its format
 * check is the whole guard in front of a citizen's record.
 */
describe('referenceOnlyLoginSchema', () => {
  it.each([
    ['BZR-2608-5HLQBM', 'BZR-2608-5HLQBM'],
    ['bzr-2608-5hlqbm', 'BZR-2608-5HLQBM'],
    ['  BZR-2608-5HLQBM  ', 'BZR-2608-5HLQBM'],
    ['BZR - 2608 - 5HLQBM', 'BZR-2608-5HLQBM'],
  ])('normalises %s', (input, expected) => {
    const result = referenceOnlyLoginSchema.safeParse({ referenceNumber: input });
    expect(result.success && result.data.referenceNumber).toBe(expected);
  });

  /**
   * The generator's alphabet drops I, O, 0 and 1 so a code survives being read
   * aloud. Accepting them would mean two different strings naming one citizen.
   */
  it.each([
    'BZR-2608-5HLQBO',
    'BZR-2608-5HLQB0',
    'BZR-2608-5HLQBI',
    'BZR-2608-5HLQB1',
    'BZR-2608-5HLQB',
    'BZR26085HLQBM',
    'BZ-2608-5HLQBM',
    '',
    "' OR 1=1--",
  ])('rejects %s', (input) => {
    expect(referenceOnlyLoginSchema.safeParse({ referenceNumber: input }).success).toBe(false);
  });
});

/**
 * Each payment method carries exactly one fact that makes it auditable, and the
 * schema is where that is enforced for both the counter and the API.
 */
describe('settlePaymentSchema', () => {
  it('defaults an omitted method to cash, so older clients keep working', () => {
    const result = settlePaymentSchema.safeParse({ amount: 5000 });
    expect(result.success && result.data.method).toBe('CASH');
  });

  it('accepts cash with neither a reference nor a collector', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', amount: 5000 }).success).toBe(true);
  });

  it('requires a transfer reference for Whish', () => {
    expect(settlePaymentSchema.safeParse({ method: 'WHISH_MONEY', amount: 5000 }).success).toBe(
      false,
    );
    expect(
      settlePaymentSchema.safeParse({
        method: 'WHISH_MONEY',
        amount: 5000,
        whishTransactionRef: 'TRX-1',
      }).success,
    ).toBe(true);
  });

  /**
   * Without a named محصّل, a collection is indistinguishable from counter cash
   * — which is the whole distinction the COLLECTOR method was added to draw.
   */
  it('requires a collector for a collected payment', () => {
    expect(settlePaymentSchema.safeParse({ method: 'COLLECTOR', amount: 5000 }).success).toBe(
      false,
    );
    expect(
      settlePaymentSchema.safeParse({
        method: 'COLLECTOR',
        amount: 5000,
        collectedById: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown method and a non-positive amount', () => {
    expect(settlePaymentSchema.safeParse({ method: 'BITCOIN', amount: 5000 }).success).toBe(false);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', amount: -1 }).success).toBe(false);
  });
});
