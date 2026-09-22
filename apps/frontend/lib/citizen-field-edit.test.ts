import { describe, expect, it } from 'vitest';
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
    residentStatus: 'RESIDENT',
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
  id: 'entry-1',
  occupancyType: 'OWNER',
  propertyType: 'BUILDING',
  neighborhood: 'الحي الشرقي',
  propertyNumber: '498',
  buildingName: 'مبنى الزهراء',
  buildingId: 'building-1',
  unitArea: 120,
  shares: null,
  sharedRights: [],
  landlordName: null,
  landlordPhone: null,
  landlordCitizenId: null,
  landlordLink: null,
  units: [{ id: 'unit-row-1', unitId: 'unit-1', unitType: 'APARTMENT', floor: 2, unitArea: 95 }],
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
    expect(sent!.id).toBe('entry-1');
    // The census link a colleague made from the matrix, and the flat it names.
    expect(sent!.buildingId).toBe('building-1');
    expect((sent!.units as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'unit-row-1',
      unitId: 'unit-1',
    });
  });

  it('drops a null area rather than sending it as zero', () => {
    const patch = citizenFieldPatch(
      form({
        properties: [
          card({ unitArea: null, units: [{ id: 'unit-row-1', unitId: 'unit-1', unitArea: null }] }),
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

describe('isEditableOn', () => {
  it('offers اسم الأم on a household file and not on an owner living elsewhere', () => {
    expect(isEditableOn(form(), 'motherName')).toBe(true);
    expect(isEditableOn(form({ residence: 'NON_RESIDENT_OWNER' }), 'motherName')).toBe(false);
    expect(isEditableOn(form({ residence: 'NON_RESIDENT_OWNER' }), 'phone')).toBe(true);
  });
});
