import { adminCreateCitizenSubmissionSchema } from '@mechanization/shared-schemas';
import { citizenColumnsForEdit } from './citizens.service';

/**
 * Two changes to what a registration asks, both from the first week in the
 * field, pinned against the same schema object the controller and the browser
 * form validate with.
 *
 *  1. **No identity document.** A Lebanese citizen is not asked for one, and a
 *     non-Lebanese person's passport and residency numbers are «إلزامي إن وجد» —
 *     both may be empty. A required number is what produced invented numbers,
 *     and invented numbers are what merged citizens.
 *  2. **«مالك غير مقيم».** An owner who lives elsewhere is a short record —
 *     name, how to reach them, where they live — not a household file with
 *     every gap flagged.
 */

const household = () => ({
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    gender: 'MALE',
    bloodType: 'O_POSITIVE',
    civilRecordNumber: '7',
    nationality: 'لبناني',
    isLebanese: true,
    residentStatus: 'VILLAGE_RESIDENT',
  } as Record<string, unknown>,
  contact: {
    maritalStatus: 'MARRIED',
    phone: '03 123456',
    whatsappSameAsPhone: true,
    actualHouseholdMembers: '4',
  } as Record<string, unknown>,
  properties: [] as Array<Record<string, unknown>>,
  flags: [],
});

const owner = () => ({
  residence: 'NON_RESIDENT_OWNER',
  personal: { firstName: 'يوسف', lastName: 'جفال', residencePlace: 'ساحل العاج' } as Record<
    string,
    unknown
  >,
  contact: { phone: '+225 07 12 34 56 78', whatsappSameAsPhone: true } as Record<string, unknown>,
  properties: [
    {
      occupancyType: 'OWNER',
      propertyType: 'LAND',
      propertyNumber: '6',
      landType: 'AGRICULTURAL',
      unitArea: '250',
      shares: '2400',
    },
  ] as Array<Record<string, unknown>>,
  flags: [],
});

const failures = (input: unknown): string[] => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('identity document — no longer asked', () => {
  it('accepts a Lebanese citizen with no document at all', () => {
    expect(failures(household())).toEqual([]);
  });

  it('still requires رقم السجل of a Lebanese citizen', () => {
    const input = household();
    delete input.personal.civilRecordNumber;
    expect(failures(input)).toEqual(['personal.civilRecordNumber']);
  });

  it('accepts a non-Lebanese person with neither a passport nor a residency number', () => {
    const input = household();
    Object.assign(input.personal, {
      isLebanese: false,
      nationality: 'سوري',
      residentStatus: 'DISPLACED',
    });
    delete input.personal.civilRecordNumber;
    expect(failures(input)).toEqual([]);
  });
});

describe('«مالك غير مقيم»', () => {
  it('is a complete record with a name, a number and where they live', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(owner());
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.residence).toBe('NON_RESIDENT_OWNER');
    expect(result.data.personal.residencePlace).toBe('ساحل العاج');
    expect(result.data.contact.whatsapp).toBe(result.data.contact.phone);
    // None of a household file's questions reached the shaped record.
    expect(result.data.personal.bloodType).toBeUndefined();
    expect(result.data.contact.maritalStatus).toBeUndefined();
  });

  it('asks where the owner lives', () => {
    const input = owner();
    delete input.personal.residencePlace;
    expect(failures(input)).toEqual(['personal.residencePlace']);
  });

  it('refuses a tenancy on an owner record — whoever lives there has their own file', () => {
    const input = owner();
    input.properties[0]!.occupancyType = 'TENANT';
    expect(failures(input)).toContain('properties.0.occupancyType');
  });

  it('defaults an old submission with no نوع الملف to a household file', () => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(household());
    expect(result.success && result.data.residence).toBe('RESIDENT');
  });
});

describe('editing — nothing the form stopped asking is erased', () => {
  const parsed = (input: unknown) => {
    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    if (!result.success) throw new Error(JSON.stringify(result.error.issues));
    return result.data as never;
  };

  it('leaves a Lebanese citizen’s stored identity document untouched', () => {
    const input = household();
    // What an edit form holding a legacy record still carries, invisibly.
    Object.assign(input.personal, { identityDocType: 'NATIONAL_ID', identityDocNumber: '12345' });

    const columns = citizenColumnsForEdit(parsed(input));

    expect(columns).not.toHaveProperty('identityDocType');
    expect(columns).not.toHaveProperty('identityDocNumber');
  });

  it('writes a non-Lebanese passport number when one is given, and keeps the stored one when blank', () => {
    const input = household();
    Object.assign(input.personal, { isLebanese: false, nationality: 'سوري', residentStatus: 'DISPLACED' });
    delete input.personal.civilRecordNumber;

    expect(citizenColumnsForEdit(parsed(input))).not.toHaveProperty('identityDocNumber');

    input.personal.identityDocNumber = 'N123456';
    expect(citizenColumnsForEdit(parsed(input))).toMatchObject({
      identityDocType: 'PASSPORT',
      identityDocNumber: 'N123456',
    });
  });

  it('converting to an owner record does not blank the household columns', () => {
    const columns = citizenColumnsForEdit(parsed(owner()));

    expect(columns).toMatchObject({ residence: 'NON_RESIDENT_OWNER', residencePlace: 'ساحل العاج' });
    for (const kept of ['gender', 'bloodType', 'maritalStatus', 'actualHouseholdMembers', 'civilRecordNumber']) {
      expect(columns).not.toHaveProperty(kept);
    }
  });
});
