import type { Prisma } from '../../../generated/tenant-client';
import { allocateDocumentNumber } from '../../common/document-number';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { assertNotMergedAway } from '../citizens/merged-away';

/**
 * Raises one bill against one citizen with no fee notice behind it, inside the
 * caller's transaction — the body of `FeesService.chargeIndividual`, lifted out
 * so a municipal request (migration 0092) can raise its fee in the same
 * transaction that records it was raised. A transaction client has no
 * `$transaction` of its own (docs/gotchas.md), so a caller already inside one
 * could not call `chargeIndividual`.
 *
 * The number is drawn in the same transaction as the row: drawn and then not
 * used, it would be printed on nothing. A citizen file folded into another is
 * refused (`assertNotMergedAway`): a bill there is one the person never sees.
 * The bill is in pounds, the column's default; nothing on this path writes
 * another currency.
 *
 * `issuedById` (0091, finance audit B4) is required, so no caller forgets it:
 * the clerk who charged it, or the one who raised a request's fee at the
 * counter; null only when no staff member did (a citizen's own press online).
 */
export async function raiseOneOffBill(
  tx: Prisma.TransactionClient,
  schema: Prisma.Sql,
  input: { citizenId: string; title: string; amount: number; dueDate: Date; issuedById: string | null },
): Promise<{ id: string; invoiceNumber: string; currency: string }> {
  const citizen = await tx.user.findFirst({
    where: { id: input.citizenId, kind: 'CITIZEN' },
    select: { id: true, isActive: true },
  });
  if (!citizen) {
    throw new NotFoundError({ code: 'CITIZEN_NOT_FOUND', message: `Citizen ${input.citizenId} was not found` });
  }
  await assertNotMergedAway(tx, citizen.id);
  // An archived file takes no new fees, whichever way the fee is raised: «تكليف مباشر» or a
  // municipal request's (`FeesService.chargeableCitizen`, develop's rule since 2026-10-14).
  if (!citizen.isActive) {
    throw new ConflictError({
      code: 'FEE_CITIZEN_ARCHIVED',
      message: 'This citizen file is archived, and an archived file takes no new fees',
    });
  }

  const invoiceNumber = await allocateDocumentNumber(tx, schema, 'INVOICE');
  const created = await tx.citizenPayment.create({
    data: {
      citizenId: citizen.id,
      title: input.title,
      amount: input.amount,
      dueDate: input.dueDate,
      invoiceNumber,
      issuedById: input.issuedById,
    },
    select: { id: true, currency: true },
  });
  return { id: created.id, invoiceNumber, currency: created.currency };
}
