import { CITIZEN_SETTINGS_FIELDS } from '@mechanization/shared-schemas';
import { FeesController } from './fees.controller';

/**
 * `GET fees/settings` is readable by a citizen — the portal prints the Whish
 * number and the cash office's address and hours — and gives him that and
 * nothing else (task S13 of the 2026-11-14 security audit, N-6). An
 * allowlist: the route used to strip a list, so the treasury's ceilings and
 * exchange rule were named one by one (PR #111 review, 2026-10-10) and every
 * field added since reached the portal by default. Staff read all of it.
 */
describe('FeesController.getSettings', () => {
  const settings = {
    whishMoneyNumber: '70123456',
    cashOfficeHours: '8–14',
    cashOfficeAddress: 'مبنى البلدية، الطابق الأرضي',
    urgentExpenseCeilingLbp: 5_000_000,
    urgentExpenseCeilingUsd: 100,
    exchangeRateTolerancePercent: 3,
    largeExchangeThreshold: 1000,
    // Never named by the old strip list, so they reached the portal.
    councilDecisionRef: 'قرار المجلس البلدي رقم 12/2026',
    levelFactors: { 2: 1.5 },
    numberingSequences: null,
    backupSchedule: { frequency: 'daily', keepCopies: 7 },
    // Any field added after this test: the allowlist keeps it off the portal too.
    aFieldAddedLater: 'secret',
  };
  const controller = new FeesController(
    { getSettings: jest.fn().mockResolvedValue(settings) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('gives a citizen how to pay, and only that', async () => {
    const forCitizen = await controller.getSettings({ sub: 'citizen-1' } as never);
    expect(forCitizen).toEqual({
      whishMoneyNumber: '70123456',
      cashOfficeHours: '8–14',
      cashOfficeAddress: 'مبنى البلدية، الطابق الأرضي',
    });
    expect(Object.keys(forCitizen).sort()).toEqual([...CITIZEN_SETTINGS_FIELDS].sort());
  });

  it('gives staff the whole record', async () => {
    await expect(controller.getSettings({ sub: 'staff-1', role: 'ACCOUNTANT' } as never)).resolves.toEqual(settings);
  });
});
