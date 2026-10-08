import { describe, expect, it } from 'vitest';
import type { FeeAssessment } from '@mechanization/shared-schemas';
import { describeAssessment } from './fee-assessment';

function assessment(overrides: Partial<FeeAssessment> = {}): FeeAssessment {
  return {
    basis: 'PER_UNIT',
    rate: 100_000,
    unitCount: 6,
    totalArea: 0,
    excludedUnitCount: 0,
    heldUnitCount: 0,
    uninhabitableUnitCount: 0,
    sharedUnitCount: 0,
    coOwnerPaidUnitCount: 0,
    lines: [{ propertyNumber: '12', propertyType: 'COMMERCIAL', unitType: 'SHOP', unitArea: null }],
    ...overrides,
  };
}

describe('describeAssessment', () => {
  it('says nothing for a flat charge or an invoice from before per-unit billing', () => {
    expect(describeAssessment(assessment({ basis: 'FLAT' }))).toBeNull();
    expect(describeAssessment(null)).toBeNull();
  });

  it('writes the same line as before the copy moved to messages', () => {
    expect(describeAssessment(assessment(), 'ar')).toBe('6 محل تجاري × 100,000 ل.ل');
    expect(describeAssessment(assessment({ basis: 'PER_AREA', totalArea: 120.4 }), 'ar')).toBe('120 م² × 100,000 ل.ل');
    expect(describeAssessment(assessment({ excludedUnitCount: 3, heldUnitCount: 1 }), 'ar')).toBe(
      '6 محل تجاري × 100,000 ل.ل (3 وحدة غير محتسبة، 1 وحدة موقوفة للمراجعة)',
    );
    expect(describeAssessment(assessment({ excludedUnitCount: 3, heldUnitCount: 1 }), 'en')).toBe(
      '6 Commercial Shop × 100,000 LBP (3 not charged; 1 held for review)',
    );
  });

  it('names a mix of unit types with the generic word', () => {
    const mixed = assessment({
      lines: [
        { propertyNumber: '12', propertyType: 'COMMERCIAL', unitType: 'SHOP', unitArea: null },
        { propertyNumber: '12', propertyType: 'RESIDENTIAL', unitType: 'APARTMENT', unitArea: null },
      ],
    });
    expect(describeAssessment(mixed, 'ar')).toBe('6 وحدة × 100,000 ل.ل');
    expect(describeAssessment(mixed, 'en')).toBe('6 unit(s) × 100,000 LBP');
  });

  /*
    Decision 2 (2026-10-05): a flat read «غير صالحة للسكن» is held, and the bill
    says so in its own words — not folded into "not charged" or "held for review".
  */
  it('says how many uninhabitable flats the bill held, apart from the other two counts', () => {
    expect(describeAssessment(assessment({ uninhabitableUnitCount: 2 }), 'ar')).toBe(
      '6 محل تجاري × 100,000 ل.ل (2 وحدة غير صالحة للسكن لم تُحتسب)',
    );
    expect(describeAssessment(assessment({ heldUnitCount: 1, uninhabitableUnitCount: 2 }), 'en')).toBe(
      '6 Commercial Shop × 100,000 LBP (1 held for review; 2 uninhabitable, not charged)',
    );
  });

  it('writes counts in Latin digits on the Arabic page, as every figure on the portal is', () => {
    expect(describeAssessment(assessment({ unitCount: 1234, excludedUnitCount: 12 }), 'ar')).not.toMatch(/[٠-٩]/);
  });

  it('says when a co-owned flat is charged at this owner’s part, or paid by another owner', () => {
    const shared = assessment({ unitCount: 3, chargedUnits: 2.25, sharedUnitCount: 1 });
    expect(describeAssessment(shared, 'ar')).toBe(
      '2.25 محل تجاري × 100,000 ل.ل (1 وحدة بملكية مشتركة احتُسبت بحصّة المكلَّف منها)',
    );
    expect(describeAssessment(shared, 'en')).toBe(
      '2.25 Commercial Shop × 100,000 LBP (1 co-owned, charged at this owner’s part)',
    );
    const parts = assessment({
      basis: 'PER_AREA',
      unitCount: 1,
      totalArea: 100 / 3,
      sharedUnitCount: 1,
      lines: [
        {
          propertyNumber: '12',
          propertyType: 'BUILDING',
          unitType: 'SHOP',
          unitArea: 100,
          ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 3 },
        },
      ],
    });
    expect(describeAssessment(parts, 'ar')).toBe(
      '33.33 م² × 100,000 ل.ل (1 وحدة بملكية مشتركة احتُسبت بحصّة المكلَّف منها (1/3))',
    );
    const paidByOther = assessment({ unitCount: 0, coOwnerPaidUnitCount: 1, lines: [] });
    expect(describeAssessment(paidByOther, 'ar')).toBe('0 وحدة × 100,000 ل.ل (1 وحدة يدفع رسمها مالك آخر)');
  });
});
