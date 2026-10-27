import type { FeeBearer, FeeMatrixBracket } from '@mechanization/shared-schemas';
import type { BillablePropertyEntry, LinkedUnit } from '../../../domain/entities/billable-unit';
import { assessCitizen } from './fees.service';
import { splitSharedUnitBills, type TieredCitizen } from './tiered-area';

/**
 * «الرسم حسب فئة المساحة» — a TIERED_AREA notice priced, and the shared unit
 * bill (decisions D1, D5 and D7 of 2026-10-23,
 * docs/fees-system-rearchitecture-specification.md §5 and §8).
 */

const bracket = (row: Partial<FeeMatrixBracket> & Pick<FeeMatrixBracket, 'code' | 'minArea' | 'maxArea' | 'amount'>): FeeMatrixBracket => ({
  labelAr: `الفئة ${row.code}`,
  unitTypes: ['APARTMENT'],
  levels: 1,
  ...row,
});

const TABLE: FeeMatrixBracket[] = [
  bracket({ code: 'A', minArea: 0, maxArea: 100, amount: 1_000_000 }),
  bracket({ code: 'B', minArea: 100, maxArea: 150, amount: 1_500_000 }),
  bracket({ code: 'C', minArea: 150, maxArea: null, amount: 2_000_000 }),
  bracket({ code: 'D2', levels: 2, minArea: 0, maxArea: null, amount: 2_500_000 }),
  bracket({ code: 'S', unitTypes: ['SHOP'], minArea: 0, maxArea: null, amount: 30_000_000 }),
];

type Flat = Partial<LinkedUnit> & { id: string };

/** One مبنى card listing census flats, filed by an owner unless told otherwise. */
const card = (flats: Flat[], occupancyType = 'OWNER', lineArea?: number | null): BillablePropertyEntry => ({
  propertyType: 'BUILDING',
  propertyNumber: '352',
  occupancyType,
  unitType: null,
  unitArea: null,
  units: flats.map((flat) => ({
    unitType: flat.unitType ?? 'APARTMENT',
    unitArea: lineArea === undefined ? flat.unitArea ?? null : lineArea,
    unitStatus: flat.unitStatus ?? null,
    unit: { unitType: 'APARTMENT', unitArea: null, unitCode: flat.id.toUpperCase(), ...flat },
  })),
});

const tiered = (entries: BillablePropertyEntry[], bearer: FeeBearer = 'OCCUPANT') =>
  assessCitizen(entries, { amount: 0, basis: 'TIERED_AREA', bearer, matrixBrackets: TABLE });

/** One citizen's assessment as the run holds it. */
function citizen(citizenId: string, entries: BillablePropertyEntry[], bearer: FeeBearer = 'OCCUPANT'): TieredCitizen {
  const outcome = tiered(entries, bearer);
  if (outcome.kind !== 'assessed') throw new Error(`${citizenId} unassessable: ${outcome.reason}`);
  return { citizenId, amount: outcome.amount, assessment: outcome.assessment, tieredUnits: outcome.tieredUnits };
}

