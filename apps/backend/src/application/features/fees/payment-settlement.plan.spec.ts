import {
  bulkSettlementOrder,
  bulkSettlePaymentsSchema,
  planBulkSettlement,
  type BulkBill,
  type BulkPlan,
} from '@mechanization/shared-schemas';
import { propertiesOf } from './payment-settlement.service';

/*
  The rule that spreads one press's money over several bills
  (`planBulkSettlement`, shared by the dialog and the server). Tested here, next
  to its main consumer, because the shared package has no runner of its own.
*/

const RATE = 89_500;

function bill(id: string, currency: string, outstanding: number, dueDate: string, createdAt = dueDate): BulkBill {
  return { id, currency, outstanding, dueDate, createdAt };
}

function planned(result: ReturnType<typeof planBulkSettlement>): BulkPlan {
  if (!result.ok) throw new Error(`expected a plan, got ${result.refusal.code}`);
  return result.plan;
}

/**
 * What the rows move through the wallets in the municipality's currency, as
 * `planPaymentLegs` would post them: a plain row its amount, a row with notes
 * its local notes less its change. Must equal the ليرة handed in less the change
 * handed back — the drawer count.
 */
function baseNet(plan: BulkPlan, base = 'LBP'): number {
  return plan.rows
    .filter((row) => row.currency === base)
    .reduce((sum, row) => sum + (row.tender ? row.tender.local - row.changeGiven : row.amount), 0);
}

