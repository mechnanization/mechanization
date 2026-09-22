import { describe, expect, it } from 'vitest';
import { adminUpdateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import type { CitizenFormData } from './api-client';
import { citizenFieldPatch, isEditableOn } from './citizen-field-edit';

/**
 * What these tests are actually defending.
 *
 * `PATCH /citizens/:id` reconciles the properties of the citizen's latest
 * registration: a card absent from the payload is deleted along with its
 * documents, and a card that arrives without its `buildingId` loses the census
 * link. So a correction made from «ملاحظات الجودة» — where somebody is fixing a
 * phone number, not editing a household — has to hand the record back exactly as
 * it came, minus the one field it changed.
 *
 * Every case below is a shape the register really holds: a flat the census knows
 * about but nobody has measured (null area), a legacy identity document on a
 * Lebanese file, a tenancy whose owner is linked rather than typed, an owner who
 * lives elsewhere. Each one used to be a save that failed or a value that moved.
 */

/*
  Real uuids and a string floor, because these payloads are now parsed by the
  schema the save applies rather than only inspected field by field.

  The friendly ids this file used to carry — 'entry-1', 'unit-1' — and a
  numeric `floor` are why the null echo could sit here through twelve green
  tests: a fixture that the server would have rejected outright cannot tell
  you whether the payload built from it would be accepted. `residentStatus`
  was `'RESIDENT'`, which is not one of the three values RESIDENT_STATUS holds.
*/
const ENTRY_ID = '3f1a0c6e-8b24-4d7a-9c15-2e6b0a91d4f7';
const BUILDING_ID = 'b71d9e02-5c43-4a18-8f6d-1029ac3e5b84';
const UNIT_ROW_ID = 'c0e4a7b1-6d92-4f35-ae78-5b1c83fd29e6';
const UNIT_ID = 'd82b6f45-1a07-4c93-b5e6-7f20d94ac318';

const form = (overrides: Partial<CitizenFormData> = {}): CitizenFormData => ({
  id: 'citizen-1',
  registrationId: 'registration-1',
  referenceNumber: 'ALB-000123',
  status: 'PENDING',
  residence: 'RESIDENT',
  version: 'v7',
  personal: {
    firstName: 'محمد',
    middleName: 'أحمد',
    lastName: 'خليل',
    motherName: 'فاطمة سعد',
    gender: 'MALE',
    nationality: 'لبنانية',
    isLebanese: true,
    civilRecordNumber: '48',
    residentStatus: 'VILLAGE_RESIDENT',
    bloodType: '',
    residencePlace: '',
  },
  contact: {
    phone: '+96170123456',
    whatsapp: '+96170123456',
    whatsappSameAsPhone: true,
    maritalStatus: 'MARRIED',
    totalRegisteredMembers: 6,
    actualHouseholdMembers: 4,
    localContactName: '',
    localContactPhone: '',
  },
  properties: [],
  flags: [],
  notes: null,
  ...overrides,
});

const card = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: ENTRY_ID,
  occupancyType: 'OWNER',
  propertyType: 'BUILDING',
  neighborhood: 'الحي الشرقي',
  propertyNumber: '498',
  buildingName: 'مبنى الزهراء',
  buildingId: BUILDING_ID,
  unitArea: 120,
  shares: null,
  sharedRights: [],
  landlordName: null,
  landlordPhone: null,
  landlordCitizenId: null,
  landlordLink: null,
  units: [{ id: UNIT_ROW_ID, unitId: UNIT_ID, unitType: 'APARTMENT', floor: '2', unitArea: 95 }],
  ...overrides,
});

