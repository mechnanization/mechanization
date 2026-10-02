import { settlePaymentSchema } from '@mechanization/shared-schemas';
import { creditOf, occurredAtFor, toTender } from './fees.service';

/*
  Cash in two currencies — «20$ و200,000 ليرة». The credit is worked out on
  the server from what was handed over, never taken from the client, so these
  pin the arithmetic and the refusals that keep a tender readable.
*/

describe('creditOf', () => {
  it('adds the dollars at the rate to the ليرة, in whole ليرة', () => {
    const tender = toTender({ local: 200_000, foreign: 20, foreignCurrency: 'USD', exchangeRate: 89_500 }, 'LBP');
    expect(creditOf(tender, 'LBP')).toBe(1_990_000);
  });

  it('rounds a fractional rate to the whole ليرة', () => {
    const tender = toTender({ local: 0, foreign: 1, foreignCurrency: 'USD', exchangeRate: 89_500.6 }, 'LBP');
    expect(creditOf(tender, 'LBP')).toBe(89_501);
  });

  it('is the ليرة alone when no dollars were handed over', () => {
    const tender = toTender({ local: 150_000, foreign: 0, foreignCurrency: 'USD' }, 'LBP');
    expect(tender).toEqual({ local: 150_000, foreign: null, foreignCurrency: null, exchangeRate: null });
    expect(creditOf(tender, 'LBP')).toBe(150_000);
  });
});

describe('toTender', () => {
  it('refuses dollars as the "foreign" part of a dollar invoice', () => {
    expect(() =>
      toTender({ local: 0, foreign: 10, foreignCurrency: 'USD', exchangeRate: 1 }, 'USD'),
    ).toThrow('الفاتورة بعملة USD');
  });

  it('refuses dollars with no rate', () => {
    expect(() => toTender({ local: 0, foreign: 10, foreignCurrency: 'USD' }, 'LBP')).toThrow('سعر الصرف');
  });
});

describe('settlePaymentSchema — tendered', () => {
  it('accepts both currencies with a rate', () => {
    const parsed = settlePaymentSchema.parse({
      method: 'CASH',
      tendered: { local: 200_000, foreign: 20, exchangeRate: 89_500 },
    });
    expect(parsed.tendered).toEqual({ local: 200_000, foreign: 20, foreignCurrency: 'USD', exchangeRate: 89_500 });
  });

  it('refuses a tender with nothing in it', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', tendered: { local: 0, foreign: 0 } }).success).toBe(false);
  });

  it('refuses dollars with no rate', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', tendered: { foreign: 20 } }).success).toBe(false);
  });

  it('refuses a tender alongside an amount — one figure, not two', () => {
    expect(
      settlePaymentSchema.safeParse({ method: 'CASH', amount: 100, tendered: { local: 100 } }).success,
    ).toBe(false);
  });

  it('refuses a tender on anything but cash', () => {
    expect(
      settlePaymentSchema.safeParse({
        method: 'WHISH_MONEY',
        whishTransactionRef: 'TX-1',
        tendered: { local: 100 },
      }).success,
    ).toBe(false);
  });
});

describe('the day the money was taken', () => {
  it('keeps the real time when no day is sent — a payment taken today', () => {
    expect(occurredAtFor(undefined)).toBeUndefined();
  });

  it('puts a back-dated payment at midday on its own day', () => {
    expect(occurredAtFor('2026-09-28')?.toISOString()).toBe('2026-09-28T12:00:00.000Z');
  });

  it("honours the day sent even when it is the server's UTC today — Lebanon after midnight", () => {
    // 01:30 on 3 Oct in Beirut is 22:30 on 2 Oct UTC: «yesterday» is the server's today.
    expect(occurredAtFor('2026-10-02')?.toISOString()).toBe('2026-10-02T12:00:00.000Z');
  });

  it('refuses a day in the future, or not a day at all', () => {
    // Two days ahead: one day of slack is allowed for the UTC+3 night.
    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: tomorrow }).success).toBe(false);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: '28/09/2026' }).success).toBe(false);
    // A day that does not exist, which Date would quietly roll over to 2 March.
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: '2026-02-30' }).success).toBe(false);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: '2026-09-28' }).success).toBe(true);
  });
});
