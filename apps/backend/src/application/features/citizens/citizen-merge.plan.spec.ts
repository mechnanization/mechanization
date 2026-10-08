import { POSSIBLE_DUPLICATE_FLAG_PATH } from '@mechanization/shared-schemas';
import {
  planFields,
  planMerge,
  type PlanCard,
  type PlanInput,
  type PlanPerson,
  type PlanRegistration,
  type PlanSpell,
} from './citizen-merge.plan';

/**
 * «دمج ملفين» — each decision a merge makes, card by card.
 *
 * The fixture is one man filed twice: «حسين علي وطفى» (the file kept, filed
 * first by officer A) and «حسين على وطفه» (filed a month later by officer B).
 * Both record flat U1; only the second records U2 and a plot of land.
 */

const at = (day: number) => new Date(Date.UTC(2026, 8, day, 9, 0, 0));

const person = (over: Partial<PlanPerson> & { id: string }): PlanPerson => ({
  isActive: true,
  referenceNumber: null,
  firstName: 'حسين',
  middleName: 'علي',
  lastName: 'وطفى',
  motherName: null,
  phone: null,
  whatsapp: null,
  hasNoPhone: false,
  contactPhone: null,
  gender: null,
  nationality: null,
  isLebanese: null,
  residencyNumber: null,
  residentStatus: null,
  identityDocType: null,
  identityDocNumber: null,
  civilRecordNumber: null,
  maritalStatus: null,
  bloodType: null,
  totalRegisteredMembers: null,
  actualHouseholdMembers: null,
  residence: 'RESIDENT',
  residencePlace: null,
  localContactName: null,
  localContactPhone: null,
  ...over,
});

const registration = (over: Partial<PlanRegistration> & { id: string; citizenId: string }): PlanRegistration => ({
  submittedAt: at(1),
  createdById: null,
  referenceNumber: `REG-${over.id}`,
  status: 'PENDING',
  flaggedFields: [],
  ...over,
});

const card = (over: Partial<PlanCard> & { id: string; registrationId: string }): PlanCard => ({
  filedRegistrationId: null,
  createdAt: at(1),
  endedAt: null,
  occupancyType: 'OWNER',
  propertyType: 'BUILDING',
  buildingId: 'B1',
  propertyNumber: '45',
  unitStatus: null,
  landlordCitizenId: null,
  minted: false,
  units: [],
  ...over,
});

const row = (id: string, unitId: string | null, createdAt = at(1)) => ({
  id,
  unitId,
  unitType: 'APARTMENT',
  unitStatus: 'OWNER_OCCUPIED',
  endedAt: null as Date | null,
  endReason: null as string | null,
  createdAt,
});

function fixture(over: Partial<PlanInput> = {}): PlanInput {
  const keep = person({ id: 'K', referenceNumber: 'BZR-2609-KKKKKK', motherName: null, phone: '+96176000001' });
  const absorb = person({
    id: 'X',
    referenceNumber: 'BZR-2610-XXXXXX',
    middleName: 'على',
    lastName: 'وطفه',
    motherName: 'كاملة كنعان',
    phone: '+96176000001',
    bloodType: 'A_POS',
  });
  return {
    keep,
    absorb,
    keepMerged: false,
    absorbMerged: false,
    registrations: [
      registration({
        id: 'RK',
        citizenId: 'K',
        submittedAt: at(1),
        createdById: 'officer-A',
        status: 'REQUIRES_REVIEW',
        flaggedFields: [
          { path: 'properties.0.unitArea', kind: 'UNESTABLISHED', reason: 'لم تُقس' },
          { path: 'personal.motherName', kind: 'UNESTABLISHED', reason: 'لم يُعرف' },
        ],
      }),
      registration({
        id: 'RX',
        citizenId: 'X',
        submittedAt: at(20),
        createdById: 'officer-B',
        status: 'REQUIRES_REVIEW',
        flaggedFields: [
          { path: 'properties.0.units.0.unitArea', kind: 'UNESTABLISHED', reason: 'U1 area' },
          { path: 'properties.0.units.1.floor', kind: 'UNESTABLISHED', reason: 'U2 floor' },
          { path: 'properties.1.propertyNumber', kind: 'UNESTABLISHED', reason: 'no deed' },
          { path: 'personal.bloodType', kind: 'UNESTABLISHED', reason: 'unknown' },
          {
            path: POSSIBLE_DUPLICATE_FLAG_PATH,
            kind: 'UNVERIFIED',
            reason: 'قد يكون مسجَّلاً مسبقاً: حسين علي وطفى (BZR-2609-KKKKKK) — تحقَّق هل هو الشخص نفسه',
          },
        ],
      }),
    ],
    cards: [
      card({ id: 'c1', registrationId: 'RK', createdAt: at(1), units: [row('r1', 'U1', at(1))] }),
      card({
        id: 'c2',
        registrationId: 'RX',
        createdAt: at(20),
        units: [row('r2', 'U1', at(20)), row('r3', 'U2', at(20))],
      }),
      card({ id: 'c3', registrationId: 'RX', createdAt: at(21), propertyType: 'LAND', buildingId: null, propertyNumber: '77' }),
    ],
    spells: [
      { id: 'sK1', unitId: 'U1', citizenId: 'K', role: 'OWNER', toDate: null },
      { id: 'sX1', unitId: 'U1', citizenId: 'X', role: 'OWNER', toDate: null },
      { id: 'sX2', unitId: 'U2', citizenId: 'X', role: 'OWNER', toDate: null },
    ] satisfies PlanSpell[],
    linkWritten: { cardIds: new Set(), spellIds: new Set() },
    unitCode: (unitId) => `Z-1-45-A-${unitId}`,
    buildingCode: (buildingId) => `Z-1-${buildingId}`,
    singleUnitOf: () => null,
    ...over,
  };
}

