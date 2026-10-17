import { DEED_SHARES, ownerShareOf, sharesOffDeed } from '@mechanization/shared-schemas';
import { ownerSharesIncompleteFinding } from './data-quality.service';

/**
 * «أسهم المالكين لا تبلغ 2400» (finance audit A8; the owner's decision of
 * 2026-10-12): billing «حسب الأسهم» keeps dividing by the recorded owners' sum,
 * and a total other than 2400 is reported for a person to look at, never refused.
 */
describe('owners’ shares that do not add up to the deed', () => {
  const rule = (shares: Array<number | null>, mode: 'BY_SHARES' | 'EQUAL' = 'BY_SHARES') => ({
    mode,
    responsibleOwnerId: null,
    owners: shares.map((value, index) => ({ citizenId: `owner-${index}`, shares: value })),
  });

  it('says nothing when the recorded أسهم make the whole deed', () => {
    expect(sharesOffDeed(rule([800, 800, 800]))).toBeNull();
    expect(DEED_SHARES).toBe(2400);
  });

  it('reports a total short of the deed — a co-owner the census may be missing', () => {
    expect(sharesOffDeed(rule([800, 800]))).toEqual({ total: 1600 });
  });

  it('keeps billing by the sum, as decided: two recorded owners of 800 each pay half each', () => {
    const outcome = ownerShareOf(rule([800, 800]), 'owner-0');
    expect(outcome).toEqual({ kind: 'SHARE', share: { mode: 'BY_SHARES', numerator: 1, denominator: 2 } });
  });

  it('leaves to the other rules a flat with a missing أسهم, one owner, or another method', () => {
    expect(sharesOffDeed(rule([800, null]))).toBeNull();
    expect(sharesOffDeed(rule([1200]))).toBeNull();
    expect(sharesOffDeed(rule([800, 800], 'EQUAL'))).toBeNull();
  });

  it('becomes a dismissable MEDIUM finding keyed by the unit, naming the total', () => {
    const finding = ownerSharesIncompleteFinding(
      { unitId: 'unit-1', unitCode: 'A-3', at: new Date('2026-10-12T08:00:00.000Z') },
      { total: 1600 },
      { id: 'building-1', code: 'B-7', name: null, parcelNumber: '412' },
    );
    expect(finding).toMatchObject({
      kind: 'OWNER_SHARES_INCOMPLETE',
      subjectKey: 'unit-1',
      severity: 'MEDIUM',
      dismissable: true,
    });
    expect(finding.detail).toContain('1600');
    expect(finding.detail).toContain('2400');
  });
});
