import {
  fingerprintOf,
  planUnitCorrection,
  previewOf,
  RECORDED_IN_ERROR,
  type CorrectionCard,
  type CorrectionLine,
  type UnitCorrectionState,
} from './unit-correction.plan';

/**
 * The rules of «حذف تصحيحي» on plain data. The shapes are the ones the
 * production repair of A2-424-A met on 2026-09-28: an owner with two flats in
 * the building, a free occupant whose card was linked to that owner, and an
 * owner whose card goes on with other flats.
 */

const UNIT = 'b1010000-0000-4000-8000-000000000001';
const OTHER_UNIT = '00010000-0000-4000-8000-000000000002';
const OFFICER = 'off00000-0000-4000-8000-000000000001';
const t = (minute: number) => new Date(Date.UTC(2026, 8, 26, 8, minute));

const line = (id: string, cardId: string, over: Partial<CorrectionLine> = {}): CorrectionLine => ({
  id,
  propertyEntryId: cardId,
  unitId: UNIT,
  unitType: 'WAREHOUSE',
  floor: '-1',
  unitArea: '30',
  endedAt: null,
  endReason: null,
  createdAt: t(10),
  updatedAt: t(10),
  ...over,
});

const card = (id: string, citizenId: string, rows: CorrectionLine[], over: Partial<CorrectionCard> = {}): CorrectionCard => ({
  id,
  registrationId: `reg-${citizenId}`,
  citizenId,
  citizenName: `name ${citizenId}`,
  occupancyType: 'OWNER',
  propertyType: 'BUILDING',
  createdAt: t(1),
  updatedAt: t(1),
  endedAt: null,
  endReason: null,
  landlordCitizenId: null,
  landlordLinkFootprint: null,
  filedById: OFFICER,
  filedByName: 'علي حدرج',
  rows,
  ...over,
});

function state(over: Partial<UnitCorrectionState> = {}): UnitCorrectionState {
  return {
    unit: {
      id: UNIT,
      buildingId: 'bld',
      unitCode: 'B101',
      floor: -1,
      sequence: 1,
      unitType: 'WAREHOUSE',
      unitStatus: 'FREE_OCCUPIED',
      surveyStatus: 'COMPLETE',
      updatedAt: t(30),
    },
    building: { id: 'bld', code: 'A2-424-A', countedUnits: 11, surveyedUnits: 10 },
    occupancies: [],
    visits: [],
    vacancies: [],
    damageIds: [],
    cases: [],
    cards: [],
    registrations: [],
    merges: [],
    ...over,
  };
}

/** B101 as it was in production: owner card keeps 0001, free occupant's card is B101 only and linked. */
function a2424(): UnitCorrectionState {
  const ownerCard = card('owner-card', 'owner', [
    line('owner-0001', 'owner-card', { unitId: OTHER_UNIT, unitType: 'SHOP', createdAt: t(11) }),
    line('owner-b101', 'owner-card', { createdAt: t(40) }),
  ]);
  const occupantCard = card('occupant-card', 'occupant', [line('occupant-b101', 'occupant-card', { createdAt: t(13) })], {
    occupancyType: 'FREE_OCCUPANT',
    landlordCitizenId: 'owner',
    landlordLinkFootprint: {
      v: 1,
      units: [{ unitId: UNIT, unitCode: 'B101', occupancyId: 'occ-owner', row: { propertyEntryId: 'owner-card' } }],
      ownerId: 'owner',
      mintedCardIds: [],
    },
  });
  return state({
    occupancies: [
      { id: 'occ-occupant', citizenId: 'occupant', citizenName: 'حسين', role: 'FREE_OCCUPANT', fromDate: t(13), toDate: null, endReason: null, updatedAt: t(13) },
      { id: 'occ-owner', citizenId: 'owner', citizenName: 'حسن', role: 'OWNER', fromDate: t(40), toDate: null, endReason: null, updatedAt: t(40) },
    ],
    visits: [{ id: 'visit', visitedAt: t(13), outcome: 'COMPLETE', officerName: 'علي حدرج' }],
    cards: [ownerCard, occupantCard],
    registrations: [
      { id: 'reg-owner', citizenId: 'owner', updatedAt: t(1), flaggedFields: [], currentCardIds: ['owner-card'] },
      { id: 'reg-occupant', citizenId: 'occupant', updatedAt: t(1), flaggedFields: [], currentCardIds: ['occupant-card'] },
    ],
  });
}

