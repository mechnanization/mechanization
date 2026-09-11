import { Prisma } from '../../generated/tenant-client';

/**
 * A Postgres schema name we are willing to interpolate into SQL.
 *
 * The same rule `TenantPrismaFactory` applies to the connection string, restated
 * here because this module also builds SQL by concatenation and must not trust a
 * caller to have checked. Schema names come from the tenant registry, never from
 * a request — but "never" is a property of today's call graph, and this is the
 * line that keeps it true if that changes.
 */
const SAFE_SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Why every raw query in this codebase names its schema.
 *
 * Prisma's model queries are schema-qualified by the client: `?schema=` in the
 * connection string makes the generated SQL say `"tenant_x"."buildings"`, and
 * those are safe. **`$queryRaw` is not.** Prisma sends raw SQL through
 * untouched, so an unqualified `FROM damage_assessments` resolves through the
 * connection's `search_path` — session state, on a connection this application
 * does not own.
 *
 * And it does not own it, because the app talks to Supabase through the
 * **transaction pooler** (`DATABASE_URL` is port 6543, `pgbouncer=true`). In
 * transaction mode a client's statements are handed to whichever server
 * connection is free, and session-level settings are explicitly not guaranteed
 * to travel with them. Supabase and Prisma both document this; the failure it
 * produces is the nastiest kind:
 *
 * > `Raw query failed. Code: 42P01. Message: relation "damage_assessments"
 * > does not exist`
 *
 * — on a table that exists, from a connection that had just served a dozen
 * successful queries, once, with nothing else in the log around it. It happened
 * on 2026-09-10 at 08:18:23Z on staging: `GET /t/albazourieh/buildings`, while
 * every Prisma model query in the same request succeeded. It is unreproducible
 * on demand, it will reappear under load, and it fails a page rather than a row.
 *
 * The fix is to stop depending on session state at all. Nothing here sets
 * `search_path`, waits for a transaction, or costs a round trip: the schema is
 * written into the SQL, so the statement means the same thing on any connection
 * it lands on.
 *
 * `raw-sql-is-schema-qualified.spec.ts` fails the build if a raw query is added
 * without it.
 */
export function tenantSchemaRef(schemaName: string): Prisma.Sql {
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Refusing to build SQL for unsafe schema name '${schemaName}'`);
  }

  /*
    A trailing dot, so a call site reads `FROM ${S}buildings`.

    The alternative — a helper taking the table name — reads better in isolation
    and worse in a forty-line query, where every table would become a `${}`
    expression and the SQL would stop looking like SQL. This keeps the query
    scannable by somebody checking it against a query plan.
  */
  return Prisma.raw(`"${schemaName}".`);
}

/** The same prefix as a plain string, for the two `$queryRawUnsafe` call sites. */
export function tenantSchemaPrefix(schemaName: string): string {
  if (!SAFE_SCHEMA_NAME.test(schemaName)) {
    throw new Error(`Refusing to build SQL for unsafe schema name '${schemaName}'`);
  }
  return `"${schemaName}".`;
}
