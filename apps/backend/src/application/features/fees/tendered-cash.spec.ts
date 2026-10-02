import { municipalToday, settlePaymentSchema } from '@mechanization/shared-schemas';
import { ForbiddenError, ValidationError } from '../../common/exceptions';
import { assertCashAdjustment, creditOf, occurredAtFor, officialRateFor, toTender } from './fees.service';

/*
  Cash at the counter — «20$ و200,000 ليرة». The credit is worked out on the
  server from what was handed over, at the municipality's own rate unless a
  finance role says otherwise, and a payment dated before today says why.
  These pin the arithmetic and the refusals that keep a cash entry auditable.
*/

const OFFICIAL = 89_500;

describe('creditOf', () => {
  it('adds the dollars at the rate to the ليرة, in whole ليرة', () => {
    const tender = toTender({ local: 200_000, foreign: 20, foreignCurrency: 'USD' }, 'LBP', OFFICIAL);
    expect(creditOf(tender, 'LBP')).toBe(1_990_000);
  });

  it('keeps the rate to four places and credits from the kept figure', () => {
    const tender = toTender({ local: 0, foreign: 1000, foreignCurrency: 'EUR', exchangeRate: 1.083456 }, 'USD', null);
    expect(tender.exchangeRate).toBe(1.0835);
    expect(creditOf(tender, 'USD')).toBe(1083.5);
  });

  it('is the ليرة alone when no dollars were handed over', () => {
    const tender = toTender({ local: 150_000, foreign: 0, foreignCurrency: 'USD' }, 'LBP', OFFICIAL);
    expect(tender).toEqual({
      local: 150_000,
      foreign: null,
      foreignCurrency: null,
      exchangeRate: null,
      officialExchangeRate: null,
    });
    expect(creditOf(tender, 'LBP')).toBe(150_000);
  });
});

describe('toTender', () => {
  it('takes the municipality’s rate when the request names none', () => {
    const tender = toTender({ local: 0, foreign: 10, foreignCurrency: 'USD' }, 'LBP', OFFICIAL);
    expect(tender).toMatchObject({ exchangeRate: OFFICIAL, officialExchangeRate: OFFICIAL });
  });

  it('refuses dollars as the "foreign" part of a dollar invoice', () => {
    expect(() => toTender({ local: 0, foreign: 10, foreignCurrency: 'USD', exchangeRate: 1 }, 'USD', null)).toThrow(
      'الفاتورة بعملة USD',
    );
  });

  it('refuses dollars when there is neither an official rate nor one typed', () => {
    expect(() => toTender({ local: 0, foreign: 10, foreignCurrency: 'USD' }, 'LBP', null)).toThrow('سعر صرف');
  });
});

describe('officialRateFor', () => {
  const settings = { baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: OFFICIAL };

  it('is the settings rate for dollars against a ليرة bill', () => {
    expect(officialRateFor(settings, 'LBP', 'USD')).toBe(OFFICIAL);
  });

  it('is null for any other pair, or when no rate is set', () => {
    expect(officialRateFor(settings, 'LBP', 'EUR')).toBeNull();
    expect(officialRateFor(settings, 'USD', 'USD')).toBeNull();
    expect(officialRateFor({ ...settings, exchangeRate: null }, 'LBP', 'USD')).toBeNull();
  });
});

