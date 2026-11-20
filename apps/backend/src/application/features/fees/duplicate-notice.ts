/**
 * When a notice being issued duplicates one already active (finding F11 of the
 * 2026-11-14 billing audit). The rule is `feeNoticeDuplicateSchema`'s in
 * shared-schemas; these are its pure parts, and `FeesService.duplicateNotices`
 * reads the register with them.
 *
 * The retry key protects one press of «إصدار». Two issuers, or one issuer in
 * two tabs, carry two keys, create two notices and raise two full sets of
 * bills. Nothing compares one notice with another, so this does: the same
 * basis, the same people, the same period. It is a warning the clerk confirms,
 * not a refusal: two fees can share a basis and a target (a cleaning fee and
 * a lighting fee, both flat, to everyone).
 */

/** Who a notice reaches, as far as telling two notices apart needs. */
export interface NoticeTarget {
  targetType: string;
  targetCitizenId?: string | null;
  /** Under BUILDING_CATEGORY, every category it names (`targetCategory` or the scope's list). */
  categories?: readonly string[];
}

/**
 * Whether two notices reach the same people. Of one target type only: a
 * notice to everyone and one to a category overlap, but the clerk who issues
 * both has chosen two different things, and the check is for the same thing
 * issued twice. Under BUILDING_CATEGORY one category in common is enough,
 * because its holders are billed by both.
 */
export function sameTarget(a: NoticeTarget, b: NoticeTarget): boolean {
  if (a.targetType !== b.targetType) return false;
  switch (a.targetType) {
    case 'INDIVIDUAL_CITIZEN':
      return Boolean(a.targetCitizenId) && a.targetCitizenId?.toLowerCase() === b.targetCitizenId?.toLowerCase();
    case 'BUILDING_CATEGORY':
      return (a.categories ?? []).some((category) => (b.categories ?? []).includes(category));
    default:
      return true;
  }
}

/**
 * A one-off notice's period, for this comparison: the month it is due in.
 *
 * Its bills all carry the period `ONCE`, so by period key every two one-off
 * notices with the same basis and target would duplicate each other for as
 * long as the first stays active — a fee raised in March would warn against
 * every one raised after it. The month is what two presses of the same notice
 * share.
 */
export function sameMonth(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

/** The duplicates the request has not confirmed, by id, in any case. */
export function unconfirmed<T extends { id: string }>(duplicates: readonly T[], acknowledged?: readonly string[]): T[] {
  const confirmed = new Set((acknowledged ?? []).map((id) => id.toLowerCase()));
  return duplicates.filter((duplicate) => !confirmed.has(duplicate.id.toLowerCase()));
}