describe('planUnitCorrection', () => {
  it('ends every current line naming the unit, and only those', () => {
    const plan = planUnitCorrection(a2424());
    expect(plan.lineChanges).toEqual([
      { id: 'owner-b101', cardId: 'owner-card', mode: 'END', previousEndReason: null },
      { id: 'occupant-b101', cardId: 'occupant-card', mode: 'END', previousEndReason: null },
    ]);
    expect(plan.blockers).toEqual([]);
  });

  it('ends a card only when it has no current line left', () => {
    const plan = planUnitCorrection(a2424());
    // The owner keeps 0001, so their card goes on; the occupant's card was B101 alone.
    expect(plan.cardsToEnd).toEqual(['occupant-card']);
  });

  it('clears the landlord link on a card that ends', () => {
    const plan = planUnitCorrection(a2424());
    expect(plan.landlordLinks).toEqual([{ cardId: 'occupant-card', mode: 'CLEAR', footprint: null }]);
  });

  it('prunes the unit from the link of a card that goes on', () => {
    const base = a2424();
    const occupant = base.cards[1]!;
    occupant.rows.push(line('occupant-other', 'occupant-card', { unitId: OTHER_UNIT, createdAt: t(20) }));
    occupant.landlordLinkFootprint = {
      v: 1,
      units: [
        { unitId: UNIT, unitCode: 'B101' },
        { unitId: OTHER_UNIT, unitCode: '0001' },
      ],
      mintedCardIds: [],
    };
    const plan = planUnitCorrection(base);
    expect(plan.cardsToEnd).toEqual([]);
    expect(plan.landlordLinks).toEqual([
      {
        cardId: 'occupant-card',
        mode: 'PRUNE',
        footprint: { v: 1, units: [{ unitId: OTHER_UNIT, unitCode: '0001' }], mintedCardIds: [] },
      },
    ]);
  });

  it('refuses to clear a link on an ending card that also wrote to other units', () => {
    const base = a2424();
    base.cards[1]!.landlordLinkFootprint = {
      v: 1,
      units: [{ unitId: UNIT }, { unitId: OTHER_UNIT }],
      mintedCardIds: [],
    };
    const plan = planUnitCorrection(base);
    expect(plan.blockers).toEqual([{ kind: 'LINK_NAMES_OTHER_UNITS', citizenName: 'name occupant' }]);
  });

  it('refuses a link it cannot read', () => {
    const base = a2424();
    base.cards[1]!.landlordLinkFootprint = { v: 1, units: 'garbled' };
    expect(planUnitCorrection(base).blockers).toEqual([
      { kind: 'UNREADABLE_LANDLORD_LINK', citizenName: 'name occupant' },
    ]);
  });

  it('refuses when a damage assessment would be erased', () => {
    const plan = planUnitCorrection(state({ damageIds: ['dmg-1', 'dmg-2'] }));
    expect(plan.blockers).toEqual([{ kind: 'DAMAGE_ASSESSMENT', count: 2 }]);
  });

  it('re-marks an ended line as recorded in error, and leaves one already so', () => {
    const plan = planUnitCorrection(
      state({
        cards: [
          card('c', 'x', [
            line('moved-out', 'c', { endedAt: t(20), endReason: 'MOVED_OUT' }),
            line('no-reason', 'c', { endedAt: t(21), endReason: null }),
            line('already', 'c', { endedAt: t(22), endReason: RECORDED_IN_ERROR }),
          ]),
        ],
      }),
    );
    expect(plan.lineChanges).toEqual([
      { id: 'moved-out', cardId: 'c', mode: 'RECLASSIFY', previousEndReason: 'MOVED_OUT' },
      { id: 'no-reason', cardId: 'c', mode: 'RECLASSIFY', previousEndReason: null },
    ]);
    // Nothing current on the card changes, so the card is not ended here.
    expect(plan.cardsToEnd).toEqual([]);
  });

  it('never touches a card with no line naming the unit', () => {
    const plan = planUnitCorrection(
      state({ cards: [card('house', 'x', [line('elsewhere', 'house', { unitId: OTHER_UNIT })])] }),
    );
    expect(plan.lineChanges).toEqual([]);
    expect(plan.cardsToEnd).toEqual([]);
  });

  describe('«غير مؤكَّد» flags', () => {
    it('drops the ended row’s flags and moves later rows up', () => {
      const base = a2424();
      // The owner card's rows in creation order: 0001 (row 0), B101 (row 1). Add a later row 2.
      base.cards[0]!.rows.push(line('owner-later', 'owner-card', { unitId: OTHER_UNIT, createdAt: t(50) }));
      base.registrations[0]!.flaggedFields = [
        { path: 'properties.0.units.0.unitArea', reason: 'a' },
        { path: 'properties.0.units.1.unitArea', reason: 'b' },
        { path: 'properties.0.units.2.unitArea', reason: 'c' },
      ];
      const change = planUnitCorrection(base).registrationFlags.find((row) => row.registrationId === 'reg-owner')!;
      expect(change.flags).toEqual([
        { path: 'properties.0.units.0.unitArea', reason: 'a' },
        { path: 'properties.0.units.1.unitArea', reason: 'c' },
      ]);
      expect(change.removed).toEqual([{ path: 'properties.0.units.1.unitArea', reason: 'b' }]);
    });

    it('drops an ended card’s flags and moves later cards down', () => {
      const base = a2424();
      base.registrations[1]!.currentCardIds = ['first-card', 'occupant-card', 'third-card'];
      base.registrations[1]!.flaggedFields = [
        { path: 'properties.0.neighborhood', reason: 'keep' },
        { path: 'properties.1.floor', reason: 'goes' },
        { path: 'properties.2.floor', reason: 'moves' },
      ];
      const change = planUnitCorrection(base).registrationFlags.find((row) => row.registrationId === 'reg-occupant')!;
      expect(change.flags).toEqual([
        { path: 'properties.0.neighborhood', reason: 'keep' },
        { path: 'properties.1.floor', reason: 'moves' },
      ]);
      expect(change.status).toBeDefined();
    });

    it('writes nothing when there were no flags', () => {
      expect(planUnitCorrection(a2424()).registrationFlags).toEqual([]);
    });
  });

  describe('pay', () => {
    it('costs each credited officer exactly one unit, however many lines they filed on it', () => {
      expect(planUnitCorrection(a2424()).pay).toEqual([
        { officerId: OFFICER, officerName: 'علي حدرج', unitsLost: 1 },
      ]);
    });

    it('costs nothing for lines or cards already recorded in error, or a structural floor', () => {
      const plan = planUnitCorrection(
        state({
          cards: [
            card('a', 'x', [line('l1', 'a', { endedAt: t(5), endReason: RECORDED_IN_ERROR })]),
            card('b', 'y', [line('l2', 'b')], { endReason: RECORDED_IN_ERROR, endedAt: t(6) }),
            card('c', 'z', [line('l3', 'c', { unitType: 'PILOTIS' })], { filedById: 'other-officer' }),
          ],
        }),
      );
      expect(plan.pay).toEqual([]);
    });
  });

  describe('building counters', () => {
    it('fall by one each for a surveyed unit', () => {
      expect(planUnitCorrection(a2424()).counters).toEqual({
        totalBefore: 11,
        totalAfter: 10,
        surveyedBefore: 10,
        surveyedAfter: 9,
      });
    });

    it('do not move for a structural floor, which never counted', () => {
      const base = state();
      base.unit.unitType = 'EMPTY_FLOOR';
      expect(planUnitCorrection(base).counters).toEqual({
        totalBefore: 11,
        totalAfter: 11,
        surveyedBefore: 10,
        surveyedAfter: 10,
      });
    });

    it('keep the survey count for an unsurveyed unit', () => {
      const base = state();
      base.unit.surveyStatus = 'NOT_SURVEYED';
      expect(planUnitCorrection(base).counters.surveyedAfter).toBe(10);
    });
  });

  it('names everyone whose record changes, once each', () => {
    expect(planUnitCorrection(a2424()).citizensAffected).toEqual(['occupant', 'owner']);
  });
});

