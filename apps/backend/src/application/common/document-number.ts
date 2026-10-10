import {
  formatDocumentNumber,
  municipalPeriod,
  type DocumentKind,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../generated/tenant-client';

/**
 * Draws the next document number, or a block of them.
 *
 * ## Why one statement
 *
 * The counter is a row in `document_counters` keyed by (kind, period), because
 * a Postgres sequence cannot restart on the first of the month — `nextval` only
 * climbs, and anything that resets it races whatever is drawing from it
 * (migration 0079). The draw is a single `INSERT … ON CONFLICT DO UPDATE …
 * RETURNING`, which creates the month's first row and advances an existing one
 * in the same breath, and hands back the first number of the block it reserved.
 * Two clerks settling in the same moment cannot be given the same number: the
 * second waits on the row lock.
 *
 * ## It must share the caller's transaction
 *
 * `tx` is required rather than optional. The number and the document it goes on
 * have to commit or roll back together: a number drawn outside the transaction
 * survives a failed payment and is printed on nothing, and a document written
 * outside it can commit with a number nobody reserved. Passing the transaction
 * client is what makes the pair atomic — and it is also what makes the counter
 * roll back with a failed payment, so this gaps *less* than the sequences it
 * replaces.
 *
 * It also means issuance within a month serialises: the row stays locked until
 * the caller commits. At a municipality's volume that is nothing, and the
 * alternative is two residents holding the same receipt number.
 *
 * ## The schema prefix
 *
 * `schema` is the caller's `tenantSchemaRef`, for the reason spelled out in
 * `payment-ledger.service.ts`: an unqualified name resolves through the pooled
 * connection's `search_path`, and a drifted connection would draw from another
 * municipality's counter. These numbers are printed on paper handed to a
 * resident.
 */
export async function allocateDocumentNumbers(
  tx: Prisma.TransactionClient,
  schema: Prisma.Sql,
  kind: DocumentKind,
  count = 1,
  period: string = municipalPeriod(),
): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`allocateDocumentNumbers: count must be a positive integer, got ${count}`);
  }

  const rows = await tx.$queryRaw<Array<{ first: number }>>`
    INSERT INTO ${schema}document_counters ("kind", "period", "nextValue", "updatedAt")
    VALUES (${kind}, ${period}, ${count + 1}, CURRENT_TIMESTAMP)
    ON CONFLICT ("kind", "period") DO UPDATE
       SET "nextValue" = "document_counters"."nextValue" + ${count},
           "updatedAt" = CURRENT_TIMESTAMP
    RETURNING "nextValue" - ${count} AS "first"
  `;

  const first = Number(rows[0]?.first);
  if (!Number.isFinite(first)) {
    throw new Error(`allocateDocumentNumbers: the counter for ${kind}/${period} returned nothing`);
  }

  return Array.from({ length: count }, (_, index) =>
    formatDocumentNumber(kind, period, first + index),
  );
}

/** The common case: one document, one number. */
export async function allocateDocumentNumber(
  tx: Prisma.TransactionClient,
  schema: Prisma.Sql,
  kind: DocumentKind,
  period?: string,
): Promise<string> {
  const [number] = await allocateDocumentNumbers(tx, schema, kind, 1, period);
  return number;
}
