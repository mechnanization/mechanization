import { Client } from 'pg';
import { migrateTenantSchema } from './tenant-migrator';

/**
 * Two municipalities, one database, identical schemas.
 *
 * This is the test that would have caught a defect the suite carried for nine
 * migrations: `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)`
 * searches the whole database, while a constraint name is per-schema. The
 * first municipality got its foreign keys; every later one had them skipped,
 * silently, because the guard found the *first* schema's row and concluded
 * there was nothing to do. 22 constraints — among them the cascades under
 * `unit_occupancies`, which is what billing reads — simply were not there.
 *
 * Nothing in a single-schema test can see it. `pnpm db:status:*` cannot either:
 * the migration is recorded as applied, and it was. Only comparing two schemas
 * built by the same chain shows the difference, which is what this does.
 *
 * It deliberately compares every catalog, not only constraints. The next
 * unqualified guard will not be on `pg_constraint`, and this should fail on it
 * the day it is written rather than the day a second municipality is onboarded.
 *
 * Set `TEST_DATABASE_URL` to run it (a throwaway Postgres 17 — never staging).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FIRST = 'tenant_parity_first_spec';
const SECOND = 'tenant_parity_second_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/**
 * One row per catalog object, as a string, so a diff names what is missing
 * rather than reporting that two numbers differ.
 *
 * Constraints carry their definition, not just their name: a foreign key that
 * exists in both schemas with `ON DELETE SET NULL` in one and `CASCADE` in the
 * other is the same class of defect and would otherwise pass.
 */
const CATALOGS: Record<string, string> = {
  tables: `SELECT table_name FROM information_schema.tables WHERE table_schema = $1`,
  columns: `SELECT table_name || '.' || column_name || ' ' || data_type ||
                   CASE WHEN is_nullable = 'NO' THEN ' NOT NULL' ELSE '' END
              FROM information_schema.columns WHERE table_schema = $1`,
  constraints: `SELECT c.conname || ' → ' || pg_get_constraintdef(c.oid)
                  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
                 WHERE n.nspname = $1`,
  indexes: `SELECT indexname || ' → ' || indexdef FROM pg_indexes WHERE schemaname = $1`,
  triggers: `SELECT t.tgname || ' on ' || cl.relname
               FROM pg_trigger t
               JOIN pg_class cl ON cl.oid = t.tgrelid
               JOIN pg_namespace n ON n.oid = cl.relnamespace
              WHERE n.nspname = $1 AND NOT t.tgisinternal`,
  enums: `SELECT t.typname || ' = ' || (
            SELECT string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
              FROM pg_enum e WHERE e.enumtypid = t.oid)
            FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = $1 AND t.typtype = 'e'`,
  functions: `SELECT p.proname || '(' || pg_get_function_arguments(p.oid) || ')'
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
               WHERE n.nspname = $1`,
};

describeIfDb('Tenant migrator — every municipality gets the same schema', () => {
  let ddl: Client;

  /*
    The schema's own name appears inside the definitions Postgres prints — an
    index's `ON tenant_x.units`, an enum cast's `::tenant_x."UnitStatus"` — so
    it is scrubbed before comparing. Everything else must match character for
    character.
  */
  const read = async (sql: string, schema: string) => {
    const { rows } = await ddl.query(sql, [schema]);
    const own = new RegExp(`"?${schema}"?\\.`, 'g');
    return new Set(rows.map((row) => String(Object.values(row)[0]).replace(own, '')));
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    for (const schema of [FIRST, SECOND]) {
      await ddl.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    /*
      In this order, and both present at the end — that is the whole setup. The
      second call is the one that used to come out short, because the first had
      already put the constraint names into `pg_constraint`.
    */
    await migrateTenantSchema(ddl, FIRST);
    await migrateTenantSchema(ddl, SECOND);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    for (const schema of [FIRST, SECOND]) {
      await ddl?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it.each(Object.entries(CATALOGS))(
    'gives the second municipality the same %s',
    async (_kind, sql) => {
      const first = await read(sql, FIRST);
      const second = await read(sql, SECOND);

      // Both directions: a missing object and a surplus one are both drift.
      expect([...first].filter((item) => !second.has(item)).sort()).toEqual([]);
      expect([...second].filter((item) => !first.has(item)).sort()).toEqual([]);
      expect(first.size).toBeGreaterThan(0);
    },
  );

  /**
   * The behaviour behind one of the 22, stated as behaviour.
   *
   * A set difference can be read as bookkeeping. This is what the missing
   * foreign key actually did: emptying `users` left the payouts behind, in the
   * second municipality only — and a restore then wrote the snapshot's payouts
   * on top of rows that should not have survived.
   */
  it('cascades a deleted inspector into their payouts, in either schema', async () => {
    const inspectorId = '33333333-3333-4333-8333-333333333333';
    for (const schema of [FIRST, SECOND]) {
      await ddl.query(`SET search_path TO "${schema}"`);
      await ddl.query(
        `INSERT INTO users (id, "tenantSlug", "referenceNumber", "firstName", "lastName",
                            "updatedAt", kind, role)
         VALUES ($1, $2, 'PARITY-1', 'a', 'b', NOW(), 'STAFF', 'FIELD_INSPECTOR')`,
        [inspectorId, schema],
      );
      await ddl.query(
        `INSERT INTO inspector_payouts ("inspectorId", amount) VALUES ($1, 1)`,
        [inspectorId],
      );
      await ddl.query('DELETE FROM users');

      const { rows } = await ddl.query('SELECT count(*)::int AS n FROM inspector_payouts');
      expect({ schema, payouts: rows[0].n }).toEqual({ schema, payouts: 0 });
    }
    await ddl.query('SET search_path TO public');
  });
});