describe('fingerprintOf', () => {
  it('is stable under the order rows were read in', () => {
    const a = a2424();
    const b = a2424();
    b.cards.reverse();
    b.occupancies.reverse();
    expect(fingerprintOf(a)).toBe(fingerprintOf(b));
  });

  it.each([
    ['a line was edited', (s: UnitCorrectionState) => (s.cards[0]!.rows[1]!.updatedAt = t(59))],
    ['an occupancy ended', (s: UnitCorrectionState) => (s.occupancies[0]!.toDate = t(59))],
    ['a visit was logged', (s: UnitCorrectionState) => s.visits.push({ id: 'v2', visitedAt: t(59), outcome: 'COMPLETE', officerName: null })],
    ['a flag was added', (s: UnitCorrectionState) => (s.registrations[0]!.flaggedFields = [{ path: 'x' }])],
    ['the unit was renamed', (s: UnitCorrectionState) => (s.unit.unitCode = 'B103')],
    ['another unit was surveyed', (s: UnitCorrectionState) => (s.building.surveyedUnits += 1)],
    ['a merge was undone', (s: UnitCorrectionState) => s.merges.pop()],
    ['credit moved to another officer', (s: UnitCorrectionState) => (s.cards[0]!.filedById = 'off-2')],
  ])('changes when %s', (_label, mutate) => {
    const withMerge = (s: UnitCorrectionState) => {
      s.merges.push({ id: 'm1', survivorId: 'owner', survivorName: 'حسن', absorbedId: 'dup', absorbedName: 'حسن', mergedAt: t(20) });
      return s;
    };
    const before = withMerge(a2424());
    const after = withMerge(a2424());
    mutate(after);
    expect(fingerprintOf(after)).not.toBe(fingerprintOf(before));
  });
});