describe('assertCashAdjustment — who may depart from the ordinary', () => {
  const today = '2026-10-02';
  const atOfficial = toTender({ local: 0, foreign: 10, foreignCurrency: 'USD' }, 'LBP', OFFICIAL);
  const overridden = toTender({ local: 0, foreign: 10, foreignCurrency: 'USD', exchangeRate: 200_000 }, 'LBP', OFFICIAL);

  it('lets a collector take dollars at the official rate, today, with no reason', () => {
    expect(assertCashAdjustment({ tender: atOfficial, paidOn: undefined, reason: undefined, role: 'COLLECTOR', today })).toEqual({
      required: false,
      rateOverridden: false,
      backdatedDays: 0,
    });
  });

  it('refuses a collector who types another rate — $10 must not settle 2,000,000', () => {
    expect(() =>
      assertCashAdjustment({ tender: overridden, paidOn: undefined, reason: 'سعر السوق', role: 'COLLECTOR', today }),
    ).toThrow(ForbiddenError);
  });

  it('lets an accountant override the rate only with a reason', () => {
    expect(() =>
      assertCashAdjustment({ tender: overridden, paidOn: undefined, reason: undefined, role: 'ACCOUNTANT', today }),
    ).toThrow(ValidationError);
    expect(
      assertCashAdjustment({ tender: overridden, paidOn: undefined, reason: 'قرار المجلس 12/2026', role: 'ACCOUNTANT', today }),
    ).toMatchObject({ required: true, rateOverridden: true });
  });

  it('treats any rate as an override when the municipality has set none', () => {
    const noOfficial = toTender({ local: 0, foreign: 10, foreignCurrency: 'USD', exchangeRate: 89_000 }, 'LBP', null);
    expect(() =>
      assertCashAdjustment({ tender: noOfficial, paidOn: undefined, reason: 'x'.repeat(10), role: 'COLLECTOR', today }),
    ).toThrow(ForbiddenError);
  });

  it('asks a reason for a payment dated before today, and a finance role beyond the window', () => {
    expect(() =>
      assertCashAdjustment({ tender: null, paidOn: '2026-09-30', reason: undefined, role: 'COLLECTOR', today }),
    ).toThrow(ValidationError);
    expect(
      assertCashAdjustment({ tender: null, paidOn: '2026-09-30', reason: 'جولة التحصيل', role: 'COLLECTOR', today }),
    ).toMatchObject({ required: true, backdatedDays: 2 });
    expect(() =>
      assertCashAdjustment({ tender: null, paidOn: '2026-07-01', reason: 'تصحيح', role: 'COLLECTOR', today }),
    ).toThrow(ForbiddenError);
    expect(
      assertCashAdjustment({ tender: null, paidOn: '2026-07-01', reason: 'تصحيح دفتر الإيصالات', role: 'SUPER_ADMIN', today }),
    ).toMatchObject({ backdatedDays: 93 });
  });
});

describe('settlePaymentSchema — tendered', () => {
  it('accepts both currencies, with or without a typed rate', () => {
    const parsed = settlePaymentSchema.parse({
      method: 'CASH',
      tendered: { local: 200_000, foreign: 20 },
    });
    expect(parsed.tendered).toEqual({ local: 200_000, foreign: 20, foreignCurrency: 'USD' });
  });

  it('refuses a tender with nothing in it', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', tendered: { local: 0, foreign: 0 } }).success).toBe(false);
  });

  it('refuses a figure the column cannot hold, as a validation error rather than a 500', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', tendered: { local: 1e12 } }).success).toBe(false);
  });

  it('refuses a tender alongside an amount — one figure, not two', () => {
    expect(settlePaymentSchema.safeParse({ method: 'CASH', amount: 100, tendered: { local: 100 } }).success).toBe(false);
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

  it('reads «today» on the Beirut calendar, not UTC', () => {
    // 01:30 on 3 Oct in Beirut is 22:30 on 2 Oct UTC.
    expect(municipalToday(new Date('2026-10-02T22:30:00.000Z'))).toBe('2026-10-03');
    expect(municipalToday(new Date('2026-10-02T10:00:00.000Z'))).toBe('2026-10-02');
  });

  it('refuses tomorrow on the Beirut calendar, or not a day at all', () => {
    const tomorrow = new Date(Date.parse(`${municipalToday()}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: tomorrow }).success).toBe(false);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: municipalToday() }).success).toBe(true);
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: '28/09/2026' }).success).toBe(false);
    // A day that does not exist, which Date would quietly roll over to 2 March.
    expect(settlePaymentSchema.safeParse({ method: 'CASH', paidOn: '2026-02-30' }).success).toBe(false);
  });
});
