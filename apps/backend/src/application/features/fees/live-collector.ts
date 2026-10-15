import type { Prisma } from '../../../generated/tenant-client';
import { NotFoundError } from '../../common/exceptions';

/**
 * The collector named on a round payment must be someone who can be holding
 * the cash: staff, still active, not removed, and not view-only. Anyone else
 * would have a custody wallet opened in his name that nobody can hand in
 * (docs/finance.md §3.5).
 *
 * One rule for both ways a collector's money is recorded: the single counter
 * payment (`FeesService.settleInPerson`) and «تسديد الفواتير المحددة»
 * (`PaymentSettlementService.settle`), which named any user until the review
 * of PR #112.
 */
export async function assertLiveCollector(
  db: Pick<Prisma.TransactionClient, 'user'>,
  collectorId: string,
): Promise<void> {
  // `kind` in the WHERE, as on every read of `users`.
  const collector = await db.user.findFirst({
    where: { id: collectorId, kind: 'STAFF', isActive: true, deletedAt: null, role: { not: 'VIEWER' } },
    select: { id: true },
  });
  if (!collector) {
    throw new NotFoundError({
      code: 'COLLECTOR_NOT_FOUND',
      message: `Collector ${collectorId} is not active staff who can hold cash`,
    });
  }
}