describe('previewOf', () => {
  it('groups the plan by citizen, with who loses what', () => {
    const current = a2424();
    const preview = previewOf(current, planUnitCorrection(current));
    expect(preview.nothingRecorded).toBe(false);
    // Cards in creation order; these two were created in the same minute, so by id.
    expect(preview.files.map((file) => [file.citizenId, file.cards.map((c) => [c.cardId, c.cardEnds, c.landlordLink])])).toEqual([
      ['occupant', [['occupant-card', true, 'CLEARED']]],
      ['owner', [['owner-card', false, null]]],
    ]);
    expect(preview.removed.occupancies.map((row) => row.id)).toEqual(['occ-occupant', 'occ-owner']);
  });

  it('shows somebody recorded in the unit with nothing on their file as occupancy-only', () => {
    const current = state({
      occupancies: [
        { id: 'occ', citizenId: 'walk-in', citizenName: 'X', role: 'TENANT', fromDate: t(1), toDate: null, endReason: null, updatedAt: t(1) },
      ],
    });
    const preview = previewOf(current, planUnitCorrection(current));
    expect(preview.files).toEqual([
      { citizenId: 'walk-in', citizenName: 'X', occupancyOnly: true, cards: [], flagsRemoved: 0 },
    ]);
  });

  it('warns of a standing merge whose file the delete changes, and of no other', () => {
    const current = a2424();
    // A card of someone else in the building that names another unit: untouched.
    current.cards.push(card('bystander-card', 'bystander', [line('elsewhere', 'bystander-card', { unitId: OTHER_UNIT })]));
    current.merges = [
      { id: 'm-owner', survivorId: 'owner', survivorName: 'حسن', absorbedId: 'dup', absorbedName: 'حسن ب', mergedAt: t(20) },
      { id: 'm-bystander', survivorId: 'bystander', survivorName: 'س', absorbedId: 'dup2', absorbedName: 'س ب', mergedAt: t(21) },
    ];
    const preview = previewOf(current, planUnitCorrection(current));
    expect(preview.mergesEnded).toEqual([
      { mergeId: 'm-owner', survivorId: 'owner', survivorName: 'حسن', absorbedName: 'حسن ب', mergedAt: t(20).toISOString() },
    ]);
  });

  it('warns of a merge of the landlord a changed tenant card is linked to', () => {
    const current = a2424();
    // The occupant's card is linked to the owner; a merge that absorbed the owner's duplicate names that link.
    current.merges = [{ id: 'm', survivorId: 'owner', survivorName: 'حسن', absorbedId: 'dup', absorbedName: 'حسن ب', mergedAt: t(20) }];
    current.cards = current.cards.filter((row) => row.citizenId === 'occupant');
    current.occupancies = current.occupancies.filter((row) => row.citizenId === 'occupant');
    const plan = planUnitCorrection(current);
    expect(plan.citizensAffected).not.toContain('owner');
    expect(previewOf(current, plan).mergesEnded.map((row) => row.mergeId)).toEqual(['m']);
  });

  it('credits the officer the card was filed with', () => {
    const current = a2424();
    current.cards[1]!.filedById = 'filer';
    current.cards[1]!.filedByName = 'م';
    expect(planUnitCorrection(current).pay.map((row) => row.officerId).sort()).toEqual(['filer', OFFICER].sort());
  });

  it('says so when nothing hangs off the unit', () => {
    const current = state();
    expect(previewOf(current, planUnitCorrection(current)).nothingRecorded).toBe(true);
  });
});
