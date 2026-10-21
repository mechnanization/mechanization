import { assessCitizen } from './fees.service';
import type { BillablePropertyEntry, LinkedUnit } from '../../../domain/entities/billable-unit';

/**
 * «لكل سقف» — what a home on several levels is charged (migration 0095,
 * decision D28, 2026-10-17): a duplex flat pays 1.8 roofs where two separate
 * flats stacked on each other pay 2; a house pays one full roof per storey; and
 * only a per-unit notice weighs levels at all.
 */

const FACTORS = { '2': 1.8 };
const ROOF = 1_000_000;

/** One owner-occupied unit on a «مبنى» card, linked to its census unit. */
const flat = (unit: Partial<LinkedUnit>, occupancyType = 'OWNER'): BillablePropertyEntry => ({
  propertyType: 'BUILDING',
  propertyNumber: '352',
  occupancyType,
  unitType: null,
  unitArea: null,
  units: [
    {
      unitType: 'APARTMENT',
      unitArea: 170,
      unitStatus: occupancyType === 'OWNER' ? 'OWNER_OCCUPIED' : null,
      unit: {
        id: `unit-${unit.unitCode ?? '0001'}`,
        unitType: 'APARTMENT',
        unitArea: 170,
        unitStatus: 'OWNER_OCCUPIED',
        unitCode: '0001',
        ...unit,
      },
    },
  ],
});

/** A «منزل» card on a one-unit structure — the card-level shape. */
const house = (levels: number): BillablePropertyEntry => ({
  propertyType: 'HOUSE',
  propertyNumber: '352',
  occupancyType: 'OWNER',
  unitType: 'INDEPENDENT_HOUSE',
  unitArea: 200,
  unitStatus: 'OWNER_OCCUPIED',
  soleUnitId: 'house-0001',
  soleUnitCode: '0001',
  levels,
  units: [],
});

describe('a home on several levels, under a per-unit notice («لكل سقف»)', () => {
  it('charges a duplex flat 1.8 roofs, and says so on the line', () => {
    const outcome = assessCitizen([flat({ levels: 2 })], { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS });
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 1_800_000,
      assessment: { unitCount: 1, chargedUnits: 1.8, lines: [{ unitCode: '0001', levels: 2, levelFactor: 1.8 }] },
    });
  });

  it('charges two separate flats stacked on each other 2 roofs — the case the discount is measured against', () => {
    const outcome = assessCitizen(
      [flat({ unitCode: '0001' }), flat({ id: 'unit-0101', unitCode: '0101' })],
      { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS },
    );
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 2_000_000, assessment: { unitCount: 2 } });
    if (outcome.kind !== 'assessed') throw new Error('unreachable');
    // Every unit counts one, so the bill carries no weighed count and no factor.
    expect(outcome.assessment.chargedUnits).toBeUndefined();
    expect(outcome.assessment.lines.every((line) => line.levelFactor === undefined)).toBe(true);
  });

  it('refuses a triplex the table does not price, rather than billing it 1 or 3', () => {
    const outcome = assessCitizen([flat({ levels: 3 })], { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS });
    expect(outcome.kind).toBe('unassessable');
    if (outcome.kind === 'unassessable') expect(outcome.reason).toContain('3 طوابق');
  });

  it('prices a triplex once the municipality enters its factor', () => {
    const outcome = assessCitizen([flat({ levels: 3 })], {
      amount: ROOF,
      basis: 'PER_UNIT',
      levelFactors: { '2': 1.8, '3': 2.5 },
    });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 2_500_000, assessment: { chargedUnits: 2.5 } });
  });

  it('refuses a duplex when no table was passed — a caller that forgot cannot fall back to a guess', () => {
    const outcome = assessCitizen([flat({ levels: 2 })], { amount: ROOF, basis: 'PER_UNIT' });
    expect(outcome.kind).toBe('unassessable');
  });

  it('charges a house one full roof per storey — the discount is for flats', () => {
    const outcome = assessCitizen([house(2)], { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS });
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 2_000_000,
      assessment: { chargedUnits: 2, lines: [{ levels: 2, levelFactor: 2 }] },
    });
  });

  it('charges a one-storey house one roof, exactly as before', () => {
    const outcome = assessCitizen([house(1)], { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: ROOF });
    if (outcome.kind === 'assessed') expect(outcome.assessment.chargedUnits).toBeUndefined();
  });

  it('weighs a co-owner’s part of a duplex: half of 1.8 roofs', () => {
    const outcome = assessCitizen(
      [flat({ levels: 2, ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 2 } })],
      { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS },
    );
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 900_000, assessment: { chargedUnits: 0.9 } });
  });

  it('weighs a tenant’s duplex too — the roof is the flat’s, whoever lives in it', () => {
    const outcome = assessCitizen([flat({ levels: 2, unitStatus: 'RENTED' }, 'TENANT')], {
      amount: ROOF,
      basis: 'PER_UNIT',
      levelFactors: FACTORS,
    });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 1_800_000 });
  });

  it('keeps the sum exact — five duplexes are 9 roofs, not 9.000000000000002', () => {
    const five = ['0001', '0101', '0201', '0301', '0401'].map((code) => flat({ id: code, unitCode: code, levels: 2 }));
    const outcome = assessCitizen(five, { amount: ROOF, basis: 'PER_UNIT', levelFactors: FACTORS });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 9_000_000, assessment: { chargedUnits: 9 } });
  });
});

describe('levels outside a per-unit notice', () => {
  it('leaves an area-based notice charging the area of every level', () => {
    const outcome = assessCitizen([flat({ levels: 2, unitArea: 340 })], {
      amount: 1000,
      basis: 'PER_AREA',
      levelFactors: FACTORS,
    });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 340_000 });
    if (outcome.kind === 'assessed') expect(outcome.assessment.lines[0]!.levelFactor).toBeUndefined();
  });

  it('does not refuse an area-based notice over an unpriced triplex', () => {
    const outcome = assessCitizen([flat({ levels: 3 })], { amount: 1000, basis: 'PER_AREA', levelFactors: {} });
    expect(outcome.kind).toBe('assessed');
  });

  it('leaves a flat notice one amount per person', () => {
    const outcome = assessCitizen([flat({ levels: 2 })], { amount: ROOF, basis: 'FLAT', levelFactors: FACTORS });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: ROOF });
  });
});
