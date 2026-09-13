import { adminCreateCitizenSubmissionSchema, isFlaggablePath } from '@mechanization/shared-schemas';
import { citizenColumnsForEdit } from './citizens.service';

/**
 * «اسم الأم وشهرتها» — the disambiguator that replaced the identity document.
 *
 * ## What these tests are actually protecting
 *
 * Not that a field exists. That the *shape* of the compromise holds, because
 * every part of it is load-bearing and each was chosen against a failure the
 * register has already had:
 *
 *  - **Required**, or officers skip the one field that separates two «محمد
 *    خليل»s and the register is back where removing the document left it.
 *  - **Flaggable**, or requiring it recreates the pressure that filled
 *    `identityDocNumber` with invented numbers — which merged distinct people,
 *    which is why there is no document number to ask for now.
 *  - **Never a key**, because siblings share a mother. It disambiguates people
 *    and identifies nobody.
 *  - **Not asked of an owner record**, which deliberately holds a name, a phone
 *    and a town for somebody living in Beirut or abroad.
 *  - **Nullable, never backfilled**, because households filed before migration
 *    0044 hold nothing and there is nothing truthful to write for them.
 */

const household = () => ({
  personal: {
    firstName: 'علي',
    middleName: 'حسن',
    lastName: 'نصرالله',
    motherName: 'فاطمة خليل',
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
  flags: [] as Array<Record<string, unknown>>,
});

const parse = (input: unknown) => adminCreateCitizenSubmissionSchema.safeParse(input);

const parsed = (input: unknown) => {
  const result = parse(input);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues));
  return result.data as never;
};

describe('اسم الأم — required of a household file', () => {
  it('accepts a household that gives it', () => {
    expect(parse(household()).success).toBe(true);
  });

  it('refuses a household that leaves it out', () => {
    const input = household();
    delete input.personal.motherName;

    const result = parse(input);

    expect(result.success).toBe(false);
    expect(result.error!.issues.some((issue) => issue.path.join('.') === 'personal.motherName')).toBe(
      true,
    );
  });

  it('takes the name and the surname as one phrase', () => {
    /*
      One field, not «اسم الأم» plus «شهرة الأم». A married Lebanese woman is
      recorded in the قيد under her father's family name and addressed by her
      husband's, so a second box makes a clerk who was told «فاطمة» guess at
      which surname is meant — the invention this whole change was about.
    */
    const input = household();
    input.personal.motherName = 'فاطمة يوسف خليل';

    expect(parse(input).success).toBe(true);
  });

  it('refuses a single character, the way every other name is refused', () => {
    const input = household();
    input.personal.motherName = 'ف';

    expect(parse(input).success).toBe(false);
  });
});

describe('اسم الأم — flaggable, which is what makes requiring it safe', () => {
  it('is a path a «غير مؤكَّد» flag may be raised on', () => {
    // Unlike the name and the two discriminators, which no flag can excuse —
    // a record nobody can search for by name is not a register entry.
    expect(isFlaggablePath('personal.motherName')).toBe(true);
  });

  it('accepts a household whose officer recorded that they could not establish it', () => {
    /*
      The whole escape hatch. An officer who does not know writes down that they
      do not know, with a reason somebody can act on later — instead of typing
      something, which is exactly how `identityDocNumber` filled up with numbers
      that merged distinct people.
    */
    const input = household();
    delete input.personal.motherName;
    input.flags = [
      { path: 'personal.motherName', reason: 'الأهل غير متواجدين أثناء المسح' },
    ];

    expect(parse(input).success).toBe(true);
  });

  it('clears the column for a flagged field rather than keeping a stale value', () => {
    // `undefined` in a Prisma update means "leave this alone", which would have
    // the record claim the field is unestablished while still storing the old
    // answer. Flagging a field clears it.
    const input = household();
    input.flags = [
      { path: 'personal.motherName', reason: 'الأهل غير متواجدين أثناء المسح' },
    ];

    expect(citizenColumnsForEdit(parsed(input))).toMatchObject({ motherName: null });
  });
});

describe('اسم الأم — not a question for every kind of record', () => {
  it('is not asked of «غير مقيم في البلدة»', () => {
    /*
      An owner record holds a name, a phone and a town. The municipality has no
      reason to hold a mother's name for an owner in Beirut or abroad, and no
      way to ask for one.
    */
    const owner = {
      residence: 'NON_RESIDENT_OWNER',
      personal: { firstName: 'يوسف', lastName: 'جفال', residencePlace: 'ساحل العاج' },
      contact: { phone: '+225 07 12 34 56 78', whatsappSameAsPhone: true },
      properties: [],
      flags: [],
    };

    expect(parse(owner).success).toBe(true);
  });

  it('does not blank a stored mother’s name when a household becomes an owner record', () => {
    // Same no-data-loss rule the household counts follow: the form stops asking
    // and stops showing, and the conversion erases nothing.
    const owner = {
      residence: 'NON_RESIDENT_OWNER',
      personal: { firstName: 'يوسف', lastName: 'جفال', residencePlace: 'ساحل العاج' },
      contact: { phone: '+225 07 12 34 56 78', whatsappSameAsPhone: true },
      properties: [],
      flags: [],
    };

    expect(citizenColumnsForEdit(parsed(owner))).not.toHaveProperty('motherName');
  });
});
