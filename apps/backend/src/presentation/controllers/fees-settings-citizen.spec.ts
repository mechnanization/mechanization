import { FeesController } from './fees.controller';

/**
 * `GET fees/settings` is readable by a citizen — the portal prints the Whish
 * number and the office hours — but the limits the treasury sets on its own
 * staff are not his to read: the urgent-payment ceilings (D6) and, since 0084,
 * the exchange rule that decides which exchanges an auditor reviews (PR #111
 * review, 2026-10-10). Staff read all of it.
 */
describe('FeesController.getSettings', () => {
  const settings = {
    whishMoneyNumber: '70123456',
    cashOfficeHours: '8–14',
    urgentExpenseCeilingLbp: 5_000_000,
    urgentExpenseCeilingUsd: 100,
    exchangeRateTolerancePercent: 3,
    largeExchangeThreshold: 1000,
  };
  const controller = new FeesController(
    { getSettings: jest.fn().mockResolvedValue(settings) } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('gives a citizen how to pay, and none of the treasury’s own limits', async () => {
    const forCitizen = await controller.getSettings({ sub: 'citizen-1' } as never);
    expect(forCitizen).toEqual({ whishMoneyNumber: '70123456', cashOfficeHours: '8–14' });
  });

  it('gives staff the whole record', async () => {
    await expect(controller.getSettings({ sub: 'staff-1', role: 'ACCOUNTANT' } as never)).resolves.toEqual(settings);
  });
});