describe('planMerge — the file afterwards', () => {
  it('puts every current card on the newest filing, keeping the credit where it was filed', () => {
    const plan = planMerge(fixture());
    expect(plan.blocks).toEqual([]);
    expect(plan.newest?.id).toBe('RX');
    expect(plan.registrationMoves).toEqual(['RX']);
    expect(plan.cardMoves).toEqual([
      {
        cardId: 'c1',
        fromRegistrationId: 'RK',
        toRegistrationId: 'RX',
        filedRegistrationIdBefore: null,
        filedRegistrationIdAfter: 'RK',
      },
    ]);
    expect(plan.finalCards).toEqual(['c1', 'c2', 'c3']);
  });

  it('ends the absorbed copy of a flat both files record, and only that row', () => {
    const plan = planMerge(fixture());
    expect(plan.rowEnds).toEqual([{ rowId: 'r2', cardId: 'c2' }]);
    // c2 still holds U2, so the card itself stays current.
    expect(plan.cardEnds).toEqual([]);
    expect(plan.duplicates).toMatchObject([{ rowId: 'r2', unitId: 'U1', filedOnRegistrationId: 'RX' }]);
  });

  it('ends a whole card when every flat on it was already on the kept file', () => {
    const input = fixture();
    const cards = input.cards.map((entry) =>
      entry.id === 'c2' ? { ...entry, units: [row('r2', 'U1', at(20))] } : entry,
    );
    const plan = planMerge({ ...input, cards });
    expect(plan.cardEnds).toEqual([{ cardId: 'c2', reason: 'RECORDED_IN_ERROR' }]);
    expect(plan.finalCards).toEqual(['c1', 'c3']);
  });

  it('ends a card without «سُجِّل خطأً» when a flat on it ended for a real reason before', () => {
    // The officer filed a flat that was later sold: that dollar stays theirs.
    const input = fixture();
    const sold = { ...row('r4', 'U4', at(20)), endedAt: at(25), endReason: 'OWNERSHIP_TRANSFERRED' };
    const cards = input.cards.map((entry) =>
      entry.id === 'c2' ? { ...entry, units: [row('r2', 'U1', at(20)), sold] } : entry,
    );
    const plan = planMerge({ ...input, cards });
    expect(plan.rowEnds).toEqual([{ rowId: 'r2', cardId: 'c2' }]);
    expect(plan.cardEnds).toEqual([{ cardId: 'c2', reason: null }]);
  });

  it('reads a منزل on a one-unit structure as that unit', () => {
    const input = fixture();
    const cards: PlanCard[] = [
      card({ id: 'h1', registrationId: 'RK', propertyType: 'HOUSE', buildingId: 'B9', units: [] }),
      card({ id: 'c9', registrationId: 'RX', createdAt: at(20), buildingId: 'B9', units: [row('r9', 'U9', at(20))] }),
    ];
    const plan = planMerge({ ...input, cards, spells: [], singleUnitOf: (id) => (id === 'B9' ? 'U9' : null) });
    expect(plan.rowEnds).toEqual([{ rowId: 'r9', cardId: 'c9' }]);
    expect(plan.cardEnds).toEqual([{ cardId: 'c9', reason: 'RECORDED_IN_ERROR' }]);
  });

  it('re-points the absorbed spells and ends the one the kept person already holds', () => {
    const plan = planMerge(fixture());
    expect(plan.spellMoves).toEqual(['sX1', 'sX2']);
    expect(plan.spellEnds).toEqual(['sX1']);
  });
});