describe('planBulkSettlement', () => {
  it('pays every bill its balance, with no notes and no change, on a Whish or collector settlement', () => {
    for (const method of ['WHISH_MONEY', 'COLLECTOR'] as const) {
      const plan = planned(
        planBulkSettlement({
          bills: [bill('b', 'LBP', 500_000, '2026-02-01'), bill('a', 'USD', 40, '2026-01-01')],
          method,
          baseCurrency: 'LBP',
          exchangeRate: RATE,
        }),
      );
      expect(plan.rows).toEqual([
        { paymentId: 'a', currency: 'USD', amount: 40, tender: null, changeGiven: 0 },
        { paymentId: 'b', currency: 'LBP', amount: 500_000, tender: null, changeGiven: 0 },
      ]);
      expect(plan.change).toBe(0);
      expect(plan.due).toEqual({ LBP: 500_000, USD: 40 });
    }
  });

  it('takes exact ليرة as plain sums, handing nothing back', () => {
    const plan = planned(
      planBulkSettlement({
        bills: [bill('a', 'LBP', 900_000, '2026-01-01'), bill('b', 'LBP', 900_000, '2026-02-01')],
        method: 'CASH',
        tender: { local: 1_800_000, foreign: 0, foreignCurrency: 'USD' },
        baseCurrency: 'LBP',
        exchangeRate: RATE,
      }),
    );
    expect(plan.rows.every((row) => row.tender === null && row.changeGiven === 0)).toBe(true);
    expect(plan.change).toBe(0);
    expect(plan.exchangeRate).toBeNull();
  });

  it('refuses ليرة that do not cover the bills, naming the shortfall', () => {
    const result = planBulkSettlement({
      bills: [bill('a', 'LBP', 900_000, '2026-01-01'), bill('b', 'LBP', 900_000, '2026-02-01')],
      method: 'CASH',
      tender: { local: 1_500_000, foreign: 0, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: RATE,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'BULK_SETTLE_TENDER_SHORT', params: { shortBy: 300_000, currency: 'LBP' } },
    });
  });

  it('refuses ليرة above what the ليرة bills owe: change comes only from a foreign note', () => {
    const result = planBulkSettlement({
      bills: [bill('a', 'LBP', 900_000, '2026-01-01')],
      method: 'CASH',
      tender: { local: 1_000_000, foreign: 0, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: RATE,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'BULK_SETTLE_TENDER_EXCEEDS', params: { amount: 1_000_000, due: 900_000, currency: 'LBP' } },
    });
  });

  it('keeps every bill whole when one $20 note pays two ليرة bills exactly — the split a cent cannot make', () => {
    // $10.06 + $9.94 would leave the second bill 370 ل.ل short; the note is never split.
    const plan = planned(
      planBulkSettlement({
        bills: [bill('old', 'LBP', 900_000, '2026-01-01'), bill('new', 'LBP', 890_000, '2026-02-01')],
        method: 'CASH',
        tender: { local: 0, foreign: 20, foreignCurrency: 'USD' },
        baseCurrency: 'LBP',
        exchangeRate: RATE,
      }),
    );
    expect(plan.rows).toEqual([
      { paymentId: 'old', currency: 'LBP', amount: 900_000, tender: null, changeGiven: 0 },
      {
        paymentId: 'new',
        currency: 'LBP',
        amount: 1_790_000,
        tender: { local: 0, foreign: 20, foreignCurrency: 'USD' },
        // The newest bill's change pays the older one across the counter.
        changeGiven: 900_000,
      },
    ]);
    expect(plan.change).toBe(0);
    expect(baseNet(plan)).toBe(0);
  });

  it('pays dollar bills with dollars and the rest of the dollars against the ليرة, with change in ليرة', () => {
    const plan = planned(
      planBulkSettlement({
        bills: [
          bill('lbp-old', 'LBP', 1_000_000, '2026-01-01'),
          bill('usd', 'USD', 40, '2026-01-15'),
          bill('lbp-new', 'LBP', 500_000, '2026-02-01'),
        ],
        method: 'CASH',
        tender: { local: 1_200_000, foreign: 50, foreignCurrency: 'USD' },
        baseCurrency: 'LBP',
        exchangeRate: RATE,
      }),
    );
    expect(plan.rows.map((row) => row.paymentId)).toEqual(['lbp-old', 'usd', 'lbp-new']);
    expect(plan.rows[1]).toEqual({ paymentId: 'usd', currency: 'USD', amount: 40, tender: null, changeGiven: 0 });
    // $10 left over is 895,000 ل.ل: 1,200,000 + 895,000 − 1,500,000 = 595,000 back.
    expect(plan.rows[2]).toEqual({
      paymentId: 'lbp-new',
      currency: 'LBP',
      amount: 1_095_000,
      tender: { local: 200_000, foreign: 10, foreignCurrency: 'USD' },
      changeGiven: 595_000,
    });
    expect(plan.change).toBe(595_000);
    expect(plan.exchangeRate).toBe(RATE);
    expect(baseNet(plan)).toBe(1_200_000 - 595_000);
  });

  it('moves the drawer by exactly the ليرة handed in less the change, whatever the mix', () => {
    const bills = [
      bill('a', 'LBP', 350_000, '2026-01-01'),
      bill('b', 'LBP', 1_250_000, '2026-02-01'),
      bill('c', 'LBP', 600_000, '2026-03-01'),
    ];
    for (const [local, foreign] of [
      [0, 30],
      [100_000, 25],
      [2_200_000, 0],
      [1_600_000, 10],
      [2_000_000, 5],
    ] as const) {
      const plan = planned(
        planBulkSettlement({
          bills,
          method: 'CASH',
          tender: { local, foreign, foreignCurrency: 'USD' },
          baseCurrency: 'LBP',
          exchangeRate: RATE,
        }),
      );
      expect(baseNet(plan)).toBe(local - plan.change);
      expect(plan.change).toBe(Math.round(local + foreign * RATE - 2_200_000));
    }
  });

  it('refuses too few dollars for the dollar bills, even with ليرة to spare', () => {
    const result = planBulkSettlement({
      bills: [bill('usd', 'USD', 40, '2026-01-01'), bill('lbp', 'LBP', 100_000, '2026-01-02')],
      method: 'CASH',
      tender: { local: 100_000, foreign: 30, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: RATE,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'BULK_SETTLE_TENDER_SHORT', params: { shortBy: 10, currency: 'USD' } },
    });
  });

  it('refuses dollars above the dollar bills when no ليرة bill can take the change', () => {
    const result = planBulkSettlement({
      bills: [bill('usd', 'USD', 40, '2026-01-01')],
      method: 'CASH',
      tender: { local: 0, foreign: 50, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: RATE,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'BULK_SETTLE_TENDER_EXCEEDS', params: { amount: 50, due: 40, currency: 'USD' } },
    });
  });

  it('refuses dollars against ليرة bills when no official rate is set', () => {
    const result = planBulkSettlement({
      bills: [bill('lbp', 'LBP', 100_000, '2026-01-01')],
      method: 'CASH',
      tender: { local: 0, foreign: 5, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: null,
    });
    expect(result).toEqual({ ok: false, refusal: { code: 'BULK_SETTLE_RATE_NOT_SET' } });
  });

  it('needs no rate when the dollars pay only dollar bills', () => {
    const plan = planned(
      planBulkSettlement({
        bills: [bill('usd', 'USD', 40, '2026-01-01'), bill('lbp', 'LBP', 100_000, '2026-01-02')],
        method: 'CASH',
        tender: { local: 100_000, foreign: 40, foreignCurrency: 'USD' },
        baseCurrency: 'LBP',
        exchangeRate: null,
      }),
    );
    expect(plan.change).toBe(0);
    expect(plan.exchangeRate).toBeNull();
  });

  it('refuses a bill in a currency neither kind of note can pay', () => {
    const result = planBulkSettlement({
      bills: [bill('eur', 'EUR', 10, '2026-01-01')],
      method: 'CASH',
      tender: { local: 0, foreign: 10, foreignCurrency: 'USD' },
      baseCurrency: 'LBP',
      exchangeRate: RATE,
    });
    expect(result).toEqual({
      ok: false,
      refusal: { code: 'BULK_SETTLE_CURRENCY_UNSUPPORTED', params: { currency: 'EUR' } },
    });
  });

  it('takes the rate to four places, as the ledger keeps it', () => {
    const plan = planned(
      planBulkSettlement({
        bills: [bill('lbp', 'LBP', 100_000, '2026-01-01')],
        method: 'CASH',
        tender: { local: 0, foreign: 2, foreignCurrency: 'USD' },
        baseCurrency: 'LBP',
        exchangeRate: 89_500.123456,
      }),
    );
    expect(plan.exchangeRate).toBe(89_500.1235);
    expect(plan.rows[0]!.amount).toBe(Math.round(2 * 89_500.1235));
  });
});

describe('bulkSettlementOrder', () => {
  it('puts the oldest bill first: by due date, then by when it was raised, then by id', () => {
    const order = bulkSettlementOrder([
      bill('c', 'LBP', 1, '2026-03-01'),
      bill('b2', 'LBP', 1, '2026-01-01', '2026-01-05'),
      bill('b1', 'LBP', 1, '2026-01-01', '2026-01-02'),
      bill('a', 'LBP', 1, '2026-01-01', '2026-01-05'),
    ]).map((entry) => entry.id);
    expect(order).toEqual(['b1', 'a', 'b2', 'c']);
  });
});

describe('bulkSettlePaymentsSchema', () => {
  const base = {
    citizenId: '00000000-0000-4000-8000-000000000001',
    paymentIds: ['00000000-0000-4000-8000-000000000002'],
    clientRequestId: '00000000-0000-4000-8000-000000000003',
  };

  it('asks a cash settlement for the notes and refuses them on the other methods', () => {
    expect(bulkSettlePaymentsSchema.safeParse({ ...base, method: 'CASH' }).success).toBe(false);
    expect(
      bulkSettlePaymentsSchema.safeParse({ ...base, method: 'CASH', tendered: { local: 1000 } }).success,
    ).toBe(true);
    expect(
      bulkSettlePaymentsSchema.safeParse({
        ...base,
        method: 'WHISH_MONEY',
        whishTransactionRef: 'WH-12345',
        tendered: { local: 1000 },
      }).success,
    ).toBe(false);
  });

  it('asks each method for its one auditable fact, and only that method', () => {
    expect(bulkSettlePaymentsSchema.safeParse({ ...base, method: 'COLLECTOR' }).success).toBe(false);
    expect(bulkSettlePaymentsSchema.safeParse({ ...base, method: 'WHISH_MONEY' }).success).toBe(false);
    expect(
      bulkSettlePaymentsSchema.safeParse({
        ...base,
        method: 'CASH',
        tendered: { local: 1000 },
        collectedById: base.citizenId,
      }).success,
    ).toBe(false);
  });

  it('refuses the same bill twice, an empty list and more than fifty', () => {
    const id = base.paymentIds[0]!;
    const cash = { ...base, method: 'CASH', tendered: { local: 1000 } };
    expect(bulkSettlePaymentsSchema.safeParse({ ...cash, paymentIds: [id, id] }).success).toBe(false);
    expect(bulkSettlePaymentsSchema.safeParse({ ...cash, paymentIds: [] }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect(bulkSettlePaymentsSchema.safeParse({ ...cash, paymentIds: many }).success).toBe(false);
  });
});

describe('propertiesOf', () => {
  it('lists each parcel and unit once, and nothing for a flat charge', () => {
    expect(propertiesOf(null)).toEqual([]);
    const line = { propertyNumber: '123', propertyType: 'BUILDING', unitType: 'APARTMENT', unitArea: 120, unitCode: 'A-2' };
    expect(
      propertiesOf({
        basis: 'PER_UNIT',
        rate: 1,
        unitCount: 2,
        totalArea: 240,
        excludedUnitCount: 0,
        heldUnitCount: 0,
        uninhabitableUnitCount: 0,
        sharedUnitCount: 0,
        coOwnerPaidUnitCount: 0,
        exemptUnitCount: 0,
        lines: [line, line, { ...line, unitCode: 'A-3' }],
      } as never),
    ).toEqual([
      { propertyNumber: '123', unitType: 'APARTMENT', unitCode: 'A-2' },
      { propertyNumber: '123', unitType: 'APARTMENT', unitCode: 'A-3' },
    ]);
  });
});
