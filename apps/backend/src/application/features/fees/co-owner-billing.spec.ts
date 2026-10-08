import {
  effectiveOwnerBilling,
  ownerShareOf,
  ownerSharesPreview,
  shareWeight,
  type OwnerBillingRule,
} from '@mechanization/shared-schemas';
import { assessCitizen } from './fees.service';
import { profileOwnerBilling } from '../reporting/reporting.service';
import type { BillablePropertyEntry, LinkedUnit } from '../../../domain/entities/billable-unit';

/**
 * «توزيع الرسم على المالكين» — a flat several people own is divided between
 * them, not billed to each in full (migration 0075; the user's decision,
 * 2026-10-07).
 *
 * Production, 2026-10-07: A2-420-A/0005, a 300 m² shop four brothers own,
 * each brother's file claiming it — four bills for one shop. The rule
 * (`ownerShareOf`) and the assessment that applies it are pinned here; the
 * holdings read that attaches the share is pinned in
 * `co-owner-billing.integration.spec.ts`.
 */

const BROTHERS = ['ali', 'maarouf', 'aref', 'hussein'];

const rule = (overrides: Partial<OwnerBillingRule> = {}): OwnerBillingRule => ({
  mode: null,
  responsibleOwnerId: null,
  owners: BROTHERS.map((citizenId) => ({ citizenId, shares: null })),
  ...overrides,
});