describe('assessCitizen under TIERED_AREA', () => {
  it('charges each unit the bracket its area falls in, an area on a boundary in the upper one (T-3)', () => {
    const outcome = tiered([card([{ id: 'u1', unitArea: 100 }, { id: 'u2', unitArea: 60 }])]);
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 2_500_000,
      assessment: { basis: 'TIERED_AREA', rate: 0, unitCount: 2, totalArea: 160 },
    });
    if (outcome.kind !== 'assessed') return;
    expect(outcome.assessment.lines.map((line) => [line.unitCode, line.bracketCode, line.unitArea])).toEqual([
      ['U1', 'B', 100],
      ['U2', 'A', 60],
    ]);
  });

  it('prices a duplex from the duplex brackets, with no roof factor (T-4, D1)', () => {
    const outcome = tiered([card([{ id: 'dup', unitArea: 220, levels: 2 }])]);
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 2_500_000 });
    if (outcome.kind !== 'assessed') return;
    expect(outcome.assessment.lines[0]).toMatchObject({ bracketCode: 'D2', levels: 2 });
    expect(outcome.assessment.lines[0]!.levelFactor).toBeUndefined();
  });

  it('reports a triplex the table has no brackets for instead of pricing it (T-5), with the unit a screen words', () => {
    expect(tiered([card([{ id: 'tri', unitArea: 300, levels: 3 }])])).toEqual({
      kind: 'unassessable',
      reason: 'وحدة TRI على العقار 352 لا تقع في أي فئة من جدول الفئات لنوعها وعدد طوابقها (3)',
      code: 'NO_BRACKET',
      unit: { unitCode: 'TRI', propertyNumber: '352', unitType: 'APARTMENT', unitArea: 300, levels: 3 },
    });
  });

  it('reports a unit with no area rather than guess its bracket', () => {
    expect(tiered([card([{ id: 'u1' }])])).toEqual({
      kind: 'unassessable',
      reason: 'وحدة U1 على العقار 352 بلا مساحة مسجّلة',
      code: 'NO_AREA',
      unit: { unitCode: 'U1', propertyNumber: '352', unitType: 'APARTMENT', unitArea: null, levels: 1 },
    });
  });

  it('reports a building whose units were never counted by its parcel, as UNSURVEYED', () => {
    const unsurveyed: BillablePropertyEntry = { ...card([]), units: [] };
    expect(tiered([unsurveyed])).toMatchObject({
      kind: 'unassessable',
      code: 'UNSURVEYED',
      unit: { unitCode: null, propertyNumber: '352', unitType: null, unitArea: null, levels: 1 },
    });
  });

  it('relieves a vacant flat under an occupant-borne notice, and counts it (T-6)', () => {
    const outcome = tiered([card([{ id: 'u1', unitArea: 80, unitStatus: 'OWNER_OCCUPIED' }, { id: 'u2', unitArea: 80, unitStatus: 'VACANT' }])]);
    // Outside the notice's unit states (0100), not a unit someone else pays for.
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 1_000_000,
      assessment: { unitCount: 1, excludedUnitCount: 0, outOfScopeUnitCount: 1 },
    });
  });

  it('charges a flat whose status nobody recorded (T-7)', () => {
    expect(tiered([card([{ id: 'u1', unitArea: 80 }])])).toMatchObject({ kind: 'assessed', amount: 1_000_000 });
  });

  it('charges an exempt or an uninhabitable flat nothing, and says so (T-13)', () => {
    const outcome = tiered([
      card([
        { id: 'u1', unitArea: 80 },
        { id: 'mosque', unitArea: 400, exempt: true },
        { id: 'ruin', unitArea: 90, uninhabitable: true },
      ]),
    ]);
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 1_000_000,
      exemptUnitIds: ['mosque'],
      uninhabitableUnitIds: ['ruin'],
      assessment: { exemptUnitCount: 1, uninhabitableUnitCount: 1, unitCount: 1 },
    });
  });

  it('ignores the co-owner methods: the unit is priced whole and billed once by the run (D5)', () => {
    const responsibleIsAnother = { mode: 'RESPONSIBLE_OWNER', numerator: 0, denominator: 1 };
    const outcome = tiered([card([{ id: 'shop', unitType: 'SHOP', unitArea: 40, ownerShare: responsibleIsAnother }])], 'OWNER');
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 30_000_000, coOwnerPaidUnitIds: [] });

    // «حسب الأسهم» with an owner's أسهم missing stops PER_UNIT; it does not stop a bracket fee.
    const undecidable = tiered([card([{ id: 'shop', unitType: 'SHOP', unitArea: 40, ownerShareUndecidable: true }])], 'OWNER');
    expect(undecidable).toMatchObject({ kind: 'assessed', amount: 30_000_000 });
  });

  it('prices a flat once when it reaches one citizen twice', () => {
    const outcome = tiered([card([{ id: 'u1', unitArea: 80 }]), card([{ id: 'u1', unitArea: 80 }])]);
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 1_000_000, assessment: { unitCount: 1 } });
  });
});