describe('planMerge — flags follow what they name', () => {
  it('re-numbers card and row flags to their places on the newest filing', () => {
    const plan = planMerge(fixture());
    const newest = plan.flagWrites.find((write) => write.registrationId === 'RX')!;
    const paths = newest.after.flaggedFields.map((flag) => `${flag.path}=${flag.reason}`);
    expect(paths).toEqual(
      expect.arrayContaining([
        'properties.0.unitArea=لم تُقس', // c1, moved to the front
        'properties.1.units.0.floor=U2 floor', // r3, now c2's only current row
        'properties.2.propertyNumber=no deed', // c3
      ]),
    );
    // r2 ended, and its flag went with it.
    expect(paths.some((path) => path.includes('U1 area'))).toBe(false);
  });

  it("keeps the kept person's flags, drops one a filled field answered, and the «سجل مشابه» the merge answers", () => {
    const plan = planMerge(fixture());
    const newest = plan.flagWrites.find((write) => write.registrationId === 'RX')!;
    const people = newest.after.flaggedFields.filter((flag) => !flag.path.startsWith('properties.'));
    /*
      motherName was blank-and-flagged on the kept file and is now filled, so
      its flag is answered. bloodType arrives from the other file, and brings
      that file's caveat on it with it.
    */
    expect(people).toEqual([{ path: 'personal.bloodType', kind: 'UNESTABLISHED', reason: 'unknown' }]);
    expect(plan.flagsAnswered).toBe(1);
    expect(newest.after.status).toBe('REQUIRES_REVIEW');
  });

  it('reads a flag against the order the form shows, when rows were saved in one go', () => {
    // Rows written by one save share `createdAt` to the microsecond; only the form's own query says which is first.
    const input = fixture();
    const cards = input.cards.map((entry) =>
      entry.id === 'c2' ? { ...entry, units: [row('r3', 'U2', at(20)), row('r2', 'U1', at(20))] } : entry,
    );
    const formOrder = new Map([
      ['RK', [{ id: 'c1', rows: ['r1'] }]],
      // The form lists U1 first, U2 second — the reverse of the array above.
      ['RX', [{ id: 'c2', rows: ['r2', 'r3'] }, { id: 'c3', rows: [] }]],
    ]);
    const plan = planMerge({ ...input, cards, formOrder });
    const newest = plan.flagWrites.find((write) => write.registrationId === 'RX')!;
    const paths = newest.after.flaggedFields.map((flag) => `${flag.path}=${flag.reason}`);
    // «U2 floor» named row 1 in the form (r3); r2 ends, so r3 is now row 0 of c2, card 1.
    expect(paths).toContain('properties.1.units.0.floor=U2 floor');
    expect(paths.some((path) => path.includes('U1 area'))).toBe(false);
  });

  it('places flags by whatever order it is handed — what the service re-reads after the move', () => {
    const plan = planMerge(fixture());
    const placed = plan.flagsFor('RX', [
      { id: 'c3', rows: [] },
      { id: 'c2', rows: ['r3'] },
      { id: 'c1', rows: ['r1'] },
    ])!;
    expect(placed.map((flag) => flag.path)).toEqual(
      expect.arrayContaining(['properties.0.propertyNumber', 'properties.1.units.0.floor', 'properties.2.unitArea']),
    );
    expect(plan.flagsFor('elsewhere', [])).toBeNull();
  });

  it('keeps a «سجل مشابه» that also names somebody beyond the pair', () => {
    const input = fixture();
    const registrations = input.registrations.map((registration) =>
      registration.id === 'RX'
        ? {
            ...registration,
            flaggedFields: [
              {
                path: POSSIBLE_DUPLICATE_FLAG_PATH,
                kind: 'UNVERIFIED',
                reason: 'قد يكون مسجَّلاً مسبقاً: حسين علي وطفى (BZR-2609-KKKKKK)، حسن علي وطفى و1 غيرهم — تحقَّق هل هو الشخص نفسه',
              },
            ],
          }
        : registration,
    );
    const plan = planMerge({ ...input, registrations });
    expect(plan.flagsAnswered).toBe(0);
    const newest = plan.flagWrites.find((write) => write.registrationId === 'RX')!;
    expect(newest.after.flaggedFields.some((flag) => flag.path === POSSIBLE_DUPLICATE_FLAG_PATH)).toBe(true);
  });

  it('clears the flags of cards that left an older filing', () => {
    const plan = planMerge(fixture());
    const old = plan.flagWrites.find((write) => write.registrationId === 'RK')!;
    expect(old.after).toEqual({ flaggedFields: [], status: 'PENDING' });
    expect(old.before.status).toBe('REQUIRES_REVIEW');
  });
});

