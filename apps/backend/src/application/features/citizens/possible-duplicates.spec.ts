import { POSSIBLE_DUPLICATE_FLAG_PATH } from '@mechanization/shared-schemas';
import {
  assessFindings,
  compareNames,
  duplicateSignals,
  editDistance,
  foldNamePart,
  hasFindings,
  isLikelySamePerson,
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
      { id: 'a', referenceNumber: 'R-A', fullName: 'أ', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME' as const] },
      { id: 'b', referenceNumber: 'R-B', fullName: 'ب', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME' as const] },
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
      { id: 'a', referenceNumber: 'BZR-2609-NCS3T6', fullName: 'علي حسين بسام', motherName: null, phone: null, residence: null, propertyCount: 1, registeredAt: null, registeredBy: null, matchedOn: ['NAME'] },
    ]);
    expect(flag.path).toBe(POSSIBLE_DUPLICATE_FLAG_PATH);
    expect(flag.kind).toBe('UNVERIFIED');
    expect(flag.reason).toContain('BZR-2609-NCS3T6');
    expect(flag.reason.length).toBeLessThanOrEqual(300);
  });
});
