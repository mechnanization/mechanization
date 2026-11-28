import { Logger } from '@nestjs/common';
import { Prisma } from '../../generated/tenant-client';
import type { TenantContextService, TenantScope } from './tenant-context.service';

const logger = new Logger('TenantTransaction');

/**
 * Prisma's interactive-transaction bounds when the caller names none: `maxWait`
 * to be handed a connection, `timeout` to finish. Prisma's own 2 s / 5 s is too
 * short for a town-wide write. Here, not in `APP_CONFIG`, because infrastructure
 * does not import the application layer; the writes that need other bounds name
 * theirs in `APP_CONFIG.transactions`.
 */
const TENANT_TRANSACTION_DEFAULTS = { maxWait: 15_000, timeout: 60_000 } as const;

/**
 * Runs `work` in one transaction that every service it calls also writes through.
 *
 * ## The scope swap
 *
 * Services read the tenant client from the request scope rather than taking one
 * as an argument. Re-entering the scope with the transaction client in place of
 * the pooled one makes all of them part of this transaction — an owner link's
 * occupancies, a tenancy's vacancy, the cases they close — without widening a
 * single signature.
 *
 * ## Why listeners wait for the commit
 *
 * Those services also emit events, and the listeners run synchronously inside
 * the same scope. An audit listener writing through the scope's client was
 * writing through the transaction — and an event emitted near the end of the
 * work reached the database *after* the commit, where Prisma refuses it
 * («Transaction already closed») and the audit row was lost. So the scope
 * carries `transaction.afterCommit`: listeners with a side effect queue it there,
 * and it runs here, against the pooled client, once the transaction has
 * committed. A transaction that rolls back runs none of them, which is also
 * right — there is nothing to audit about writes that never happened.
 *
 * Joins an enclosing transaction rather than opening a second one.
 */

export async function runInTenantTransaction<T>(
  context: TenantContextService,
  work: () => Promise<T>,
  options: { maxWait?: number; timeout?: number } = {},
): Promise<T> {
  const scope = context.require();
  if (scope.transaction) return work();

  return openTenantTransaction(context, scope, work, {
    maxWait: options.maxWait ?? TENANT_TRANSACTION_DEFAULTS.maxWait,
    timeout: options.timeout ?? TENANT_TRANSACTION_DEFAULTS.timeout,
  });
}

/**
 * Runs the reads in `work` against one snapshot of the municipality's data.
 *
 * For a screen whose figures must agree with each other: a page and its count,
 * a statement and the sums its opening balance is worked back from, a day's
 * sheet. Postgres's default, Read Committed, takes a new snapshot for every
 * statement, so two reads in one ordinary transaction (or one array-form
 * `$transaction([...])`) can each see a different set of committed rows. Repeatable
 * Read takes the snapshot at the first read and holds it to the end.
 *
 * The transaction is also READ ONLY, so a write that reaches it, through a
 * service called inside or through `runInTenantTransaction` (which joins it), is
 * refused by Postgres instead of committing in a read.
 *
 * `this.db` / `context.prisma` inside `work` is the snapshot's client, as in
 * `runInTenantTransaction`. Inside an enclosing transaction it joins that one
 * and changes nothing: an isolation level cannot be raised once a transaction
 * has read, and the enclosing writer must stay writable.
 */
export async function readInTenantSnapshot<T>(
  context: TenantContextService,
  work: () => Promise<T>,
): Promise<T> {
  const scope = context.require();
  if (scope.transaction) return work();

  return openTenantTransaction(
    context,
    scope,
    async () => {
      await context.prisma.$executeRaw`SET TRANSACTION READ ONLY`;
      return work();
    },
    { ...TENANT_TRANSACTION_DEFAULTS, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** Opens the transaction, swaps it into the scope, and runs the after-commit queue. */
async function openTenantTransaction<T>(
  context: TenantContextService,
  scope: TenantScope,
  work: () => Promise<T>,
  options: { maxWait: number; timeout: number; isolationLevel?: Prisma.TransactionIsolationLevel },
): Promise<T> {
  const afterCommit: Array<() => unknown> = [];
  const result = await scope.prisma.$transaction(
    (tx) =>
      context.run({ ...scope, prisma: tx as never, transaction: { afterCommit } }, work),
    options,
  );

  /*
    Not awaited, as an emitted event's listener never was: the request does not
    wait on its audit trail. Each runs back in the ordinary scope, and a failure
    in one is logged without stopping the rest.
  */
  const { transaction: _none, ...root } = scope;
  for (const task of afterCommit) {
    void context
      .run(root, async () => task())
      .catch((error: unknown) =>
        logger.error(
          `after-commit task failed: ${error instanceof Error ? error.message : String(error)}`,
          error instanceof Error ? error.stack : undefined,
        ),
      );
  }

  return result;
}