describe('planMerge — what refuses a merge', () => {
  it('refuses a flat recorded as owned on one file and rented on the other', () => {
    const input = fixture();
    const cards = input.cards.map((entry) => (entry.id === 'c2' ? { ...entry, occupancyType: 'TENANT' } : entry));
    const plan = planMerge({ ...input, cards, spells: [] });
    expect(plan.blocks.map((block) => block.code)).toContain('ROLE_CONFLICT');
  });

  it('refuses when the copy that would end was written by a tenant link', () => {
    const plan = planMerge(fixture({ linkWritten: { cardIds: new Set(['c2']), spellIds: new Set() } }));
    expect(plan.blocks.map((block) => block.code)).toContain('LINKED_DUPLICATE');
  });

  it('refuses when one file rents from the other', () => {
    const input = fixture();
    const cards = input.cards.map((entry) =>
      entry.id === 'c3' ? { ...entry, occupancyType: 'TENANT', landlordCitizenId: 'K' } : entry,
    );
    expect(planMerge({ ...input, cards }).blocks.map((block) => block.code)).toContain('SELF_LINK');
  });

  it('refuses to fold a person into an estate or an institution, or one kind of body into the other (0076)', () => {
    const input = fixture();
    // Flats nobody lives in, so the owner-record rule on «مشغولة من المالك» has nothing to say.
    const cards = input.cards.map((entry) => ({
      ...entry,
      units: entry.units.map((unit) => ({ ...unit, unitStatus: 'VACANT' })),
    }));
    const codes = (keep: string, absorb: string) =>
      planMerge({
        ...input,
        cards,
        keep: { ...input.keep, residence: keep as never },
        absorb: { ...input.absorb, residence: absorb as never },
      }).blocks.map((block) => block.code);
    expect(codes('ESTATE', 'RESIDENT')).toContain('RESIDENCE_CONFLICT');
    expect(codes('RESIDENT', 'INSTITUTION')).toContain('RESIDENCE_CONFLICT');
    expect(codes('ESTATE', 'INSTITUTION')).toContain('RESIDENCE_CONFLICT');
    // Two copies of one estate are one estate.
    expect(codes('ESTATE', 'ESTATE')).not.toContain('RESIDENCE_CONFLICT');
  });

  it('refuses a deactivated file and one already folded into another', () => {
    expect(planMerge(fixture({ absorb: { ...fixture().absorb, isActive: false } })).blocks[0]?.code).toBe('INACTIVE');
    expect(planMerge(fixture({ keepMerged: true })).blocks[0]?.code).toBe('ALREADY_MERGED');
  });

  it("refuses a non-resident file taking on a card that says they live here", () => {
    const input = fixture();
    const cards = input.cards.map((entry) =>
      entry.id === 'c3' ? { ...entry, occupancyType: 'TENANT', propertyType: 'HOUSE', buildingId: null } : entry,
    );
    const plan = planMerge({ ...input, cards, keep: { ...input.keep, residence: 'NON_RESIDENT_OWNER' } });
    expect(plan.blocks.map((block) => block.code)).toContain('RESIDENCE_CONFLICT');
  });

  it('refuses a result with more cards than the edit form can hold', () => {
    const input = fixture();
    const many = Array.from({ length: 26 }, (_, index) =>
      card({ id: `m${index}`, registrationId: 'RX', createdAt: at(22), buildingId: null, propertyType: 'LAND' }),
    );
    expect(planMerge({ ...input, cards: many }).blocks.map((block) => block.code)).toContain('TOO_MANY_CARDS');
  });
});

