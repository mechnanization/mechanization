import type { FeeAssessment } from '@mechanization/shared-schemas';
import { parcelShareOf } from './parcel-dues';

/** «ما المستحق على العقار»: the part of a bill that is one parcel's, by its own lines. */

const assessment = (basis: 'PER_UNIT' | 'PER_AREA', lines: FeeAssessment['lines']): FeeAssessment => ({
  basis,
  rate: 1000,
  unitCount: lines.length,
  totalArea: 0,
  excludedUnitCount: 0,
  heldUnitCount: 0,
  uninhabitableUnitCount: 0,
  sharedUnitCount: 0,
  coOwnerPaidUnitCount: 0,
  exemptUnitCount: 0,
  lines,
});
const line = (propertyNumber: string, unitArea: number | null, extra: Partial<FeeAssessment['lines'][number]> = {}) => ({
  propertyNumber,
  propertyType: 'BUILDING',
  unitType: 'APARTMENT',
  unitArea,
  ...extra,
});

describe('parcelShareOf', () => {
  it('is the whole bill when every line is on the parcel', () => {
    expect(parcelShareOf(assessment('PER_UNIT', [line('420', null, { unitCode: '0005' })]), '420')).toEqual({
      share: 1,
      unitCodes: ['0005'],
      wholeBill: true,
    });
  });

  it('splits a bill over two parcels by area under PER_AREA', () => {
    const part = parcelShareOf(assessment('PER_AREA', [line('420', 150), line('19', 50)]), '420');
    expect(part).toMatchObject({ share: 0.75, wholeBill: false });
  });

  it('weighs a co-owned flat by the owner’s part', () => {
    const part = parcelShareOf(
      assessment('PER_UNIT', [
        line('420', null, { ownerShare: { mode: 'EQUAL', numerator: 1, denominator: 4 } }),
        line('19', null),
      ]),
      '420',
    );
    expect(part!.share).toBeCloseTo(0.2);
  });

  it('is nothing for a bill with no line on the parcel, or no lines at all', () => {
    expect(parcelShareOf(assessment('PER_UNIT', [line('19', null)]), '420')).toBeNull();
    expect(parcelShareOf(null, '420')).toBeNull();
  });
});
