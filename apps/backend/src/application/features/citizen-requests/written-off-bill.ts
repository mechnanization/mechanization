import type { Prisma } from '../../../generated/tenant-client';
import type { AuditService } from '../audit/audit.service';

/**
 * Lets the request waiting on a bill that is now WRITTEN_OFF («شطب», 0107) go on to
 * review, in the caller's transaction. The council forgave the fee, so there is
 * nothing left for the citizen to pay: the request goes where a paid one goes,
 * AWAITING_PAYMENT → IN_REVIEW, as a fee the manager makes free does (the owner's
 * decision of 2026-11-21, open-decisions §23.6). Left waiting it could be neither
 * paid (a written-off bill takes no payment) nor cancelled (it has a bill), only
 * rejected.
 *
 * `paidAt` is written with the move because `citizen_requests_paid_stamp` requires it
 * on a billed request in review, and `citizen_requests_guard` (0094) lets it move
 * only with this step. Here it is the moment the fee stopped being owed, not a
 * payment: the audit row says so (`REQUEST_FEE_WRITTEN_OFF`, not `REQUEST_PAID`), and
 * the bill's own row names the decision.
 *
 * Two callers: `FeesService.writeOffBill`, behind its row lock on the bill with the
 * manager as the actor, and `CitizenRequestsService.reconcile`, with no actor (a
 * SYSTEM row), which heals a request the first could not reach.
 *
 * Returns the request it moved, or null when the bill was no waiting request's fee.
 */
export async function settleRequestOfWrittenOffBill(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'recordInTransaction'>,
  input: { billId: string; actor: { id: string; role: string } | null },
): Promise<{ requestId: string; requestNumber: string } | null> {
  const request = await tx.citizenRequest.findUnique({
    where: { citizenPaymentId: input.billId },
    select: { id: true, requestNumber: true, status: true },
  });
  if (!request || request.status !== 'AWAITING_PAYMENT') return null;

  const { count } = await tx.citizenRequest.updateMany({
    where: { id: request.id, status: 'AWAITING_PAYMENT' },
    data: { status: 'IN_REVIEW', paidAt: new Date() },
  });
  if (count === 0) return null;

  await audit.recordInTransaction({
    ...(input.actor
      ? { actorId: input.actor.id, actorType: 'STAFF' as const, actorRole: input.actor.role as never }
      : { actorId: null, actorType: 'SYSTEM' as const }),
    action: 'REQUEST_FEE_WRITTEN_OFF',
    entityType: 'CitizenRequest',
    entityId: request.id,
    before: { status: 'AWAITING_PAYMENT' },
    after: { requestNumber: request.requestNumber, status: 'IN_REVIEW', cause: 'BILL_WRITTEN_OFF', citizenPaymentId: input.billId },
  });
  return { requestId: request.id, requestNumber: request.requestNumber };
}