describe('planFields — the person afterwards', () => {
  const keep = person({ id: 'K', phone: null, motherName: null, bloodType: 'O_POS' });
  const absorb = person({
    id: 'X',
    phone: '+96176000009',
    motherName: 'كاملة كنعان',
    bloodType: 'A_POS',
    totalRegisteredMembers: 5,
    actualHouseholdMembers: 4,
    identityDocType: 'PASSPORT',
    identityDocNumber: 'P123',
    residencePlace: 'بيروت',
  });

  it('fills what the kept file lacks and keeps its own answers', () => {
    const plan = planFields(keep, absorb);
    expect(plan.fills.map((fill) => fill.field)).toEqual([
      'phone',
      'motherName',
      'totalRegisteredMembers',
      'actualHouseholdMembers',
      'identityDocType',
      'identityDocNumber',
    ]);
    expect(plan.identityMoves).toBe(true);
    expect(plan.conflicts).toEqual([{ field: 'bloodType', keep: 'O_POS', absorb: 'A_POS' }]);
  });

  it("never gives a household file a non-resident's مكان الإقامة, or the reverse", () => {
    expect(planFields(keep, absorb).fills.some((fill) => fill.field === 'residencePlace')).toBe(false);
    const nonResident = planFields({ ...keep, residence: 'NON_RESIDENT_OWNER' }, absorb);
    expect(nonResident.fills.map((fill) => fill.field)).toEqual(['phone', 'residencePlace']);
    expect(nonResident.identityMoves).toBe(false);
  });

  it('fills the household counts as a pair or not at all', () => {
    const half = planFields({ ...keep, totalRegisteredMembers: 6 }, absorb);
    expect(half.fills.some((fill) => fill.field === 'actualHouseholdMembers')).toBe(false);
  });

  it('does not list two spellings of one name, or one سجل typed two ways, as a disagreement', () => {
    // Seen in the dialog on 2026-09-29: «علي» against «على» offered as a choice.
    const plan = planFields(
      { ...keep, middleName: 'علي', motherName: 'فاطمة', civilRecordNumber: '40' },
      { ...absorb, middleName: 'على', motherName: 'فاطمه', civilRecordNumber: '٠٤٠' },
    );
    expect(plan.conflicts.map((conflict) => conflict.field)).toEqual(['bloodType']);
  });

  it('reads one phone typed two ways as one answer', () => {
    const plan = planFields({ ...keep, phone: '+961 76 000 009' }, absorb);
    expect(plan.conflicts.some((conflict) => conflict.field === 'phone')).toBe(false);
  });
});