describe('citizenFieldPatch', () => {
  it('changes only the named field and carries the rest of the envelope', () => {
    const patch = citizenFieldPatch(form(), { phone: '+96170999888' });

    expect(patch.contact.phone).toBe('+96170999888');
    expect(patch.contact.maritalStatus).toBe('MARRIED');
    expect(patch.contact.actualHouseholdMembers).toBe(4);
    expect(patch.personal.firstName).toBe('محمد');
    expect(patch.residence).toBe('RESIDENT');
    // Refused if somebody else saved the file while the comparison was open.
    expect(patch.expectedVersion).toBe('v7');
  });

  it('corrects each name part separately', () => {
    const patch = citizenFieldPatch(form(), { lastName: 'خليل حمود', motherName: 'فاطمة سعد الدين' });

    expect(patch.personal.lastName).toBe('خليل حمود');
    expect(patch.personal.motherName).toBe('فاطمة سعد الدين');
    expect(patch.personal.firstName).toBe('محمد');
  });

  it('hands every property card back with its identities intact', () => {
    const patch = citizenFieldPatch(form({ properties: [card()] }), { phone: '+96171000000' });

    expect(patch.properties).toHaveLength(1);
    const [sent] = patch.properties as Array<Record<string, unknown>>;
    expect(sent!.id).toBe(ENTRY_ID);
    // The census link a colleague made from the matrix, and the flat it names.
    expect(sent!.buildingId).toBe(BUILDING_ID);
    expect((sent!.units as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: UNIT_ROW_ID,
      unitId: UNIT_ID,
    });
  });

  it('drops a null area rather than sending it as zero', () => {
    const patch = citizenFieldPatch(
      form({
        properties: [
          card({ unitArea: null, units: [{ id: UNIT_ROW_ID, unitId: UNIT_ID, unitArea: null }] }),
        ],
      }),
      { phone: '+96171000000' },
    );

    const [sent] = patch.properties as Array<Record<string, unknown>>;
    expect(sent).not.toHaveProperty('unitArea');
    expect((sent!.units as Array<Record<string, unknown>>)[0]).not.toHaveProperty('unitArea');
  });

  it('sends أسهم only on an owner card', () => {
    const owner = citizenFieldPatch(
      form({ properties: [card({ propertyType: 'LAND', shares: 400 })] }),
      { phone: '+96171000000' },
    );
    expect((owner.properties[0] as Record<string, unknown>).shares).toBe(400);

    const tenant = citizenFieldPatch(
      form({
        properties: [
          card({ occupancyType: 'TENANT', shares: 400, landlordName: 'سعيد حمود' }),
        ],
      }),
      { phone: '+96171000000' },
    );
    expect(tenant.properties[0] as Record<string, unknown>).not.toHaveProperty('shares');
  });

  it('names the linked owner on a tenancy whose own landlord name is empty', () => {
    const patch = citizenFieldPatch(
      form({
        properties: [
          card({
            occupancyType: 'TENANT',
            landlordName: '',
            landlordCitizenId: 'owner-1',
            landlordLink: { citizenId: 'owner-1', name: 'سعيد حمود', referenceNumber: 'ALB-9' },
          }),
        ],
      }),
      { phone: '+96171000000' },
    );

    const [sent] = patch.properties as Array<Record<string, unknown>>;
    expect(sent!.landlordName).toBe('سعيد حمود');
    // What the form shows beside the locked field never travels.
    expect(sent).not.toHaveProperty('landlordLink');
  });

  it('leaves a Lebanese file’s legacy identity document behind', () => {
    const patch = citizenFieldPatch(
      form({
        personal: {
          ...form().personal,
          identityDocType: 'ID_CARD',
          identityDocNumber: 'not-a-valid-number-any-more',
          residencyNumber: '',
        },
      }),
      { motherName: 'فاطمة' },
    );

    expect(patch.personal).not.toHaveProperty('identityDocNumber');
    expect(patch.personal).not.toHaveProperty('identityDocType');
    expect(patch.personal).not.toHaveProperty('residencyNumber');
  });

  it('keeps a non-Lebanese file’s passport, and resolves a null isLebanese', () => {
    const foreign = citizenFieldPatch(
      form({
        personal: {
          ...form().personal,
          isLebanese: false,
          identityDocType: 'PASSPORT',
          identityDocNumber: 'P1234567',
        },
      }),
      { phone: '+96171000000' },
    );
    expect(foreign.personal.identityDocNumber).toBe('P1234567');

    const legacy = citizenFieldPatch(
      form({ personal: { ...form().personal, isLebanese: null } }),
      { phone: '+96171000000' },
    );
    expect(legacy.personal.isLebanese).toBe(true);
  });

  it('asks a «غير مقيم» file only what its own form asks', () => {
    const patch = citizenFieldPatch(
      form({
        residence: 'NON_RESIDENT_OWNER',
        personal: { ...form().personal, residencePlace: 'بيروت' },
      }),
      { lastName: 'خليل حمود' },
    );

    expect(patch.personal).toEqual({
      firstName: 'محمد',
      middleName: 'أحمد',
      lastName: 'خليل حمود',
      residencePlace: 'بيروت',
    });
    expect(patch.contact).not.toHaveProperty('actualHouseholdMembers');
    expect(patch.contact.phone).toBe('+96170123456');
  });

  it('carries the record’s flags and its visit note', () => {
    const patch = citizenFieldPatch(
      form({
        flags: [
          {
            path: 'personal.motherName',
            reason: 'الساكن لا يعرف اسم والدة صاحب الملف',
            kind: 'UNESTABLISHED',
          },
        ],
        notes: '  الأسرة تنتقل نهاية الشهر  ',
      }),
      { phone: '+96171000000' },
    );

    expect(patch.flags).toHaveLength(1);
    expect(patch.notes).toBe('الأسرة تنتقل نهاية الشهر');
  });

  it('omits expectedVersion when the form endpoint supplied none', () => {
    const patch = citizenFieldPatch(form({ version: undefined }), { phone: '+96171000000' });
    expect(patch).not.toHaveProperty('expectedVersion');
  });
});

/**
 * The check the other twelve cases could not make.
 *
 * Every test above asserts the *shape* of the payload — this one hands it to
 * the schema the server validates with. That distinction is the whole reason
 * the null echo survived review: a payload can carry `unitStatus: null`
 * through a dozen `toMatchObject` assertions and still be refused by the save,
 * because not one field on a property card is `.nullable()` — the optional
 * ones are `.optional()`, which takes `undefined` and refuses `null`.
 *
 * So these parse rather than inspect. If a future change echoes another column
 * back raw, it fails here instead of on a phone, in a settlement, as an error
 * about a field nobody touched.
 */
