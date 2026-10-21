import type { TreasuryMovement, TreasuryMovementDirection } from '@mechanization/shared-schemas';
import { municipalToday } from '@mechanization/shared-schemas';
import { REGISTER_PERIODS, registerPeriodRange } from './register-period';

/**
 * The pure half of «الحركات المالية» (`/finance/transactions`): what the
 * list's URL means and how a line reads. Kept free of React so the rules are
 * tested without a browser (`treasury-movements.test.ts`).
 */

/**
 * The periods the register is read by: the four questions a money register is
 * opened with, «كل الفترات», or a range of the reader's own (`from`, `to`).
 *
 * «هذا الشهر» is the default: "what came in and went out this month" is the
 * question the list is opened with most. A voucher from an earlier month is one
 * choice away in the filter bar, and the empty state offers every period when a
 * search finds nothing in the month.
 */
export const MOVEMENT_PERIODS = [...REGISTER_PERIODS, 'all', 'custom'] as const;
export type MovementPeriod = (typeof MOVEMENT_PERIODS)[number];
export const DEFAULT_MOVEMENT_PERIOD: MovementPeriod = 'thisMonth';

/** The register's direction filter, as the URL spells it. */
export const MOVEMENT_DIRECTIONS = ['all', 'in', 'out'] as const;
export type MovementDirectionParam = (typeof MOVEMENT_DIRECTIONS)[number];

/** The two acts, as the URLs spell them: the recording page's `?dir=`, the open voucher's `?kind=`. */
export const COMPOSER_DIRECTIONS = ['in', 'out'] as const;
export type ComposerDirection = (typeof COMPOSER_DIRECTIONS)[number];

/**
 * What the composer keeps when the clerk switches between «قبض» and «صرف»
 * halfway through: the figure, the wallet, the other party and the wording
 * survive the switch, so choosing the direction second costs nothing. The
 * fields only one side has (a category, a reason to pay urgently) do not.
 */
export interface MovementDraft {
  amount: string;
  accountId: string;
  party: string;
  description: string;
}

export const EMPTY_DRAFT: MovementDraft = { amount: '', accountId: '', party: '', description: '' };

/** `in` / `out` to the API's `IN` / `OUT`; `all` is no filter. */
export function apiDirection(direction: MovementDirectionParam): TreasuryMovementDirection | undefined {
  if (direction === 'in') return 'IN';
  if (direction === 'out') return 'OUT';
  return undefined;
}

/**
 * The two days a period covers, both inclusive, on the municipality's
 * calendar. `all` is no bound at all; `custom` is whatever the reader picked,
 * either end left open.
 */
export function movementRange(
  period: MovementPeriod,
  custom: { from: string; to: string },
  today: string = municipalToday(),
): { from?: string; to?: string } {
  if (period === 'all') return {};
  if (period === 'custom') return { from: custom.from || undefined, to: custom.to || undefined };
  return registerPeriodRange(period, today);
}

/** A line's identity. The two voucher tables are separate id spaces, so the direction is part of it. */
export function movementKey(movement: Pick<TreasuryMovement, 'direction'> & { voucher: { id: string } }): string {
  return `${movement.direction}:${movement.voucher.id}`;
}

/** Who paid it in, or who it was paid to; null for an income voucher with no payer written. */
export function movementParty(movement: TreasuryMovement): string | null {
  return movement.direction === 'IN' ? movement.voucher.payerName : movement.voucher.payee;
}

/** The category's name as this page reads it: an income category is bilingual, an expense band is not. */
export function movementCategory(movement: TreasuryMovement, locale: string): string {
  if (movement.direction === 'OUT') return movement.voucher.category.name;
  const { labelAr, labelEn } = movement.voucher.category;
  return locale === 'en' && labelEn ? labelEn : labelAr;
}

/** An urgent payment made before the head's order (art. 35) and not yet regularised. */
export function isAwaitingOrder(movement: TreasuryMovement): boolean {
  return (
    movement.direction === 'OUT' &&
    movement.voucher.status === 'RECORDED' &&
    movement.voucher.orderStatus === 'AWAITING_ORDER'
  );
}
