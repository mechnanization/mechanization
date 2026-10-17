import { describe, expect, it } from 'vitest';
import { activateTreasurySchema } from '@mechanization/shared-schemas';
import { parseOpeningAmount } from './treasury-input';

describe('parseOpeningAmount', () => {
  it('treats an empty box as not counted, and a typed zero as a real count', () => {
    expect(parseOpeningAmount('')).toEqual({ ok: false, reason: 'required' });
    expect(parseOpeningAmount('  ')).toEqual({ ok: false, reason: 'required' });
    expect(parseOpeningAmount('0')).toEqual({ ok: true, value: 0 });
  });

  it('reads grouped and Arabic-Indic digits', () => {
    expect(parseOpeningAmount('1,250,000')).toEqual({ ok: true, value: 1_250_000 });
    expect(parseOpeningAmount('١٢٣٫٥')).toEqual({ ok: true, value: 123.5 });
  });

  it('refuses what is not a plain non-negative number', () => {
    expect(parseOpeningAmount('abc')).toEqual({ ok: false, reason: 'notNumber' });
    expect(parseOpeningAmount('-5')).toEqual({ ok: false, reason: 'notNumber' });
    expect(parseOpeningAmount('1.2.3')).toEqual({ ok: false, reason: 'notNumber' });
  });

  it('refuses a third decimal and an enormous figure, as the shared schema does', () => {
    expect(parseOpeningAmount('1.234')).toEqual({ ok: false, reason: 'decimals' });
    expect(parseOpeningAmount('1000000000000')).toEqual({ ok: false, reason: 'tooLarge' });
  });

  it('agrees with activateTreasurySchema on every value it accepts', () => {
    const accountId = '3f2b8c1e-6d4a-4b7e-9a10-2c5d7e8f9a01';
    for (const raw of ['0', '12', '12.5', '12.50', '999999999999']) {
      const parsed = parseOpeningAmount(raw);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(activateTreasurySchema.safeParse({ balances: [{ accountId, amount: parsed.value }] }).success).toBe(true);
    }
  });
});
