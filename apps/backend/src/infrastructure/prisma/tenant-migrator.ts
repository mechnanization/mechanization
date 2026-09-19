import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'tenant', 'migrations');

/** Mirrors the shape of a Prisma migration folder: `0001_init/migration.sql`. */
export interface TenantMigration {
  name: string;
  sql: string;
}

/**
 * Migrations are applied to every tenant schema rather than once globally, which
 * is the standing cost of schema-per-tenant. At tens of municipalities that is
 * this loop; the point to reconsider the whole approach is the hundreds, not
 * before.
 */
export function loadTenantMigrations(): TenantMigration[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    // Lexicographic order is chronological because names are zero-padded.
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(join(MIGRATIONS_DIR, entry.name, 'migration.sql'), 'utf8'),
    }));
}

function assertSafeSchemaName(schemaName: string): void {
  if (!/^tenant_[a-z0-9_]{1,50}$/.test(schemaName)) {
    throw new Error(`Refusing to run DDL against unsafe schema name '${schemaName}'`);
  }
}

/**
 * `CREATE EXTENSION IF NOT EXISTS`, made safe against itself.
 *
 * The statement checks and then inserts, so two sessions that both find the
 * extension missing both insert, and the second fails on
 * `pg_extension_name_index` (23505) instead of finding it there. The migrator
 * runs one municipality at a time, so production never races — but CI starts
 * every integration suite at once against an empty database, and whichever
 * suite lost failed its whole `beforeAll`: a red run on correct code, gone on
 * retry, which is the kind of gate people learn to re-run past.
 *
 * Losing that race means another session created the extension, which is the
 * outcome asked for; any other error is still thrown.
 */
async function ensurePgcrypto(client: Client): Promise<void> {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
  } catch (error) {
    if ((error as { code?: string }).code !== '23505') throw error;
  }
}

/**
 * Creates the schema if needed and applies every migration it has not seen.
 *
 * Applied migrations are tracked in a `_tenant_migrations` table *inside each
 * tenant schema*, so a schema is self-describing: reading it tells you exactly
 * which version that municipality is on, without consulting a central ledger
 * that could disagree with reality.
 */
export async function migrateTenantSchema(
  client: Client,
  schemaName: string,
  log: (message: string) => void = () => {},
): Promise<{ applied: string[]; skipped: string[] }> {
  assertSafeSchemaName(schemaName);

  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
  // pgcrypto backs gen_random_uuid(); installed in `public` and reachable from
  // every schema, so tenant DDL does not each need its own copy.
  await ensurePgcrypto(client);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "${schemaName}"."_tenant_migrations" (
      "name"      TEXT PRIMARY KEY,
      "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const { rows } = await client.query<{ name: string }>(
    `SELECT "name" FROM "${schemaName}"."_tenant_migrations"`,
  );
  const alreadyApplied = new Set(rows.map((row) => row.name));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of loadTenantMigrations()) {
    if (alreadyApplied.has(migration.name)) {
      skipped.push(migration.name);
      continue;
    }

    // Each migration is its own transaction: a failure leaves the schema at the
    // last complete migration rather than half-way through one.
    await client.query('BEGIN');
    try {
      // search_path is what lets one unqualified SQL file build any schema.
      // Setting it as a transaction-local also means a failure cannot leak the
      // altered search_path into whatever runs next on this connection.
      await client.query(`SET LOCAL search_path TO "${schemaName}"`);
      await client.query(migration.sql);
      await client.query(
        `INSERT INTO "${schemaName}"."_tenant_migrations" ("name") VALUES ($1)`,
        [migration.name],
      );
      await client.query('COMMIT');

      applied.push(migration.name);
      log(`  applied ${migration.name} to ${schemaName}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw new Error(
        `Migration '${migration.name}' failed for schema '${schemaName}': ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { applied, skipped };
}