/*
  «لا يملك رقم هاتف» through a merge. The typical pair: the old file holding the
  son's number in `phone`, and the corrected one saying the father has none.
*/
describe('planFields — «لا يملك رقم هاتف»', () => {
  const corrected = person({ id: 'K', hasNoPhone: true, phone: null, whatsapp: null });
  const old = person({ id: 'X', phone: '+96170111222', whatsapp: '+96170111222' });

  it('never refills the phone of a kept file that says it has none — the number becomes its «رقم للتواصل»', () => {
    const plan = planFields(corrected, old);
    const fields = plan.fills.map((fill) => fill.field);
    expect(fields).not.toContain('phone');
    expect(fields).not.toContain('whatsapp');
    expect(plan.fills).toContainEqual({ field: 'contactPhone', value: '+96170111222' });
  });

  it('keeps the kept file’s own «رقم للتواصل» rather than replacing it', () => {
    const plan = planFields({ ...corrected, contactPhone: '+96171999888' }, old);
    expect(plan.fills.some((fill) => fill.field === 'contactPhone')).toBe(false);
  });

  it('shows the administrator that the two files disagree about the phone', () => {
    expect(planFields(corrected, old).conflicts.map((conflict) => conflict.field)).toContain('hasNoPhone');
  });

  it('shows a yes-or-no as a boolean, for the dialog to say in the page’s language', () => {
    const plan = planFields(corrected, { ...old, hasNoPhone: false });
    expect(plan.conflicts).toContainEqual({ field: 'hasNoPhone', keep: true, absorb: false });
    const filled = planFields(person({ id: 'K' }), { ...corrected, id: 'X' });
    expect(filled.fillsForDisplay).toContainEqual({ field: 'hasNoPhone', value: true });
  });

  it('takes «لا يملك رقم هاتف» onto a kept file with no phone and no answer', () => {
    const plan = planFields(person({ id: 'K' }), { ...corrected, id: 'X', contactPhone: '+96171999888' });
    expect(plan.fills).toEqual(
      expect.arrayContaining([
        { field: 'hasNoPhone', value: true },
        { field: 'contactPhone', value: '+96171999888' },
      ]),
    );
    expect(plan.fills.some((fill) => fill.field === 'phone')).toBe(false);
    // Filled, so not also listed as the kept file's «لا» that stays.
    expect(plan.conflicts.some((conflict) => conflict.field === 'hasNoPhone')).toBe(false);
  });

  it('lists no disagreement against a file that never answered the phone question', () => {
    const plan = planFields(corrected, person({ id: 'X' }));
    expect(plan.conflicts.some((conflict) => conflict.field === 'hasNoPhone')).toBe(false);
  });

  it('never fills a «رقم للتواصل» that is the kept file’s own phone', () => {
    const plan = planFields(
      person({ id: 'K', phone: '+96170111222' }),
      person({ id: 'X', contactPhone: '+961 70 111 222' }),
    );
    expect(plan.fills.some((fill) => fill.field === 'contactPhone')).toBe(false);
  });

  it('never marks a kept file with a WhatsApp number of its own as having no phone', () => {
    const plan = planFields(person({ id: 'K', phone: null, whatsapp: '+96171555666' }), { ...corrected, id: 'X' });
    expect(plan.fills.some((fill) => fill.field === 'hasNoPhone')).toBe(false);
    expect(plan.conflicts.map((conflict) => conflict.field)).toContain('hasNoPhone');
  });

  it('never fills as the phone a number the kept file records as its «رقم للتواصل»', () => {
    const plan = planFields(
      person({ id: 'K', phone: null, contactPhone: '+96170111222' }),
      person({ id: 'X', phone: '+961 70 111 222', whatsapp: '+96170111222' }),
    );
    expect(plan.fills.some((fill) => fill.field === 'phone' || fill.field === 'whatsapp')).toBe(false);
  });

  /*
    0072's two rules, over every combination of the phone answers a pair can
    hold, merged both ways: whatever the plan fills, the kept row afterwards is
    one the database accepts.
  */
  it('never plans a kept row that 0072 would refuse', () => {
    const own = [null, '+96170111222'];
    const states = own.flatMap((phone) =>
      own.flatMap((whatsapp) =>
        [null, '+96170111222', '+96171999888'].flatMap((contactPhone) =>
          [false, true].map((hasNoPhone) => ({ phone, whatsapp, contactPhone, hasNoPhone })),
        ),
      ),
    );
    // Only rows that already satisfy the rules can be on either side of a merge.
    const valid = states.filter(
      (s) =>
        !(s.hasNoPhone && (s.phone !== null || s.whatsapp !== null)) &&
        !(s.contactPhone !== null && s.phone !== null && s.contactPhone === s.phone),
    );
    for (const k of valid) {
      for (const x of valid) {
        const plan = planFields(person({ id: 'K', ...k }), person({ id: 'X', ...x }));
        const after: Record<string, unknown> = { ...k };
        for (const fill of plan.fills) after[fill.field] = fill.value;
        const phone = after.phone as string | null;
        const whatsapp = after.whatsapp as string | null;
        const contact = after.contactPhone as string | null;
        expect([k, x, !(after.hasNoPhone === true && (phone !== null || whatsapp !== null))]).toEqual([k, x, true]);
        expect([k, x, !(contact !== null && phone !== null && contact.replace(/\D/g, '') === phone.replace(/\D/g, ''))]).toEqual([k, x, true]);
      }
    }
  });

  it('gives a non-resident survivor neither answer — the household form owns them', () => {
    const plan = planFields(
      person({ id: 'K', residence: 'NON_RESIDENT_OWNER', phone: '+96176000001' }),
      { ...corrected, id: 'X', contactPhone: '+96171999888' },
    );
    expect(plan.fills.some((fill) => fill.field === 'hasNoPhone' || fill.field === 'contactPhone')).toBe(false);
  });
});
