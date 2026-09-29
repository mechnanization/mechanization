import { POSSIBLE_DUPLICATE_FLAG_PATH } from '@mechanization/shared-schemas';
import {
  assessFindings,
  compareMothers,
  compareNames,
  duplicateVerdict,
  duplicateSignals,
  editDistance,
  foldNamePart,
  foldRecordNumber,
  hasFindings,
  isLikelySamePerson,
  matchedOn,
  outstandingFindings,
  possibleDuplicateFlag,
  type PersonKey,
  type RegisterRow,
} from './possible-duplicates';

/**
 * The same-person rule, pinned against the records that actually happened.
 *
 * Every positive case below is a pair production held as two rows for one man
 * (2026-09-14 → 09-16). Every negative case is a pair that looks alike and is
 * genuinely two people — the answer the rule must never collapse, because a
 * question asked about every pair of brothers is a question nobody reads.
 */

const person = (overrides: Partial<PersonKey>): PersonKey => ({
  firstName: '',
  lastName: '',
  ...overrides,
});

const ask = (a: PersonKey, b: PersonKey) => isLikelySamePerson(duplicateSignals(a, b));

describe('name folding', () => {
  it('reads «عبد الحسن» and «عبدالحسن» as one name', () => {
    // The 2026-09-15 duplicate scan missed this pair on the space alone.
    expect(foldNamePart('عبد الحسن')).toBe(foldNamePart('عبدالحسن'));
  });

  it('ignores hamza, taa marbuta and alef maqsura differences', () => {
    expect(foldNamePart('أحمد')).toBe(foldNamePart('احمد'));
    expect(foldNamePart('فاطمة')).toBe(foldNamePart('فاطمه'));
    expect(foldNamePart('مصطفى')).toBe(foldNamePart('مصطفي'));
  });

  it('counts single-letter edits', () => {
    expect(editDistance('اسليمان', 'سليمان')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('compareNames', () => {
  it('matches three identical names exactly, with the middle name compared', () => {
    expect(
      compareNames(
        { firstName: 'علي', middleName: 'حسين', lastName: 'بسام' },
        { firstName: 'علي', middleName: 'حسين', lastName: 'بسام' },
      ),
    ).toEqual({ match: 'EXACT', middleCompared: true });
  });

  it('treats a one-letter slip in a long family name as near', () => {
    expect(
      compareNames(
        { firstName: 'حسين', middleName: 'محمد', lastName: 'اسليمان' },
        { firstName: 'حسين', middleName: 'محمد', lastName: 'سليمان' },
      ).match,
    ).toBe('NEAR');
  });

  it('never treats short names a letter apart as a typo', () => {
    // حسين/حسن and محمد/حمد are different people's names.
    expect(compareNames({ firstName: 'حسين', lastName: 'نسر' }, { firstName: 'حسن', lastName: 'نسر' }).match).toBe(
      'NONE',
    );
    expect(compareNames({ firstName: 'محمد', lastName: 'جفال' }, { firstName: 'حمد', lastName: 'جفال' }).match).toBe(
      'NONE',
    );
  });

  it('reads a missing middle name as unknown, not as a different person', () => {
    expect(
      compareNames(
        { firstName: 'بسام', lastName: 'نسر' },
        { firstName: 'بسام', middleName: 'حبيب', lastName: 'نسر' },
      ),
    ).toEqual({ match: 'EXACT', middleCompared: false });
  });

  it('keeps different middle names apart', () => {
    // حسين علي نسر and حسين حيدر نسر — checked on 2026-09-15, two men.
    expect(
      compareNames(
        { firstName: 'حسين', middleName: 'علي', lastName: 'نسر' },
        { firstName: 'حسين', middleName: 'حيدر', lastName: 'نسر' },
      ).match,
    ).toBe('NONE');
  });
});

describe('isLikelySamePerson — the records production actually held twice', () => {
  it('علي حسين بسام, filed twice four minutes apart with every field identical', () => {
    const a = person({
      firstName: 'علي',
      middleName: 'حسين',
      lastName: 'بسام',
      motherName: 'نظمية سرور',
      phone: '+9613608348',
    });
    expect(ask(a, { ...a })).toBe(true);
  });

  it('حسين محمد اسليمان / سليمان — a typo, the same phone', () => {
    expect(
      ask(
        person({ firstName: 'حسين', middleName: 'محمد', lastName: 'اسليمان', phone: '+9613000001' }),
        person({ firstName: 'حسين', middleName: 'محمد', lastName: 'سليمان', phone: '+9613000001' }),
      ),
    ).toBe(true);
  });

  it('عبد الحسن / عبدالحسن ابراهيم حدرج — identical once the space is folded', () => {
    expect(
      ask(
        person({ firstName: 'عبد الحسن', middleName: 'ابراهيم', lastName: 'حدرج' }),
        person({ firstName: 'عبدالحسن', middleName: 'ابراهيم', lastName: 'حدرج', phone: '+240555511212' }),
      ),
    ).toBe(true);
  });

  it('أحمد علي جفال, twice twelve minutes apart on one phone', () => {
    expect(
      ask(
        person({ firstName: 'أحمد', middleName: 'علي', lastName: 'جفال', phone: '+9613000002' }),
        person({ firstName: 'احمد', middleName: 'علي', lastName: 'جفال', phone: '+9613000002' }),
      ),
    ).toBe(true);
  });
});

describe('isLikelySamePerson — pairs that are genuinely two people', () => {
  it('brothers on one household line with one mother', () => {
    expect(
      ask(
        person({ firstName: 'عبداللطيف', middleName: 'ابراهيم', lastName: 'حدرج', motherName: 'فاطمة دياب', phone: '+9613000003' }),
        person({ firstName: 'أحمد', middleName: 'ابراهيم', lastName: 'حدرج', motherName: 'فاطمة دياب', phone: '+9613000003' }),
      ),
    ).toBe(false);
  });

  it('father and son on one phone', () => {
    expect(
      ask(
        person({ firstName: 'إسماعيل', lastName: 'شقور', phone: '+9613000004' }),
        person({ firstName: 'سامر', middleName: 'إسماعيل', lastName: 'شقور', phone: '+9613000004' }),
      ),
    ).toBe(false);
  });

  it('the same three names with different mothers on file', () => {
    expect(
      ask(
        person({ firstName: 'محمد', middleName: 'علي', lastName: 'نسر', motherName: 'ليديا وطفى' }),
        person({ firstName: 'محمد', middleName: 'علي', lastName: 'نسر', motherName: 'سناء النويري' }),
      ),
    ).toBe(false);
  });

  it('first and family name alike, nothing else to go on', () => {
    // Too weak to interrupt a save; the passive hint panel still shows it.
    expect(
      ask(person({ firstName: 'محمد', lastName: 'نسر' }), person({ firstName: 'محمد', lastName: 'نسر' })),
    ).toBe(false);
  });

  it('still asks when the mothers differ only by a typo', () => {
    expect(
      ask(
        person({ firstName: 'غانم', middleName: 'علي', lastName: 'غانم', motherName: 'زينب سعد' }),
        person({ firstName: 'غانم', middleName: 'علي', lastName: 'غانم', motherName: 'زينب سعيد' }),
      ),
    ).toBe(true);
  });
});

/**
 * The mother's name written at two lengths, which is what got past the rule.
 *
 * Both pairs below are production, 2026-09-19. Each was a duplicate question
 * that was never put, because her father's name was typed at one door and left
 * out at the next and the two readings were compared as single strings.
 */
describe('compareMothers — one woman, written long and short', () => {
  it('reads a name with her father included as the same woman', () => {
    expect(compareMothers('منيرة عواضة', 'منيرة ابراهيم عواضة')).toBe('SAME');
    expect(compareMothers('نوال محمود شعبان', 'نوال شعبان')).toBe('SAME');
    expect(compareMothers('حُسن شلهوب', 'حُسن مرشد شلهوب')).toBe('SAME');
  });

  it('keeps a different family name apart, however alike the first', () => {
    expect(compareMothers('فاطمة دياب', 'فاطمة زيون')).toBe('DIFFERENT');
    expect(compareMothers('ليديا وطفى', 'سناء النويري')).toBe('DIFFERENT');
  });

  it('allows one slip inside a part, and in a short part across the whole name', () => {
    expect(compareMothers('فاطمة دياب', 'فاطة دياب')).toBe('SAME');
    expect(compareMothers('زينب سعد', 'زينب سعيد')).toBe('SAME');
    expect(compareMothers('نور الهدى حدرج', 'نور الهدي حدرج')).toBe('SAME');
  });

  it('matches a lone part against any part, being too little to refuse on', () => {
    expect(compareMothers('فاطمة', 'فاطمة دياب')).toBe('SAME');
    expect(compareMothers('دياب', 'فاطمة دياب')).toBe('SAME');
    expect(compareMothers('مريم', 'فاطمة دياب')).toBe('DIFFERENT');
  });

  it('is unknown, not different, when one side has no mother on file', () => {
    expect(compareMothers(null, 'فاطمة دياب')).toBe('UNKNOWN');
    expect(compareMothers('  ', 'فاطمة دياب')).toBe('UNKNOWN');
  });

  it('asks about سمير عبد الكريم/عبد المريم عواضة — the pair that got through', () => {
    expect(
      ask(
        person({
          firstName: 'سمير',
          middleName: 'عبد الكريم',
          lastName: 'عواضة',
          motherName: 'منيرة عواضة',
          phone: '+96176012427',
        }),
        person({
          firstName: 'سمير',
          middleName: 'عبد المريم',
          lastName: 'عواضة',
          motherName: 'منيرة ابراهيم عواضة',
          phone: '+96176012427',
        }),
      ),
    ).toBe(true);
  });

  it('asks about تهاني مرزوق/مرزوء, who share neither a phone nor a spelling', () => {
    expect(
      ask(
        person({
          firstName: 'تهاني',
          middleName: 'محمد',
          lastName: 'مرزوق',
          motherName: 'نوال شعبان',
          phone: '+96171291921',
        }),
        person({
          firstName: 'تهاني',
          middleName: 'محمد',
          lastName: 'مرزوء',
          motherName: 'نوال محمود شعبان',
          phone: '+96171515149',
        }),
      ),
    ).toBe(true);
  });

  it('still refuses to ask about brothers, whose mother is written one way', () => {
    expect(
      ask(
        person({ firstName: 'حسن', middleName: 'عبد الأمير', lastName: 'طحيني', motherName: 'فاتن الزوزو' }),
        person({ firstName: 'حسين', middleName: 'عبد الأمير', lastName: 'طحيني', motherName: 'فاتن الزوزو' }),
      ),
    ).toBe(false);
  });
});

describe('assessFindings — the three questions one filing can raise', () => {
  const NOW = new Date('2026-09-16T18:40:00Z');
  const OFFICER = 'officer-jawad';

  const row = (overrides: Partial<RegisterRow> & { submittedAt?: Date; createdById?: string }): RegisterRow => {
    const { submittedAt, createdById, ...rest } = overrides;
    return {
      id: 'row',
      referenceNumber: 'BZR-2609-AAAAAA',
      residence: 'RESIDENT',
      firstName: '',
      lastName: '',
      registrations: [
        {
          submittedAt: submittedAt ?? new Date('2026-09-01T10:00:00Z'),
          createdById: createdById ?? 'someone-else',
          createdBy: { firstName: 'جواد', lastName: 'خشاب' },
          _count: { properties: 1 },
        },
      ],
      ...rest,
    };
  };

  it("asks whose number it is when the occupant carries the landlord's phone, filed minutes earlier by the same officer", () => {
    // نور حسين عياش, 2026-09-16: her record held محمد ابراهيم حدرج's number.
    const findings = assessFindings({
      incoming: { firstName: 'نور', middleName: 'حسين', lastName: 'عياش', motherName: 'مريم', phone: '+9613642332' },
      rows: [
        row({
          id: 'landlord',
          firstName: 'محمد',
          middleName: 'ابراهيم',
          lastName: 'حدرج',
          motherName: 'فاطمة دياب',
          phone: '+9613642332',
          submittedAt: new Date('2026-09-16T18:36:00Z'),
          createdById: OFFICER,
        }),
      ],
      cards: [{ occupancyType: 'FREE_OCCUPANT', landlordPhone: '+9613642332', landlordName: 'محمد ابراهيم حدرج' }],
      actorId: OFFICER,
      now: NOW,
    });

    expect(findings.possibleDuplicates).toEqual([]);
    expect(findings.phoneOwners).toMatchObject([{ id: 'landlord', minutesAgo: 4, fields: ['phone'] }]);
    expect(findings.landlordPhoneCards).toEqual([
      { index: 0, landlordName: 'محمد ابراهيم حدرج', field: 'phone' },
    ]);
  });

  it('asks about a WhatsApp number of its own, and names it as the field that matched', () => {
    // The phone is the occupant's own; the WhatsApp number typed beside it is the owner's.
    const findings = assessFindings({
      incoming: {
        firstName: 'غانم',
        middleName: 'علي',
        lastName: 'غانم',
        phone: '+9613000010',
        whatsapp: '+9613519180',
      },
      rows: [
        row({
          id: 'owner',
          firstName: 'إهاب',
          middleName: 'حبيب',
          lastName: 'دياب',
          phone: '+9613519180',
          submittedAt: new Date('2026-09-16T18:30:00Z'),
          createdById: OFFICER,
        }),
      ],
      cards: [{ occupancyType: 'FREE_OCCUPANT', landlordPhone: '+9613519180', landlordName: 'إهاب دياب' }],
      actorId: OFFICER,
      now: NOW,
    });

    expect(findings.phoneOwners).toMatchObject([{ id: 'owner', fields: ['whatsapp'] }]);
    expect(findings.landlordPhoneCards).toEqual([{ index: 0, landlordName: 'إهاب دياب', field: 'whatsapp' }]);
  });

  it('treats a WhatsApp number equal to the phone as the phone, not a second question', () => {
    const findings = assessFindings({
      incoming: { firstName: 'نور', lastName: 'عياش', phone: '+9613642332', whatsapp: '+9613642332' },
      rows: [
        row({
          id: 'landlord',
          firstName: 'محمد',
          lastName: 'حدرج',
          phone: '+9613642332',
          submittedAt: new Date('2026-09-16T18:36:00Z'),
          createdById: OFFICER,
        }),
      ],
      cards: [],
      actorId: OFFICER,
      now: NOW,
    });
    expect(findings.phoneOwners).toMatchObject([{ id: 'landlord', fields: ['phone'] }]);
  });

  it('does not ask about a household line registered last week by somebody else', () => {
    const findings = assessFindings({
      incoming: { firstName: 'سامر', middleName: 'إسماعيل', lastName: 'شقور', phone: '+9613000004' },
      rows: [row({ id: 'father', firstName: 'إسماعيل', lastName: 'شقور', phone: '+9613000004' })],
      cards: [{ occupancyType: 'OWNER' }],
      actorId: OFFICER,
      now: NOW,
    });
    expect(hasFindings(findings)).toBe(false);
  });

  it("never asks about an owner's own card, which has no landlord", () => {
    const findings = assessFindings({
      incoming: { firstName: 'جهاد', lastName: 'نسر', phone: '+9613111111' },
      rows: [],
      cards: [{ occupancyType: 'OWNER', landlordPhone: '+9613111111' }],
      actorId: OFFICER,
      now: NOW,
    });
    expect(findings.landlordPhoneCards).toEqual([]);
  });

  it('lists a likely duplicate once, as a duplicate rather than as a phone owner', () => {
    const findings = assessFindings({
      incoming: { firstName: 'علي', middleName: 'حسين', lastName: 'بسام', phone: '+9613608348' },
      rows: [
        row({
          id: 'first-filing',
          firstName: 'علي',
          middleName: 'حسين',
          lastName: 'بسام',
          phone: '+9613608348',
          submittedAt: new Date('2026-09-16T17:32:13Z'),
          createdById: OFFICER,
        }),
      ],
      cards: [],
      actorId: OFFICER,
      now: new Date('2026-09-16T17:36:11Z'),
    });
    expect(findings.possibleDuplicates).toMatchObject([
      { id: 'first-filing', matchedOn: ['NAME', 'PHONE'], registeredBy: 'جواد خشاب' },
    ]);
    expect(findings.phoneOwners).toEqual([]);
  });
});

describe('outstandingFindings — an answer covers only what was shown', () => {
  const findings = {
    possibleDuplicates: [
      { id: 'a', referenceNumber: 'R-A', fullName: 'أ', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME' as const], certain: false },
      { id: 'b', referenceNumber: 'R-B', fullName: 'ب', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME' as const], certain: false },
    ],
    phoneOwners: [{ id: 'p', referenceNumber: 'R-P', fullName: 'ج', phone: '+9613', fields: ['phone' as const], registeredAt: '', minutesAgo: 3 }],
    landlordPhoneCards: [{ index: 0, landlordName: 'د', field: 'phone' as const }],
  };

  it('asks again about a record the officer was not shown', () => {
    // «b» registered between the dialog opening and the save.
    const open = outstandingFindings(findings, {
      differentFrom: ['a'],
      sharedPhoneWith: ['p'],
      sharedPhoneWithLandlord: true,
      reason: 'أخوان، الأم مختلفة',
    });
    expect(open.possibleDuplicates.map((c) => c.id)).toEqual(['b']);
    expect(open.phoneOwners).toEqual([]);
    expect(open.landlordPhoneCards).toEqual([]);
    expect(hasFindings(open)).toBe(true);
  });

  it('leaves everything open without an answer', () => {
    expect(outstandingFindings(findings, undefined)).toEqual(findings);
  });
});

describe('possibleDuplicateFlag — the note on a filing nobody could be asked about', () => {
  it('names the records by reference, as a server-only UNVERIFIED flag', () => {
    const flag = possibleDuplicateFlag([
      { id: 'a', referenceNumber: 'BZR-2609-NCS3T6', fullName: 'علي حسين بسام', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME'], certain: false },
    ]);
    expect(flag.path).toBe(POSSIBLE_DUPLICATE_FLAG_PATH);
    expect(flag.kind).toBe('UNVERIFIED');
    expect(flag.reason).toContain('BZR-2609-NCS3T6');
    expect(flag.reason.length).toBeLessThanOrEqual(300);
  });
});

/**
 * Several facts adding up (2026-09-28, user): «رقم السجل with multiple things»
 * — no one household fact is anybody's alone, but together with a name that
 * already agrees they are what a person at the counter would notice.
 */
describe('isLikelySamePerson — facts that add up', () => {
  it('reads a سجل number the same however it was typed', () => {
    expect(foldRecordNumber('٠٤٠')).toBe('40');
    expect(foldRecordNumber(' 40 ')).toBe('40');
    expect(foldRecordNumber(null)).toBe('');
  });

  it('asks about the same first and family name with the same رقم السجل and one more fact', () => {
    expect(
      ask(
        person({ firstName: 'حسين', lastName: 'وطفى', civilRecordNumber: '40', phone: '+96176000001' }),
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفى', civilRecordNumber: '٤٠', phone: '+96176000001' }),
      ),
    ).toBe(true);
  });

  it('does not let a shared سجل alone tip a name missing the father — cousins named after one grandfather', () => {
    expect(
      ask(
        person({ firstName: 'حسين', lastName: 'وطفى', civilRecordNumber: '40' }),
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفى', civilRecordNumber: '٤٠' }),
      ),
    ).toBe(false);
  });

  it('never counts a placeholder سجل of zeros', () => {
    expect(foldRecordNumber('000')).toBe('');
    expect(
      ask(
        person({ firstName: 'محمد', lastName: 'نسر', civilRecordNumber: '0', phone: '+96176000001' }),
        person({ firstName: 'محمد', middleName: 'علي', lastName: 'نسر', civilRecordNumber: '0', phone: '+96176000009' }),
      ),
    ).toBe(false);
  });

  it('asks when the family name is spelled two ways but the father, mother and سجل agree', () => {
    // وطفى / وطفة: four letters, too short to be allowed a typo of its own.
    const a = person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفى', motherName: 'كاملة كنعان', civilRecordNumber: '40' });
    const b = person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفة', motherName: 'كاملة كنعان', civilRecordNumber: '40' });
    expect(compareNames(a, b).match).toBe('PARTIAL');
    expect(ask(a, b)).toBe(true);
    expect(matchedOn(duplicateSignals(a, b))).toEqual(['NAME_PARTIAL', 'MOTHER', 'CIVIL_RECORD']);
  });

  it('does not ask on a partly matching name with only one fact agreeing', () => {
    expect(
      ask(
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفى', civilRecordNumber: '40' }),
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'نسر', civilRecordNumber: '40' }),
      ),
    ).toBe(false);
  });

  it('needs the mother in full and more when the family name differs and no father is on one side', () => {
    const base = { firstName: 'حسين', motherName: 'كاملة كنعان', civilRecordNumber: '40', phone: '+96176000001' };
    expect(ask(person({ ...base, lastName: 'وطفى' }), person({ ...base, middleName: 'علي', lastName: 'وطفة' }))).toBe(true);
    // A lone «كاملة» is half the village; with the سجل it is still not enough.
    expect(
      ask(
        person({ ...base, lastName: 'وطفى', phone: '+96176000002', motherName: 'كاملة' }),
        person({ ...base, middleName: 'علي', lastName: 'وطفة' }),
      ),
    ).toBe(false);
    // And a residence permit cannot carry a different family name with no father to compare.
    expect(
      ask(
        person({ firstName: 'حسين', lastName: 'وطفى', residencyNumber: 'R-1', phone: '+96176000003' }),
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفة', residencyNumber: 'R-1', phone: '+96176000003' }),
      ),
    ).toBe(false);
  });

  it('never treats a real name one letter from another as a typo', () => {
    const base = { middleName: 'علي', lastName: 'حدرج', motherName: 'فاطمة دياب', phone: '+96176000004' };
    expect(ask(person({ ...base, firstName: 'عبد الحسن' }), person({ ...base, firstName: 'عبد الحسين' }))).toBe(false);
    expect(ask(person({ ...base, firstName: 'سليمان' }), person({ ...base, firstName: 'سلمان' }))).toBe(false);
    // The feminine form is a different person, not a slip.
    expect(compareNames({ firstName: 'جميل', lastName: 'نسر' }, { firstName: 'جميلة', lastName: 'نسر' }).match).toBe('NONE');
    // A misspelling that is no one's name is still a typo.
    expect(compareNames({ firstName: 'سمير', middleName: 'عبد الكريم', lastName: 'عواضة' }, { firstName: 'سمير', middleName: 'عبد المريم', lastName: 'عواضة' }).match).toBe('NEAR');
  });

  it('reads a family name with and without «ال» as one family', () => {
    expect(compareNames({ firstName: 'أحمد', middleName: 'محمود', lastName: 'الخطيب' }, { firstName: 'احمد', middleName: 'محمود', lastName: 'خطيب' }).match).toBe('EXACT');
  });

  it('counts hard against a match what says two people: gender, nationality, two permits', () => {
    const same = { firstName: 'نور', middleName: 'علي', lastName: 'حدرج', motherName: 'فاطمة دياب', phone: '+96176000005' };
    expect(ask(person({ ...same, gender: 'FEMALE' }), person({ ...same, gender: 'MALE' }))).toBe(false);
    expect(ask(person({ ...same, residencyNumber: 'R-1' }), person({ ...same, residencyNumber: 'R-2' }))).toBe(false);
    // Three names alone are outweighed by one Lebanese and one not…
    const names = { firstName: 'نور', middleName: 'علي', lastName: 'حدرج' };
    expect(ask(person({ ...names, isLebanese: true }), person({ ...names, isLebanese: false }))).toBe(false);
    // …while overwhelming agreement is still asked about — and never refused.
    const strong = duplicateSignals(person({ ...same, isLebanese: true }), person({ ...same, isLebanese: false }));
    expect(isLikelySamePerson(strong)).toBe(true);
    expect(duplicateVerdict(strong)).toBe('ASK');
  });

  it('counts the same flat as a fact of their own', () => {
    const a = person({ firstName: 'حسين', lastName: 'وطفى', unitIds: ['unit-1'] });
    const b = person({ firstName: 'حسين', middleName: 'علي', lastName: 'وطفى', unitIds: ['unit-1', 'unit-2'] });
    expect(matchedOn(duplicateSignals(a, b))).toEqual(['NAME', 'SAME_UNIT']);
    expect(ask(a, b)).toBe(true);
  });

  it('never asks about brothers, however much of the household they share', () => {
    const household = { middleName: 'علي', lastName: 'وطفى', motherName: 'كاملة كنعان', civilRecordNumber: '40', phone: '+96176000003' };
    expect(ask(person({ firstName: 'حسين', ...household }), person({ firstName: 'حسن', ...household }))).toBe(false);
  });

  it('never asks when the mothers on file differ, whatever else agrees', () => {
    expect(
      ask(
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'نسر', motherName: 'ليديا وطفى', civilRecordNumber: '40' }),
        person({ firstName: 'حسين', middleName: 'علي', lastName: 'نسر', motherName: 'كاملة كنعان', civilRecordNumber: '40' }),
      ),
    ).toBe(false);
  });

  it('counts a residence permit for more than a household fact', () => {
    expect(
      ask(
        person({ firstName: 'أحمد', lastName: 'الخطيب', residencyNumber: 'R-5521' }),
        person({ firstName: 'احمد', middleName: 'محمود', lastName: 'الخطيب', residencyNumber: 'R-5521' }),
      ),
    ).toBe(true);
  });

  it('offers none of the four records the old search-box panel showed for حسين على وطفى', () => {
    // The screenshot of 2026-09-28: every one of these was a false match.
    const typed = person({ firstName: 'حسين', middleName: 'على', lastName: 'وطفى', motherName: 'كاملة كنعان', civilRecordNumber: '40' });
    const offered = [
      person({ firstName: 'حسين', middleName: 'عبدالرضا', lastName: 'وطفى', motherName: 'فايزة جبارة' }),
      person({ firstName: 'حسين', middleName: 'نبيه', lastName: 'وطفى', motherName: 'خديجة حبيب نسر' }),
      person({ firstName: 'ابراهيم', middleName: 'حسين', lastName: 'برو', motherName: 'اعتدال وطفى' }),
      person({ firstName: 'حسين', middleName: 'علي', lastName: 'نسر', motherName: 'ليديا وطفى' }),
    ];
    expect(offered.map((existing) => ask(typed, existing))).toEqual([false, false, false, false]);
  });
});

/**
 * When the officer is stopped rather than asked (user, 2026-09-29): «know when
 * to stop an officer from creating a duplicate — do not just warn».
 */
describe('duplicateVerdict — refuse, ask, or say nothing', () => {
  const verdict = (a: PersonKey, b: PersonKey) => duplicateVerdict(duplicateSignals(a, b));
  const same = {
    firstName: 'حسين',
    middleName: 'علي',
    lastName: 'وطفى',
    motherName: 'كاملة كنعان',
    civilRecordNumber: '40',
    phone: '+96176000111',
  };

  it('refuses the same three names, the same mother in full, and the same سجل', () => {
    expect(verdict(person(same), person({ ...same, phone: '+96176000222' }))).toBe('BLOCK');
  });

  it('refuses the same person with a typo in a long family name, on one phone', () => {
    expect(
      verdict(
        person({ ...same, lastName: 'اسليمان', civilRecordNumber: null }),
        person({ ...same, lastName: 'سليمان', civilRecordNumber: null }),
      ),
    ).toBe('BLOCK');
  });

  it('refuses the same name on the same residence permit', () => {
    expect(
      verdict(
        person({ firstName: 'أحمد', middleName: 'محمود', lastName: 'الخطيب', residencyNumber: 'R-5521' }),
        person({ firstName: 'احمد', middleName: 'محمود', lastName: 'الخطيب', residencyNumber: 'R-5521' }),
      ),
    ).toBe('BLOCK');
  });

  it('only asks when the mother is a lone first name that half the register shares', () => {
    expect(
      verdict(person({ ...same, motherName: 'كاملة' }), person({ ...same, motherName: 'كاملة كنعان' })),
    ).toBe('ASK');
  });

  it('only asks when the father’s name is missing on one side', () => {
    expect(verdict(person({ ...same, middleName: null }), person(same))).toBe('ASK');
  });

  it('only asks on three identical names with nothing of their own agreeing', () => {
    expect(
      verdict(
        person({ ...same, motherName: null, civilRecordNumber: null, phone: '+96176000001' }),
        person({ ...same, motherName: null, civilRecordNumber: null, phone: '+96176000002' }),
      ),
    ).toBe('ASK');
  });

  it('only asks when the family name is spelled two ways, however much else agrees', () => {
    expect(verdict(person(same), person({ ...same, lastName: 'وطفة' }))).toBe('ASK');
  });

  it('never refuses brothers or a namesake with a different mother', () => {
    expect(verdict(person(same), person({ ...same, firstName: 'حسن' }))).toBe('NONE');
    expect(verdict(person(same), person({ ...same, motherName: 'ليديا وطفى' }))).toBe('NONE');
  });
});
