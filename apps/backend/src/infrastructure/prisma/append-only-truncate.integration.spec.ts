import { Client } from 'pg';
import { migrateTenantSchema } from './tenant-migrator';

/**
 * 0103: TRUNCATE is refused on every append-only and written-once table, the
 * one way past their row triggers (`TRUNCATE treasury_day_closures CASCADE`
 * reopened every closed day; docs/security.md, task S19), and on the tables a
 * later migration guards in the file that creates them (0108, old debts).
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_append_only_truncate_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const GUARDED = [
  'audit_log_entries',
  'payment_transactions',
  'payment_settlements',
  'treasury_entries',
  'treasury_day_closures',
  'treasury_counts',
  'expense_vouchers',
  'expense_requests',
  'income_vouchers',
  'treasury_transfers',
  'inspector_payouts',
  // 0108: old debts, written once their batch is approved.
  'arrears_batches',
  'arrears_lines',
  'arrears_batch_citizens',
];

describeIfDb('0103 — TRUNCATE on the append-only tables', () => {
  let ddl: Client;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** Runs one statement in a transaction that is always rolled back, and returns its error. */
  async function refusal(sql: string): Promise<Error | null> {
    await ddl.query('BEGIN');
    try {
      await ddl.query(sql);
      return null;
    } catch (error) {
      return error as Error;
    } finally {
      await ddl.query('ROLLBACK');
    }
  }

  it('has a guard on each table, in this schema', async () => {
    const { rows } = await ddl.query<{ table: string }>(
      `SELECT c.relname AS "table" FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND tg.tgname = c.relname || '_no_truncate'`,
      [SCHEMA],
    );
    expect(rows.map((row) => row.table).sort()).toEqual([...GUARDED].sort());
  });

  it.each(GUARDED)('refuses TRUNCATE %s', async (table) => {
    const error = await refusal(`TRUNCATE "${SCHEMA}"."${table}" CASCADE`);
    expect(error?.message).toMatch(/is append-only: TRUNCATE is refused/);
  });

  it('refuses a TRUNCATE that reaches a guarded table only through CASCADE', async () => {
    // The wallets are not append-only; their entries are, and CASCADE empties them too.
    const error = await refusal(`TRUNCATE "${SCHEMA}"."treasury_accounts" CASCADE`);
    expect(error?.message).toMatch(/treasury_\w+ is append-only/);
  });

  it('leaves a table that is not append-only alone', async () => {
    expect(await refusal(`TRUNCATE "${SCHEMA}"."whish_checkouts"`)).toBeNull();
  });

  it('is idempotent: applying the migration again adds no second guard', async () => {
    await migrateTenantSchema(ddl, SCHEMA);
    const { rows } = await ddl.query<{ count: string }>(
      `SELECT count(*) FROM pg_trigger tg
         JOIN pg_class c ON c.oid = tg.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND tg.tgname LIKE '%\\_no\\_truncate'`,
      [SCHEMA],
    );
    expect(Number(rows[0]!.count)).toBe(GUARDED.length);
  });
});
