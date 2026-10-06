import { creditsWallets, planPaymentLegs, planPreGoLiveRefund, roundMoney } from './treasury.plan';

const COLLECTOR_ID = '11111111-1111-4111-8111-111111111111';

const safe = (currency: string) => ({ kind: 'PRIMARY', type: 'CASH_SAFE', currency });
const whish = (currency: string) => ({ kind: 'PRIMARY', type: 'WHISH_ACCOUNT', currency });
const custody = (currency: string) => ({ kind: 'CUSTODY', ownerId: COLLECTOR_ID, currency });

describe('creditsWallets', () => {
  const goLive = new Date('2026-10-01T09:00:00.000Z');

  it('credits nothing while the treasury is not active', () => {
    expect(creditsWallets(null, new Date('2026-10-02T09:00:00.000Z'))).toBe(false);
  });

  it('credits a payment taken at or after the go-live moment', () => {
    expect(creditsWallets(goLive, goLive)).toBe(true);
    expect(creditsWallets(goLive, new Date('2026-10-01T09:00:00.001Z'))).toBe(true);
  });

  it('does not credit a payment taken before it — that cash is in the opening balance', () => {
    expect(creditsWallets(goLive, new Date('2026-10-01T08:59:59.999Z'))).toBe(false);
  });
});

describe('planPaymentLegs', () => {
  it('puts counter cash into the safe of the invoice currency', () => {
    const { legs } = planPaymentLegs({
      method: 'CASH', invoiceCurrency: 'LBP', amount: 100_000, changeGiven: 0, collectedById: null,
    });
    expect(legs).toEqual([{ target: safe('LBP'), amount: 100_000 }]);
  });

  it('puts a dollar payment into the dollar safe', () => {
    const { legs } = planPaymentLegs({
      method: 'CASH', invoiceCurrency: 'USD', amount: 25.5, changeGiven: 0, collectedById: null,
    });
    expect(legs).toEqual([{ target: safe('USD'), amount: 25.5 }]);
  });

  it('puts a confirmed Whish payment into the Whish account of that currency', () => {
    const { legs } = planPaymentLegs({
      method: 'WHISH_MONEY', invoiceCurrency: 'USD', amount: 50, changeGiven: 0, collectedById: null,
    });
    expect(legs).toEqual([{ target: whish('USD'), amount: 50 }]);
  });

  it("puts a collector's cash into his custody, not the safe", () => {
    const { legs, collectorUnknown } = planPaymentLegs({
      method: 'COLLECTOR', invoiceCurrency: 'LBP', amount: 300_000, changeGiven: 0, collectedById: COLLECTOR_ID,
    });
    expect(legs).toEqual([{ target: custody('LBP'), amount: 300_000 }]);
    expect(collectorUnknown).toBe(false);
  });

  it('falls back to the safe, and says so, when a collector payment names no collector', () => {
    const { legs, collectorUnknown } = planPaymentLegs({
      method: 'COLLECTOR', invoiceCurrency: 'LBP', amount: 300_000, changeGiven: 0, collectedById: null,
    });
    expect(legs).toEqual([{ target: safe('LBP'), amount: 300_000 }]);
    expect(collectorUnknown).toBe(true);
  });

  describe('a tender — the notes that actually changed hands', () => {
    it('a $20 note against a 1,500,000 ل.ل bill: +$20 in, the change out of the ليرة safe', () => {
      const { legs } = planPaymentLegs({
        method: 'CASH',
        invoiceCurrency: 'LBP',
        amount: 1_790_000,
        tendered: { local: 0, foreign: 20, foreignCurrency: 'USD' },
        changeGiven: 290_000,
        collectedById: null,
      });
      expect(legs).toEqual(
        expect.arrayContaining([
          { target: safe('USD'), amount: 20 },
          { target: safe('LBP'), amount: -290_000 },
        ]),
      );
      expect(legs).toHaveLength(2);
    });

    it('never books the invoice amount itself as if ليرة had arrived', () => {
      const { legs } = planPaymentLegs({
        method: 'CASH',
        invoiceCurrency: 'LBP',
        amount: 1_790_000,
        tendered: { local: 0, foreign: 20, foreignCurrency: 'USD' },
        changeGiven: 290_000,
        collectedById: null,
      });
      const lbp = legs.filter((leg) => leg.target.currency === 'LBP').reduce((sum, leg) => sum + leg.amount, 0);
      expect(lbp).toBeLessThan(0);
    });

    it('nets ليرة notes and ليرة change into one leg', () => {
      const { legs } = planPaymentLegs({
        method: 'CASH',
        invoiceCurrency: 'LBP',
        amount: 1_000_000,
        tendered: { local: 500_000, foreign: 10, foreignCurrency: 'USD' },
        changeGiven: 100_000,
        collectedById: null,
      });
      expect(legs).toEqual(
        expect.arrayContaining([
          { target: safe('LBP'), amount: 400_000 },
          { target: safe('USD'), amount: 10 },
        ]),
      );
    });

    it('drops a leg that nets to zero', () => {
      const { legs } = planPaymentLegs({
        method: 'CASH',
        invoiceCurrency: 'LBP',
        amount: 90_000,
        tendered: { local: 90_000, foreign: null, foreignCurrency: null },
        changeGiven: 90_000,
        collectedById: null,
      });
      expect(legs).toEqual([]);
    });

    it("sends a collector's foreign notes to his custody in that currency", () => {
      const { legs } = planPaymentLegs({
        method: 'COLLECTOR',
        invoiceCurrency: 'LBP',
        amount: 895_000,
        tendered: { local: 0, foreign: 10, foreignCurrency: 'USD' },
        changeGiven: 0,
        collectedById: COLLECTOR_ID,
      });
      expect(legs).toEqual([{ target: custody('USD'), amount: 10 }]);
    });

    it('a dollar bill paid in dollars with ليرة notes: ليرة notes go to the ليرة safe', () => {
      const { legs } = planPaymentLegs({
        method: 'CASH',
        invoiceCurrency: 'USD',
        amount: 20,
        tendered: { local: 10, foreign: 895_000, foreignCurrency: 'LBP' },
        changeGiven: 0,
        collectedById: null,
      });
      expect(legs).toEqual(
        expect.arrayContaining([
          { target: safe('USD'), amount: 10 },
          { target: safe('LBP'), amount: 895_000 },
        ]),
      );
    });
  });
});

describe('planPreGoLiveRefund', () => {
  it('takes a cash refund out of the safe of the invoice currency', () => {
    expect(planPreGoLiveRefund({ method: 'CASH', invoiceCurrency: 'LBP', amount: 100_000 })).toEqual([
      { target: safe('LBP'), amount: -100_000 },
    ]);
  });

  it('takes a Whish refund out of the Whish account', () => {
    expect(planPreGoLiveRefund({ method: 'WHISH_MONEY', invoiceCurrency: 'USD', amount: 40 })).toEqual([
      { target: whish('USD'), amount: -40 },
    ]);
  });

  it("takes a collector payment's refund out of the safe: his cash was handed in before the count", () => {
    expect(planPreGoLiveRefund({ method: 'COLLECTOR', invoiceCurrency: 'LBP', amount: 50_000 })).toEqual([
      { target: safe('LBP'), amount: -50_000 },
    ]);
  });
});

describe('roundMoney', () => {
  it('rounds ليرة to whole pounds and dollars to cents', () => {
    expect(roundMoney(1_234.6, 'LBP')).toBe(1_235);
    expect(roundMoney(10.005, 'USD')).toBe(10.01);
    expect(roundMoney(0.1 + 0.2, 'USD')).toBe(0.3);
  });
});
