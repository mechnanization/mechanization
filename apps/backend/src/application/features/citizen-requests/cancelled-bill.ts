import type { Prisma } from '../../../generated/tenant-client';
import type { AuditService } from '../audit/audit.service';

/**
 * Cancels the request waiting on a bill that is now CANCELLED («إلغاء الفاتورة»,
 * finance audit B3), in the caller's transaction — the owner's decision of
 * 2026-10-13. Without it the request could be neither paid (a cancelled bill
 * takes no payment) nor rejected or cancelled (both are refused while a bill is
 * open, `REQUEST_BILL_OPEN`), and it held `citizen_requests_one_open_key` for
 * ever, so the citizen could never file that request again.
 *
 * Two callers, both after the bill is CANCELLED — `citizen_requests_guard`
 * (0094) accepts a cancelled request with a bill only once that bill is:
 * - `FeesService.cancelBill`, behind its row lock on the bill, with the manager
 *   as the actor;
 * - `CitizenRequestsService.reconcile`, with no actor (a SYSTEM row): it heals a
 *   request the first caller could not reach, and any already stranded.
 *
 * A request still AWAITING_PAYMENT is cancelled. One IN_REVIEW is too: a bill
 * with money on it is never cancelled, so its payment was reversed and the
 * reversal's reconcile was lost (it runs after the commit, and a failure there
 * is only logged). The guard has no IN_REVIEW → CANCELLED step, so it takes the
 * step that reconcile missed first — back to AWAITING_PAYMENT, `paidAt` cleared,
 * with the row that reconcile would have written — and then cancels. Before
 * this, the next read moved such a request to AWAITING_PAYMENT on the cancelled
 * bill, where nothing could reach it (review of PR #122).
 *
 * Returns the request it cancelled, or null when the bill was no open request's
 * fee.
 */
export async function cancelRequestOfCancelledBill(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'recordInTransaction'>,
  input: { billId: string; actor: { id: string; role: string } | null },
): Promise<{ requestId: string; requestNumber: string } | null> {
  const request = await tx.citizenRequest.findUnique({
    where: { citizenPaymentId: input.billId },
    select: { id: true, requestNumber: true, status: true },
  });
  if (!request || (request.status !== 'AWAITING_PAYMENT' && request.status !== 'IN_REVIEW')) return null;

  if (request.status === 'IN_REVIEW') {
    const { count } = await tx.citizenRequest.updateMany({
      where: { id: request.id, status: 'IN_REVIEW' },
      data: { status: 'AWAITING_PAYMENT', paidAt: null },
    });
    if (count === 0) return null;
    await audit.recordInTransaction({
      actorId: null,
      actorType: 'SYSTEM',
      action: 'REQUEST_PAYMENT_REVERSED',
      entityType: 'CitizenRequest',
      entityId: request.id,
      before: { status: 'IN_REVIEW' },
      after: { requestNumber: request.requestNumber, status: 'AWAITING_PAYMENT' },
    });
  }

  const { count } = await tx.citizenRequest.updateMany({
    where: { id: request.id, status: 'AWAITING_PAYMENT' },
    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledById: input.actor?.id ?? null },
  });
  if (count === 0) return null;

  await audit.recordInTransaction({
    ...(input.actor
      ? { actorId: input.actor.id, actorType: 'STAFF' as const, actorRole: input.actor.role as never }
      : { actorId: null, actorType: 'SYSTEM' as const }),
    action: 'REQUEST_CANCELLED',
    entityType: 'CitizenRequest',
    entityId: request.id,
    before: { status: 'AWAITING_PAYMENT' },
    // Ids and enums only, as every request row: the bill's own row says why it went.
    after: { requestNumber: request.requestNumber, status: 'CANCELLED', cause: 'BILL_CANCELLED', citizenPaymentId: input.billId },
  });
  return { requestId: request.id, requestNumber: request.requestNumber };
}
