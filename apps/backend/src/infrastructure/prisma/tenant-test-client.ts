import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';

/**
 * The tenant client an integration spec talks to its scratch schema through.
 *
 * Not a convenience wrapper — it exists for the `connection_limit` below, which
 * every one of these specs needs and none of them had.
 *
 * The production factory builds its URL from `DATABASE_URL`, which on Supabase
 * already carries `?pgbouncer=true&connection_limit=N` (see
 * `TenantPrismaFactory.connectionUrlFor`). The specs build theirs from
 * `TEST_DATABASE_URL` — the *direct*, session-mode string — which carries
 * neither, so Prisma falls back to its own default pool of `num_cpus * 2 + 1`.
 * On an eight-core machine that is seventeen session connections per suite, and
 * these suites were first run against hosted staging (before `TARGETS.local`
 * became a local container), where that ceiling is shared with everything else
 * aimed at it. Point `TEST_DATABASE_URL` at a throwaway container, never at the
 * local development database: the suites drop and rebuild fixed schema names.
 */

/**
 * Small enough to bound three suites against a hosted database, large enough
 * that the concurrency tests still test concurrency.
 *
 * **Not 1**, which is the obvious choice and would quietly gut this suite. Half
 * the reason these specs need a real Postgres is to prove that simultaneous
 * writers are serialised *by the database* — the advisory lock behind building
 * suffix allocation, and the row lock behind the payment ledger. Prisma queues
 * transactions when its pool is exhausted, so a pool of one would serialise
 * those writers in the *client* and every one of those tests would pass without
 * ever contending for the thing it is meant to be testing. A green suite that
 * no longer tests its subject is worse than a slow one.
 *
 * Five leaves the largest of those tests (six concurrent creates) genuinely
 * fighting over the lock while capping a whole run at fifteen connections.
 */
const TEST_POOL_SIZE = 5;

export function tenantTestClient(connectionString: string, schemaName: string): TenantPrismaClient {
  const url = new URL(connectionString);
  url.searchParams.set('schema', schemaName);
  url.searchParams.set('connection_limit', String(TEST_POOL_SIZE));

  return new TenantPrismaClient({ datasources: { db: { url: url.toString() } } });
}