describe('ownerShareOf — what part of a co-owned flat each owner is billed for', () => {
  it('splits equally when nobody chose (the default)', () => {
    for (const brother of BROTHERS) {
      const outcome = ownerShareOf(rule(), brother);
      expect(outcome).toEqual({ kind: 'SHARE', share: { mode: 'EQUAL', numerator: 1, denominator: 4 } });
    }
    expect(effectiveOwnerBilling(rule())).toMatchObject({ mode: 'EQUAL', defaulted: true, fallback: null });
  });

  it('bills one owner the whole under «مالك مسؤول», and the others nothing', () => {
    const chosen = rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'ali' });
    expect(ownerShareOf(chosen, 'ali')).toEqual({
      kind: 'SHARE',
      share: { mode: 'RESPONSIBLE_OWNER', numerator: 1, denominator: 1 },
    });
    for (const brother of ['maarouf', 'aref', 'hussein']) {
      expect(ownerShareOf(chosen, brother)).toEqual({
        kind: 'SHARE',
        share: { mode: 'RESPONSIBLE_OWNER', numerator: 0, denominator: 1 },
      });
    }
  });

  it('falls back to the equal split when the responsible owner is no longer an owner', () => {
    const stale = rule({ mode: 'RESPONSIBLE_OWNER', responsibleOwnerId: 'sold-his-part' });
    expect(effectiveOwnerBilling(stale)).toMatchObject({ mode: 'EQUAL', fallback: 'RESPONSIBLE_NOT_OWNER' });
    expect(ownerShareOf(stale, 'ali')).toEqual({
      kind: 'SHARE',
      share: { mode: 'EQUAL', numerator: 1, denominator: 4 },
    });
  });

  it('divides by أسهم over the sum of every owner’s, not over 2400', () => {
    // An unpartitioned building: the 2400 cover the whole of it, so these four
    // hold 900 of it between them and the flat is divided 300/200/200/200.
    const byShares = rule({
      mode: 'BY_SHARES',
      owners: [
        { citizenId: 'ali', shares: 300 },
        { citizenId: 'maarouf', shares: 200 },
        { citizenId: 'aref', shares: 200 },
        { citizenId: 'hussein', shares: 200 },
      ],
    });
    expect(ownerShareOf(byShares, 'ali')).toEqual({
      kind: 'SHARE',
      share: { mode: 'BY_SHARES', numerator: 1, denominator: 3 },
    });
    expect(ownerShareOf(byShares, 'aref')).toEqual({
      kind: 'SHARE',
      share: { mode: 'BY_SHARES', numerator: 2, denominator: 9 },
    });
    const total = BROTHERS.reduce((sum, brother) => {
      const outcome = ownerShareOf(byShares, brother);
      return sum + (outcome.kind === 'SHARE' ? shareWeight(outcome.share) : 0);
    }, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('refuses to guess under «حسب الأسهم» when an owner’s أسهم are missing', () => {
    const missing = rule({
      mode: 'BY_SHARES',
      owners: [
        { citizenId: 'ali', shares: 1200 },
        { citizenId: 'maarouf', shares: null },
      ],
    });
    expect(ownerShareOf(missing, 'ali')).toEqual({ kind: 'UNDECIDABLE', reason: 'SHARES_MISSING' });
  });

  it('bills a flat with one owner whole, whatever was chosen for it', () => {
    const alone = rule({ mode: 'BY_SHARES', owners: [{ citizenId: 'ali', shares: null }] });
    expect(ownerShareOf(alone, 'ali')).toEqual({ kind: 'WHOLE' });
  });

  it('counts a person with two spells on one flat once', () => {
    const twice = rule({
      owners: [
        { citizenId: 'ali', shares: null },
        { citizenId: 'ali', shares: 600 },
        { citizenId: 'aref', shares: null },
      ],
    });
    expect(ownerShareOf(twice, 'ali')).toEqual({
      kind: 'SHARE',
      share: { mode: 'EQUAL', numerator: 1, denominator: 2 },
    });
  });

  it('leaves a card the census does not back billed whole, as it always was', () => {
    expect(ownerShareOf(rule(), 'not-an-owner-of-record')).toEqual({ kind: 'WHOLE' });
  });

  it('previews every owner’s part for the drawer, summing to the whole flat', () => {
    const preview = ownerSharesPreview(rule());
    expect(preview.owners).toHaveLength(4);
    const sum = preview.owners.reduce(
      (total, owner) => total + (owner.outcome.kind === 'SHARE' ? shareWeight(owner.outcome.share) : 0),
      0,
    );
    expect(sum).toBe(1);
  });
});

/** The shop, as billing reads it off one brother's مبنى card once `holdingsOf` has attached his part. */
const shopCard = (
  unit: Partial<LinkedUnit>,
  extra: { occupancyType?: string; status?: string } = {},
): BillablePropertyEntry => ({
  propertyType: 'BUILDING',
  propertyNumber: '420',
  occupancyType: extra.occupancyType ?? 'OWNER',
  unitType: null,
  unitArea: null,
  units: [
    {
      unitType: 'SHOP',
      unitArea: 300,
      unitStatus: extra.status ?? 'OWNER_OCCUPIED',
      unit: { id: 'shop-0005', unitType: 'SHOP', unitArea: 300, unitStatus: extra.status ?? 'OWNER_OCCUPIED', unitCode: '0005', ...unit },
    },
  ],
});

const PER_AREA = { basis: 'PER_AREA' as const, amount: 10_000 };
const PER_UNIT = { basis: 'PER_UNIT' as const, amount: 100_000 };

describe('assessCitizen — a co-owned flat on one owner’s bill', () => {
  it('bills each of four brothers a quarter of the shop’s area, not all of it', () => {
    const quarter = { mode: 'EQUAL', numerator: 1, denominator: 4 };
    const result = assessCitizen([shopCard({ ownerShare: quarter })], { ...PER_AREA, bearer: 'OWNER' });
    expect(result.kind).toBe('assessed');
    if (result.kind !== 'assessed') return;
    expect(result.amount).toBe(750_000); // 75 m² × 10,000
    expect(result.assessment.totalArea).toBe(75);
    expect(result.assessment.sharedUnitCount).toBe(1);
    expect(result.assessment.lines[0]).toMatchObject({ unitCode: '0005', unitArea: 300, ownerShare: quarter });
  });

  it('divides the occupancy fee too when the owners use the shop themselves', () => {
    const quarter = { mode: 'EQUAL', numerator: 1, denominator: 4 };
    const result = assessCitizen([shopCard({ ownerShare: quarter })], { ...PER_UNIT, bearer: 'OCCUPANT' });
    expect(result.kind === 'assessed' && result.amount).toBe(25_000);
    expect(result.kind === 'assessed' && result.assessment.chargedUnits).toBe(0.25);
    expect(result.kind === 'assessed' && result.assessment.unitCount).toBe(1);
  });

  it('bills the responsible owner for the whole shop and the other three for none of it', () => {
    const ali = assessCitizen(
      [shopCard({ ownerShare: { mode: 'RESPONSIBLE_OWNER', numerator: 1, denominator: 1 } })],
      { ...PER_AREA, bearer: 'OWNER' },
    );
    expect(ali.kind === 'assessed' && ali.amount).toBe(3_000_000);
    expect(ali.kind === 'assessed' && ali.assessment.sharedUnitCount).toBe(1);

    const brother = assessCitizen(
      [shopCard({ ownerShare: { mode: 'RESPONSIBLE_OWNER', numerator: 0, denominator: 1 } })],
      { ...PER_AREA, bearer: 'OWNER' },
    );
    expect(brother.kind).toBe('assessed');
    if (brother.kind !== 'assessed') return;
    expect(brother.amount).toBe(0);
    expect(brother.assessment.coOwnerPaidUnitCount).toBe(1);
    expect(brother.assessment.lines).toHaveLength(0);
    expect(brother.assessment.excludedUnitCount).toBe(0);
    // Named by flat, so a run counts the shop once however many brothers it skipped.
    expect(brother.coOwnerPaidUnitIds).toEqual(['shop-0005']);
    expect(ali.kind === 'assessed' && ali.coOwnerPaidUnitIds).toEqual([]);
  });

  it('does not ask for the area of a flat another owner pays for', () => {
    const result = assessCitizen(
      [shopCard({ unitArea: null, ownerShare: { mode: 'RESPONSIBLE_OWNER', numerator: 0, denominator: 1 } })],
      { ...PER_AREA, bearer: 'OWNER' },
    );
    expect(result.kind).toBe('assessed');
  });

  it('refuses rather than guesses under «حسب الأسهم» with an owner’s أسهم missing', () => {
    const result = assessCitizen([shopCard({ ownerShareUndecidable: true })], { ...PER_AREA, bearer: 'OWNER' });
    expect(result.kind).toBe('unassessable');
    expect(result.kind === 'unassessable' && result.reason).toContain('حسب الأسهم');
  });

  it('never divides what a tenant pays — the deed is the owners’ business', () => {
    const result = assessCitizen(
      [
        shopCard(
          // Even if a share were attached by mistake, a tenant's card ignores it.
          { ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 4 }, unitStatus: 'RENTED' },
          { occupancyType: 'TENANT', status: 'RENTED' },
        ),
      ],
      { ...PER_UNIT, bearer: 'OCCUPANT' },
    );
    expect(result.kind === 'assessed' && result.amount).toBe(100_000);
    expect(result.kind === 'assessed' && result.assessment.sharedUnitCount).toBe(0);
  });

  it('leaves a let co-owned flat to its tenant: the owners bear no occupancy fee to divide', () => {
    const result = assessCitizen(
      [shopCard({ ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 4 }, unitStatus: 'RENTED' }, { status: 'RENTED' })],
      { ...PER_UNIT, bearer: 'OCCUPANT' },
    );
    expect(result.kind === 'assessed' && result.amount).toBe(0);
    expect(result.kind === 'assessed' && result.assessment.excludedUnitCount).toBe(1);
    expect(result.kind === 'assessed' && result.assessment.sharedUnitCount).toBe(0);
  });

  it('adds whole flats and a share together under PER_UNIT', () => {
    const entry: BillablePropertyEntry = {
      ...shopCard({ ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 4 } }),
    };
    entry.units = [
      ...entry.units,
      { unitType: 'SHOP', unitArea: 40, unitStatus: 'OWNER_OCCUPIED', unit: { id: 'shop-0006', unitType: 'SHOP', unitArea: 40, unitStatus: 'OWNER_OCCUPIED' } },
      { unitType: 'SHOP', unitArea: 40, unitStatus: 'OWNER_OCCUPIED', unit: { id: 'shop-0007', unitType: 'SHOP', unitArea: 40, unitStatus: 'OWNER_OCCUPIED' } },
    ];
    const result = assessCitizen([entry], { ...PER_UNIT, bearer: 'OWNER' });
    expect(result.kind === 'assessed' && result.amount).toBe(225_000);
    expect(result.kind === 'assessed' && result.assessment.chargedUnits).toBe(2.25);
    expect(result.kind === 'assessed' && result.assessment.unitCount).toBe(3);
  });

  it('divides a منزل owned together, through its one flat', () => {
    const house: BillablePropertyEntry = {
      propertyType: 'HOUSE',
      propertyNumber: '77',
      occupancyType: 'OWNER',
      unitType: 'INDEPENDENT_HOUSE',
      unitArea: 180,
      unitStatus: 'OWNER_OCCUPIED',
      soleUnitId: 'house-0001',
      soleUnitCode: '0001',
      ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 2 },
      units: [],
    };
    const result = assessCitizen([house], { ...PER_AREA, bearer: 'OWNER' });
    expect(result.kind === 'assessed' && result.amount).toBe(900_000);
  });

  it('divides a flat held through the census occupancy table', () => {
    const block: BillablePropertyEntry = {
      propertyType: 'BUILDING',
      propertyNumber: '12',
      occupancyType: 'OWNER',
      unitType: null,
      unitArea: null,
      units: [],
      occupiedUnits: [
        {
          role: 'OWNER',
          unitId: 'flat-0101',
          unitCode: '0101',
          unitType: 'APARTMENT',
          unitArea: 120,
          unitStatus: 'OWNER_OCCUPIED',
          ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 3 },
        },
      ],
    };
    const result = assessCitizen([block], { ...PER_AREA, bearer: 'OWNER' });
    expect(result.kind === 'assessed' && result.amount).toBe(400_000);
  });

  it('bills a flat with no share attached exactly as before', () => {
    const result = assessCitizen([shopCard({})], { ...PER_AREA, bearer: 'OWNER' });
    expect(result.kind === 'assessed' && result.amount).toBe(3_000_000);
    expect(result.kind === 'assessed' && result.assessment.sharedUnitCount).toBe(0);
    expect(result.kind === 'assessed' && 'chargedUnits' in result.assessment).toBe(false);
  });
});

describe('profileOwnerBilling — the co-owned flat on a citizen’s own file', () => {
  const unit = (overrides: { active?: Record<string, boolean>; mode?: 'EQUAL' | 'BY_SHARES' | 'RESPONSIBLE_OWNER' | null } = {}) => ({
    ownerBillingMode: overrides.mode ?? null,
    responsibleOwnerId: null,
    occupancies: BROTHERS.map((citizenId) => ({
      citizenId,
      shares: null,
      citizen: { isActive: overrides.active?.[citizenId] ?? true },
    })),
  });

  it('says nothing about the owners’ split on a tenant’s line', () => {
    expect(profileOwnerBilling(unit(), 'a-tenant')).toBeNull();
  });

  it('gives an owner their part, counting open files only', () => {
    expect(profileOwnerBilling(unit({ active: { hussein: false } }), 'ali')).toMatchObject({
      effectiveMode: 'EQUAL',
      share: { numerator: 1, denominator: 3 },
    });
  });

  it('is absent once only one open file owns the flat', () => {
    expect(
      profileOwnerBilling(unit({ active: { maarouf: false, aref: false, hussein: false } }), 'ali'),
    ).toBeNull();
  });
});
