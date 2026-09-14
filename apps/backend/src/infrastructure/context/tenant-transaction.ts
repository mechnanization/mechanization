import { Logger } from '@nestjs/common';
import type { TenantContextService } from './tenant-context.service';

const logger = new Logger('TenantTransaction');

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

  const afterCommit: Array<() => unknown> = [];
  const result = await scope.prisma.$transaction(
    (tx) =>
      context.run({ ...scope, prisma: tx as never, transaction: { afterCommit } }, work),
    { maxWait: options.maxWait ?? 15_000, timeout: options.timeout ?? 60_000 },
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
