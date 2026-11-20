import { feeExemptionEndedOn, isFeeExemptOn, setUnitFeeExemptionSchema } from '@mechanization/shared-schemas';
import { issueBillingDay, periodKeyFor } from '../fees/fees.service';
import { billingDayOfPeriod } from './fee-exemption';

/**
 * The rules of «قائمة الإعفاء من الرسوم» with no database (migration 0104;
 * decision 1 of 2026-11-16): when a unit is exempt, and which day of a billing
 * period the exemption is judged on.
 */
describe('isFeeExemptOn', () => {
  const exempt = (validUntil: string | Date | null) => ({ feeExemption: 'PUBLIC_FACILITY', feeExemptionValidUntil: validUntil });

  it('exempts a unit with no last day on any day, and a unit without an exemption on none', () => {
    expect(isFeeExemptOn(exempt(null), '2030-01-01')).toBe(true);
    expect(isFeeExemptOn({ feeExemption: null, feeExemptionValidUntil: null }, '2026-01-01')).toBe(false);
  });

  it('counts the last day itself, and not the day after', () => {
    expect(isFeeExemptOn(exempt('2026-12-31'), '2026-12-31')).toBe(true);
    expect(isFeeExemptOn(exempt('2026-12-31'), '2027-01-01')).toBe(false);
    expect(feeExemptionEndedOn(exempt('2026-12-31'), '2027-01-01')).toBe(true);
  });

  it('reads a date-only column the way Prisma returns it, at UTC midnight', () => {
    expect(isFeeExemptOn(exempt(new Date('2026-12-31T00:00:00.000Z')), '2026-12-31')).toBe(true);
    expect(isFeeExemptOn(exempt(new Date('2026-12-31T00:00:00.000Z')), '2027-01-01')).toBe(false);
  });
});

describe('the day a billing period judges an exemption on', () => {
  it('is the first day of the period its key names', () => {
    expect(billingDayOfPeriod('2026-11', '2026-11-16')).toBe('2026-11-01');
    expect(billingDayOfPeriod('2026-H1', '2026-11-16')).toBe('2026-01-01');
    expect(billingDayOfPeriod('2026-H2', '2026-11-16')).toBe('2026-07-01');
    expect(billingDayOfPeriod('2027', '2026-11-16')).toBe('2027-01-01');
  });

  it('is the day the bill is raised for a one-off notice', () => {
    expect(billingDayOfPeriod('ONCE', '2026-11-16')).toBe('2026-11-16');
  });

  it('agrees with the key the recurring run writes, for every frequency', () => {
    const run = new Date('2026-08-20T09:00:00.000Z');
    for (const frequency of ['MONTHLY', 'HALF_YEARLY', 'ANNUALLY']) {
      const day = billingDayOfPeriod(periodKeyFor(frequency, run), '2026-08-20');
      expect(periodKeyFor(frequency, new Date(`${day}T00:00:00.000Z`))).toBe(periodKeyFor(frequency, run));
    }
  });

  it('bills a new notice for the period its due date falls in, so an exemption ending before it is charged', () => {
    // Issued in November, due in December: an exemption ending 30 November no longer covers it.
    const day = issueBillingDay('MONTHLY', '2026-12-31', '2026-11-16');
    expect(day).toBe('2026-12-01');
    expect(isFeeExemptOn({ feeExemption: 'OTHER', feeExemptionValidUntil: '2026-11-30' }, day)).toBe(false);
    expect(issueBillingDay('ONCE', '2026-12-31', '2026-11-16')).toBe('2026-11-16');
    expect(issueBillingDay('MONTHLY', 'not a date', '2026-11-16')).toBe('2026-11-16');
  });
});

describe('setUnitFeeExemptionSchema', () => {
  it('asks a lift for its reason in words', () => {
    expect(setUnitFeeExemptionSchema.safeParse({ reason: null }).success).toBe(false);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: null, liftReason: '  ' }).success).toBe(false);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: null, liftReason: 'انتهى القرار' }).success).toBe(true);
  });

  it('takes a decision number and a last day as a calendar day', () => {
    expect(
      setUnitFeeExemptionSchema.safeParse({ reason: 'PUBLIC_FACILITY', decisionRef: '12/2026', validUntil: '2027-06-30' }).success,
    ).toBe(true);
    expect(setUnitFeeExemptionSchema.safeParse({ reason: 'PUBLIC_FACILITY', validUntil: '2027-02-30' }).success).toBe(false);
  });
});
