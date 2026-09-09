import {
  adminCreateCitizenSubmissionSchema,
  statusForFlags,
} from '@mechanization/shared-schemas';

/**
 * «سبب عام لنقص البيانات» — one reason, spread across the fields it accounts for.
 *
 * D12 is the whole design and it is the opposite of the obvious shortcut. The
 * obvious one is to let a single reason stand for the record and skip the
 * per-field flags; it produces a record with thirty holes and one sentence,
 * and a reviewer who cannot tell which thirty. So the reason is a *default*
 * that fills in a flag per gap — each individually overridable, each naming its
 * own field.
 *
 * These run against the same schema object the controller's pipe and the
 * browser form use, which is what makes them worth writing here rather than
 * against a service: a record filed offline is validated in a browser hours
 * before any server sees it.
 */
const minimal = () => ({
  personal: {
    firstName: 'علي',
    lastName: 'نصرالله',
    /*
      `isLebanese` is here and not left out, and that is not a gap in the test.

      It is one of `NON_FLAGGABLE_FIELDS` — a discriminator the rest of the form
      branches on — so no flag, blanket or otherwise, can excuse it. The plan's
      acceptance criterion says "name + phone only"; the design says the three
      discriminators are answerable by looking at the person and are therefore
      the safe ones to insist on. This is the true minimum.
    */
    isLebanese: true,
  } as Record<string, unknown>,
  contact: { phone: '03 123456' } as Record<string, unknown>,
  properties: [] as Array<Record<string, unknown>>,
  flags: [] as Array<{ path: string; reason: string }>,
  blanketFlagReason: undefined as string | undefined,
});

const failures = (input: unknown): string[] => {
  const result = adminCreateCitizenSubmissionSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
};

describe('blanket reason — the acceptance case', () => {
  it('refuses a near-empty record when no reason is given', () => {
    // The baseline the blanket reason changes. Without it this is just an
    // incomplete form, and every missing field is an error.
    expect(failures(minimal()).length).toBeGreaterThan(0);
  });

  it('accepts the same record with one reason, and flags every gap with it', () => {
    const input = { ...minimal(), blanketFlagReason: 'الأسرة غائبة والجيران لا يعرفون' };

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const flags = result.data.flags;
    expect(flags.length).toBeGreaterThan(0);

    // Every flag names its own field and carries the officer's sentence — the
    // whole of D12. A record with one flag saying "see above" would be the
    // thing this exists to prevent.
    for (const flag of flags) {
      expect(flag.reason).toBe('الأسرة غائبة والجيران لا يعرفون');
      expect(flag.kind).toBe('UNESTABLISHED');
    }

    // The fields a near-empty personal section actually leaves open.
    const paths = flags.map((flag) => flag.path);
    expect(paths).toEqual(expect.arrayContaining(['personal.gender', 'personal.nationality']));

    expect(statusForFlags(flags)).toBe('REQUIRES_REVIEW');
  });

  it('keeps the reason on the record as well as on each flag', () => {
    // Redundant by design: the flags say which fields, this says they came from
    // one statement rather than the same sentence typed thirty times.
    const input = { ...minimal(), blanketFlagReason: 'الأسرة غائبة اليوم' };

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.blanketFlagReason).toBe('الأسرة غائبة اليوم');
  });
});

describe('blanket reason — what it may not cover', () => {
  it('cannot supply a name', () => {
    // `firstName`/`lastName` are NOT NULL on `users` and a record with no name
    // cannot be searched for again — a "pending info" citizen nobody can find
    // is worse than an unregistered one.
    const input = { ...minimal(), blanketFlagReason: 'لا نعرف شيئاً عن الأسرة' };
    delete input.personal.lastName;

    expect(failures(input)).toContain('personal.lastName');
  });

  it('cannot supply a discriminator', () => {
    // Unset, there is no answer to "which fields does this record even have",
    // so there is nothing left to flag against.
    const input = { ...minimal(), blanketFlagReason: 'لا نعرف شيئاً عن الأسرة' };
    delete input.personal.isLebanese;

    expect(failures(input)).toContain('personal.isLebanese');
  });

  it('cannot excuse a value that is present and wrong', () => {
    /*
      The limit that matters most in the field.

      A malformed phone number is a typo to correct, not missing data to excuse.
      Auto-flagging it would blank what the officer typed and hide the mistake
      behind a reason that does not describe it — and the household would end up
      unreachable with a note saying nobody was home.
    */
    const input = { ...minimal(), blanketFlagReason: 'الأسرة غائبة اليوم' };
    input.contact.phone = '123';

    expect(failures(input)).toContain('contact.phone');
  });

  it('does not touch a field the officer filled in', () => {
    const input = { ...minimal(), blanketFlagReason: 'الأسرة غائبة اليوم' };
    input.personal.gender = 'MALE';

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.personal.gender).toBe('MALE');
    expect(result.data.flags.map((f) => f.path)).not.toContain('personal.gender');
  });
});

describe('blanket reason — alongside the officer’s own flags', () => {
  it('leaves a specific reason in place rather than overwriting it', () => {
    // The blanket reason is a *default*. An officer who wrote something better
    // for one field keeps it — that is what "overridable" means.
    const input = { ...minimal(), blanketFlagReason: 'الأسرة غائبة اليوم' };
    input.flags = [{ path: 'personal.gender', reason: 'رفضوا الإفصاح عن الجنس' }];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const gender = result.data.flags.find((flag) => flag.path === 'personal.gender');
    expect(gender?.reason).toBe('رفضوا الإفصاح عن الجنس');

    // And it is there exactly once — a field flagged twice is a contradiction
    // the storage cannot express.
    expect(result.data.flags.filter((f) => f.path === 'personal.gender')).toHaveLength(1);
  });

  it('covers a building’s unit fields, one flag per unit', () => {
    const input = { ...minimal(), blanketFlagReason: 'الدرج مقفل ولم نصعد' };
    input.personal.gender = 'MALE';
    input.personal.bloodType = 'O_POSITIVE';
    input.personal.nationality = 'لبناني';
    input.personal.identityDocType = 'NATIONAL_ID';
    input.personal.identityDocNumber = '12345';
    input.personal.civilRecordNumber = '7';
    input.personal.residentStatus = 'VILLAGE_RESIDENT';
    input.contact.maritalStatus = 'MARRIED';
    input.contact.whatsappSameAsPhone = true;
    input.contact.totalRegisteredMembers = '4';
    input.contact.actualHouseholdMembers = '4';
    input.properties = [
      {
        occupancyType: 'OWNER',
        propertyType: 'BUILDING',
        neighborhood: 'الحي الشرقي',
        propertyNumber: '1553',
        buildingName: 'بناية النور',
        units: [
          { unitType: 'APARTMENT', floor: '1', unitArea: '120' },
          // Nothing established about the second flat at all.
          {},
        ],
      },
    ];

    const result = adminCreateCitizenSubmissionSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const paths = result.data.flags.map((flag) => flag.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'properties.0.units.1.unitType',
        'properties.0.units.1.floor',
        'properties.0.units.1.unitArea',
      ]),
    );

    // The surveyed flat is untouched — a blanket reason fills gaps, it does not
    // blank what an officer managed to record.
    expect(result.data.properties[0]?.units?.[0]?.unitArea).toBe(120);
  });
});
