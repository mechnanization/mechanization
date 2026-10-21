import { toLatinDigits } from './currency';

/**
 * A counted opening balance as typed, read for the activation form.
 *
 * `parseAmount` cannot do this job: it answers 0 for «nothing typed» and for
 * «0» alike, and an opening balance of zero is a real count where an empty
 * box is a wallet nobody has counted yet. The reasons are keys the screen
 * turns into its own words; the limits mirror `activateTreasurySchema`.
 */
export type OpeningAmountResult =
  | { ok: true; value: number }
  | { ok: false; reason: 'required' | 'notNumber' | 'decimals' | 'tooLarge' };

const MAX_OPENING_AMOUNT = 999_999_999_999;

export function parseOpeningAmount(raw: string): OpeningAmountResult {
  const cleaned = toLatinDigits(raw).replace(/[,،٬\s]/g, '').replace('٫', '.');
  if (cleaned === '') return { ok: false, reason: 'required' };
  if (!/^\d+(\.\d*)?$/.test(cleaned)) return { ok: false, reason: 'notNumber' };
  const fraction = cleaned.split('.')[1] ?? '';
  if (fraction.length > 2) return { ok: false, reason: 'decimals' };
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return { ok: false, reason: 'notNumber' };
  if (value > MAX_OPENING_AMOUNT) return { ok: false, reason: 'tooLarge' };
  return { ok: true, value };
}