describe('citizenFieldPatch output is accepted by the schema the save applies', () => {
  const parse = (patch: unknown) => adminUpdateCitizenSubmissionSchema.safeParse(patch);

  it('accepts a correction on a record with no property cards', () => {
    expect(parse(citizenFieldPatch(form(), { phone: '+96170999888' })).success).toBe(true);
  });

  it('accepts a correction on a unit nobody has marked — the common case', () => {
    /*
      A flat the census knows and nobody has given a حالة الوحدة. The register
      is full of these: `property.schema.ts` documents an unmarked unit as
      billed by default, so this is not an edge case, it is most of them.
    */
    const result = parse(
      citizenFieldPatch(
        form({ properties: [card({ unitStatus: null })] }),
        { phone: '+96171000000' },
      ),
    );
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('accepts a card whose optional text columns are all null', () => {
    const result = parse(
      citizenFieldPatch(
        form({
          properties: [
            card({
              neighborhood: null,
              buildingName: null,
              side: null,
              unitStatus: null,
              landlordName: null,
              landlordPhone: null,
            }),
          ],
        }),
        { motherName: 'فاطمة سعد الدين' },
      ),
    );
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it('accepts a linked tenancy, whose owner name is resolved rather than typed', () => {
    const result = parse(
      citizenFieldPatch(
        form({
          properties: [
            card({
              occupancyType: 'TENANT',
              unitStatus: null,
              // Empty on the card; the link is what names the owner.
              landlordName: null,
              landlordPhone: '+96170555444',
              landlordLink: { name: 'سعاد خليل' },
            }),
          ],
        }),
        { phone: '+96171000000' },
      ),
    );
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
    // The link's name is what satisfies «a tenant names an owner».
    const [sent] = (result.data as { properties: Array<Record<string, unknown>> }).properties;
    expect(sent!.landlordName).toBe('سعاد خليل');
  });

  it('accepts a household whose قيد عائلي nobody recorded', () => {
    /*
      `totalRegisteredMembers` is nullable and `.optional()`, so it needs no
      «غير مؤكَّد» flag to be absent — a NULL here is an ordinary record, not a
      damaged one. Echoed back as null it refuses the save on «يجب تسجيل فرد
      واحد على الأقل لكل قيد عائلي»; dropped, `contactDetailsSchema` fills it
      from `actualHouseholdMembers`, which is what the full edit form sends.
    */
    const result = parse(
      citizenFieldPatch(
        form({
          contact: { ...form().contact, totalRegisteredMembers: null as never },
        }),
        { phone: '+96171000000' },
      ),
    );
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
    expect(
      (result.data as { contact: { totalRegisteredMembers: number } }).contact
        .totalRegisteredMembers,
    ).toBe(4);
  });

  /*
    KNOWN LIMITATION, recorded rather than hidden — and not caused by the null
    filter: it fails identically with the null echoed («Expected string,
    received null») and with it dropped («رقم الواتساب مطلوب»).

    `getEditable` derives `whatsappSameAsPhone` as `whatsapp === phone`, so a
    citizen with no WhatsApp number comes back as
    `{ whatsapp: null, whatsappSameAsPhone: false }` — and
    `contactDetailsObject` requires `whatsapp` whenever the flag is false. So
    that record cannot be corrected from «ملاحظات الجودة» at all.

    Not fixed here because every available fix is a decision rather than a
    correction: sending `whatsappSameAsPhone: true` would write the phone into
    the WhatsApp column, and relaxing the schema changes what the citizen form
    accepts too. Asserted as it behaves so the day somebody fixes it, this test
    fails and says so.
  */
  it('cannot yet correct a record with no WhatsApp number — see the note above', () => {
    const result = parse(
      citizenFieldPatch(
        form({
          contact: {
            ...form().contact,
            whatsapp: null as never,
            whatsappSameAsPhone: false,
          },
        }),
        { phone: '+96171000000' },
      ),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('contact.whatsapp');
  });

  it('sends no null anywhere in the payload — every section, not just the cards', () => {
    const patch = citizenFieldPatch(
      form({
        contact: {
          ...form().contact,
          totalRegisteredMembers: null as never,
        },
        properties: [
          card({
            unitStatus: null,
            neighborhood: null,
            units: [{ id: UNIT_ROW_ID, unitId: UNIT_ID, unitType: 'APARTMENT', unitArea: null }],
          }),
        ],
      }),
      { phone: '+96171000000' },
    );

    const nulls: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (value === null) {
        nulls.push(path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((v, i) => walk(v, `${path}[${i}]`));
        return;
      }
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(patch, '');
    expect(nulls).toEqual([]);
  });
});

describe('isEditableOn', () => {
  it('offers اسم الأم on a household file and not on an owner living elsewhere', () => {
    expect(isEditableOn(form(), 'motherName')).toBe(true);
    expect(isEditableOn(form({ residence: 'NON_RESIDENT_OWNER' }), 'motherName')).toBe(false);
    expect(isEditableOn(form({ residence: 'NON_RESIDENT_OWNER' }), 'phone')).toBe(true);
  });
});