describe('splitSharedUnitBills', () => {
  it('bills a shop three brothers own once, in full, to all three (T-8)', () => {
    const shop = { id: 'shop', unitType: 'SHOP', unitArea: 40 };
    const brothers = ['c3', 'c1', 'c2'].map((id) => citizen(id, [card([shop])], 'OWNER'));

    const { own, shared, conflicts } = splitSharedUnitBills(brothers);

    expect(conflicts).toEqual([]);
    expect(shared).toHaveLength(1);
    expect(shared[0]).toMatchObject({
      unitId: 'shop',
      amount: 30_000_000,
      debtors: [
        { citizenId: 'c1', role: 'OWNER' },
        { citizenId: 'c2', role: 'OWNER' },
        { citizenId: 'c3', role: 'OWNER' },
      ],
      assessment: { basis: 'TIERED_AREA', unitCount: 1, sharedBillDebtorCount: 3, lines: [{ bracketCode: 'S' }] },
    });
    // Nothing left on their own bills: no bill for zero is raised.
    expect(own.map((entry) => [entry.citizenId, entry.amount, entry.assessment?.sharedBillUnitCount])).toEqual([
      ['c3', 0, 1],
      ['c1', 0, 1],
      ['c2', 0, 1],
    ]);
  });

  it('keeps a citizen’s own flat on their own bill and moves only the shared one', () => {
    const shop = { id: 'shop', unitType: 'SHOP', unitArea: 40 };
    const withHome = citizen('c1', [card([shop, { id: 'home', unitArea: 120 }])], 'OWNER');
    const partner = citizen('c2', [card([shop])], 'OWNER');

    const { own, shared } = splitSharedUnitBills([withHome, partner]);

    expect(shared.map((bill) => bill.unitId)).toEqual(['shop']);
    expect(own[0]).toMatchObject({
      citizenId: 'c1',
      amount: 1_500_000,
      assessment: { unitCount: 1, sharedBillUnitCount: 1, lines: [{ unitCode: 'HOME', bracketCode: 'B' }] },
    });
  });

  it('bills a flat once to its owner and its tenant when nobody recorded that it is let', () => {
    const owner = citizen('owner', [card([{ id: 'u1', unitArea: 80 }])]);
    const tenant = citizen('tenant', [card([{ id: 'u1', unitArea: 80 }], 'TENANT')]);
    const { shared } = splitSharedUnitBills([owner, tenant]);
    expect(shared[0]?.debtors).toEqual([
      { citizenId: 'owner', role: 'OWNER' },
      { citizenId: 'tenant', role: 'TENANT' },
    ]);
  });

  it('leaves a let flat to its tenant alone: the bearer rule already took it off the owner', () => {
    const owner = citizen('owner', [card([{ id: 'u1', unitArea: 80, unitStatus: 'RENTED' }])]);
    const tenant = citizen('tenant', [card([{ id: 'u1', unitArea: 80, unitStatus: 'RENTED' }], 'TENANT')]);
    const { own, shared } = splitSharedUnitBills([owner, tenant]);
    expect(shared).toEqual([]);
    expect(own.map((entry) => [entry.citizenId, entry.amount])).toEqual([
      ['owner', 0],
      ['tenant', 1_000_000],
    ]);
  });

  it('leaves a card-only unit on each holder’s bill: with no census id it cannot be matched', () => {
    const house = (): BillablePropertyEntry => ({
      propertyType: 'HOUSE',
      propertyNumber: '17',
      occupancyType: 'OWNER',
      unitType: 'APARTMENT',
      unitArea: 90,
      units: [],
    });
    const { own, shared } = splitSharedUnitBills([citizen('c1', [house()]), citizen('c2', [house()])]);
    expect(shared).toEqual([]);
    expect(own.map((entry) => entry.amount)).toEqual([1_000_000, 1_000_000]);
  });

  it('reports a flat whose holders’ records put it in different brackets, and bills it to nobody', () => {
    // The census unit has no area; each card measured its own.
    const first = citizen('c1', [card([{ id: 'u1' }], 'OWNER', 90)], 'OWNER');
    const second = citizen('c2', [card([{ id: 'u1' }], 'OWNER', 120)], 'OWNER');

    const { own, shared, conflicts } = splitSharedUnitBills([first, second]);

    expect(shared).toEqual([]);
    expect(conflicts).toEqual([
      { unitId: 'u1', unitCode: 'U1', propertyNumber: '352', citizenIds: ['c1', 'c2'], bracketCodes: ['A', 'B'] },
    ]);
    expect(own.map((entry) => [entry.amount, entry.assessment?.sharedBillUnitCount])).toEqual([
      [0, undefined],
      [0, undefined],
    ]);
  });

  it('changes nothing when no unit is charged to more than one citizen', () => {
    const run = [citizen('c1', [card([{ id: 'u1', unitArea: 80 }])]), citizen('c2', [card([{ id: 'u2', unitArea: 120 }])])];
    const { own, shared } = splitSharedUnitBills(run);
    expect(shared).toEqual([]);
    expect(own).toEqual(run);
  });
});
