import type { Prisma } from '../../../generated/tenant-client';
import { allocateDocumentNumbers } from '../../common/document-number';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import {
  arrearsAssessment,
  arrearsBillTitle,
  arrearsDueDate,
  type StoredArrearsLine,
} from '../arrears/arrears-approval.plan';
import { assertNotMergedAway } from '../citizens/merged-away';

/** A kept line with its citizen: what becomes a bill. */
export type ArrearsBillLine = StoredArrearsLine & { citizenId: string };

/**
 * Raises one bill for each kept old-debt line, inside the caller's transaction
 * (docs/old-debts-plan.md §7), beside `raiseOneOffBill`.
 *
 * What differs from a one-off charge, and why:
 * - **An archived file is billed** (decision 12): a departed or dead debtor's old
 *   debt can reach their file, but only through an approved batch — which is the
 *   only caller. `raiseOneOffBill` still refuses an archived file.
 * - **«ARR-»**, never «INV-»: an «INV-2611-…» would say the bill was issued this
 *   month, which is a fiction on an old debt. The month is the one it entered
 *   the system; the year is in `periodKey` and the title.
 * - **The line is the bill's key** (`arrearsLineId`, unique): the database
 *   refuses a second bill for the same line, whatever the code does.
 * - **No notice** (`feeNoticeId` null), so no recurring run, correction or
 *   per-unit guard that starts from a notice ever reads it.
 *
 * The numbers are drawn as one block, in the order the lines are given (the
 * caller sorts), in the same transaction as the rows: drawn and not used they
 * would be printed on nothing. A citizen folded into another file is refused
 * (`assertNotMergedAway`). Bills are in pounds, the column's default.
 *
 * Returns each bill's id with its line and citizen, for the audit rows.
 */
export async function raiseArrearsBills(
  tx: Prisma.TransactionClient,
  schema: Prisma.Sql,
  lines: readonly ArrearsBillLine[],
  issuedById: string,
): Promise<Array<{ id: string; arrearsLineId: string; citizenId: string; invoiceNumber: string; amount: number }>> {
  if (lines.length === 0) return [];

  const citizenIds = [...new Set(lines.map((line) => line.citizenId))];
  const found = await tx.user.findMany({
    where: { id: { in: citizenIds }, kind: 'CITIZEN' },
    select: { id: true },
  });
  if (found.length !== citizenIds.length) {
    const known = new Set(found.map((citizen) => citizen.id));
    const missing = citizenIds.find((id) => !known.has(id));
    throw new NotFoundError({ code: 'CITIZEN_NOT_FOUND', message: `Citizen ${missing} was not found` });
  }
  for (const citizenId of citizenIds) await assertNotMergedAway(tx, citizenId);

  const numbers = await allocateDocumentNumbers(tx, schema, 'ARREARS', lines.length);
  const created = await tx.citizenPayment.createManyAndReturn({
    data: lines.map((line, index) => ({
      citizenId: line.citizenId,
      title: arrearsBillTitle(line),
      amount: line.amount,
      dueDate: arrearsDueDate(line),
      periodKey: String(line.year),
      invoiceNumber: numbers[index]!,
      issuedById,
      arrearsLineId: line.id,
      assessment: arrearsAssessment(line) as unknown as Prisma.InputJsonObject,
    })),
    select: { id: true, arrearsLineId: true, citizenId: true, invoiceNumber: true, amount: true },
  });
  if (created.length !== lines.length) {
    throw new ConflictError({
      code: 'ARREARS_LINE_DUPLICATE',
      message: 'A bill was already raised for one of these lines',
    });
  }
  return created.map((bill) => ({
    id: bill.id,
    arrearsLineId: bill.arrearsLineId!,
    citizenId: bill.citizenId!,
    invoiceNumber: bill.invoiceNumber!,
    amount: Number(bill.amount),
  }));
}
