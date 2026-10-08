import { setUnitFeeExemptionSchema } from '@mechanization/shared-schemas';
import { assessCitizen } from './fees.service';
import type { BillablePropertyEntry, LinkedUnit } from '../../../domain/entities/billable-unit';

/**
 * «معفاة من الرسوم» (migration 0077) and «غير صالحة للسكن», on one person's
 * bill — the two ways a unit is charged nothing at all (the user's decisions of
 * 2026-10-07: the mosque itself is exempt; not habitable → exempt).
 */

const card = (unit: Partial<LinkedUnit>, occupancyType = 'OWNER', status = 'OWNER_OCCUPIED'): BillablePropertyEntry => ({
  propertyType: 'BUILDING',
  propertyNumber: '19',
  occupancyType,
  unitType: null,
  unitArea: null,
  units: [
    {
      unitType: 'OFFICE',
      unitArea: 400,
      unitStatus: status,
      unit: { id: 'mosque-0001', unitType: 'OFFICE', unitArea: 400, unitStatus: status, unitCode: '0001', ...unit },
    },
  ],
});

describe('a unit «معفاة من الرسوم»', () => {
  it('is charged nothing under an occupant-borne notice, and the bill says why', () => {
    const outcome = assessCitizen([card({ exempt: true })], { amount: 1000, basis: 'PER_AREA', bearer: 'OCCUPANT' });
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 0,
      exemptUnitIds: ['mosque-0001'],
      assessment: { exemptUnitCount: 1, excludedUnitCount: 0, unitCount: 0 },
    });
  });

  it('is charged nothing under an owner-borne notice either — the waqf is not billed for the mosque', () => {
    const outcome = assessCitizen([card({ exempt: true })], { amount: 1000, basis: 'PER_UNIT', bearer: 'OWNER' });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 0, assessment: { exemptUnitCount: 1 } });
  });

  it('exempts whoever occupies it — a tenant of an exempt unit pays nothing for it', () => {
    const outcome = assessCitizen([card({ exempt: true }, 'TENANT', 'RENTED')], { amount: 1000, basis: 'PER_UNIT' });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 0, assessment: { exemptUnitCount: 1 } });
  });

  it('is reported as exempt, not as held, when it is also under review or uninhabitable', () => {
    const outcome = assessCitizen([card({ exempt: true, underReview: true, uninhabitable: true })], {
      amount: 1000,
      basis: 'PER_UNIT',
    });
    expect(outcome).toMatchObject({
      kind: 'assessed',
      amount: 0,
      assessment: { exemptUnitCount: 1, heldUnitCount: 0, uninhabitableUnitCount: 0 },
    });
  });

  it('needs no area, since nothing is charged on it', () => {
    const outcome = assessCitizen([card({ exempt: true, unitArea: null })], { amount: 1000, basis: 'PER_AREA' });
    expect(outcome.kind).toBe('assessed');
  });

  it('leaves the waqf’s rented shop beside it billed to its tenant as usual', () => {
    const shop = card({ id: 'shop-0002', unitCode: '0002', unitType: 'SHOP', unitArea: 30 }, 'TENANT', 'RENTED');
    const outcome = assessCitizen([shop], { amount: 1000, basis: 'PER_AREA' });
    expect(outcome).toMatchObject({ kind: 'assessed', amount: 30_000, assessment: { exemptUnitCount: 0 } });
  });
});

describe('setUnitFeeExemptionSchema', () => {
  it('needs the reason in words under «سبب آخر», and nothing more for the named reasons', () => {
    expect(setUnitFeeExemptionSchema.safeParse({ reason: 'OTHER' }).success).toBe(false);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: 'OTHER', note: 'قرار المجلس البلدي' }).success).toBe(true);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: 'PLACE_OF_WORSHIP' }).success).toBe(true);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: null }).success).toBe(true);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: 'CHARITY' }).success).toBe(false);
  });
});
