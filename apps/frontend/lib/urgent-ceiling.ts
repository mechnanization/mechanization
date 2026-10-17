import { formatTypedAmount, parseAmount } from './currency';

/**
 * «سقف الدفع العاجل» on the settings page: the manager's per-voucher limit on
 * the accountant's art. 35 path, per currency (D6, docs/finance.md §5.1).
 */

/** The largest ceiling the DECIMAL(14,2) column holds, as `systemSettingsSchema` caps it. */
export const CEILING_MAX = 999_999_999_999;

/** A ceiling as stored → as the field shows it: grouped, `''` for none. */
export function ceilingDraft(value: number | null | undefined, decimals: 0 | 2): string {
  return value == null ? '' : formatTypedAmount(String(value), decimals);
}

/**
 * A ceiling as typed → as the server takes it: `null` for an empty field (no
 * ceiling), `undefined` for one that is not a valid ceiling (zero, or too big).
 */
export function ceilingValue(raw: string): number | null | undefined {
  if (!raw.trim()) return null;
  const value = parseAmount(raw);
  return value > 0 && value <= CEILING_MAX ? value : undefined;
}

/**
 * What a save sends for one ceiling field, against what the field showed when
 * the settings were read (`saved`; `undefined` if they never were):
 *
 * - `unchanged`: the field is as it was read, so nothing is sent and the stored
 *   ceiling stays exactly as stored. The field shows the stored value rounded
 *   to the currency's digits (`ceilingDraft`), so sending it back would round a
 *   fractional ceiling on a save that was about something else;
 * - `set`: the manager changed it, to a figure or to empty («بلا سقف», `null`);
 * - `invalid`: changed to something that is not a ceiling.
 */
export type CeilingChange = { kind: 'unchanged' } | { kind: 'set'; value: number | null } | { kind: 'invalid' };

export function ceilingChange(typed: string, saved: string | undefined): CeilingChange {
  if (saved !== undefined && typed === saved) return { kind: 'unchanged' };
  const value = ceilingValue(typed);
  return value === undefined ? { kind: 'invalid' } : { kind: 'set', value };
}

/** The value for the request body: `undefined` leaves the stored ceiling alone. */
export function ceilingToSend(change: CeilingChange): number | null | undefined {
  return change.kind === 'set' ? change.value : undefined;
}
