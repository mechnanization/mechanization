import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { tenantTestClient } from '../prisma/tenant-test-client';
import { TenantContextService, type TenantScope } from './tenant-context.service';
import { readInTenantSnapshot, runInTenantTransaction } from './tenant-transaction';

/**
 * `readInTenantSnapshot` against real Postgres (audit ARCH-06).
 *
 * What only a database can prove: that the reads inside see one snapshot while
 * another connection commits, that the transaction refuses a write, and how it
 * meets `runInTenantTransaction` from either side. A bare table in a scratch
 * schema is enough; nothing here reads the tenant model.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_snapshot_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);

describeIfDb('readInTenantSnapshot', () => {
  let other: Client;
  let db: TenantPrismaClient;
  const context = new TenantContextService();
  const T = `"${SCHEMA}"."rows"`;

  const inScope = <R>(work: () => Promise<R>): Promise<R> => {
    const scope: TenantScope = { tenantId: 'spec', tenantSlug: 'snapshot-spec', schemaName: SCHEMA, prisma: db };
    return context.run(scope, work);
  };
  const count = async (): Promise<number> =>
    (await context.prisma.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM ${T}`))[0]!.n;
  const setting = async (name: string): Promise<string> =>
    (await context.prisma.$queryRawUnsafe<Array<Record<string, string>>>(`SHOW ${name}`))[0]![name]!;

  beforeAll(async () => {
    other = new Client({ connectionString: TEST_DATABASE_URL });
    await other.connect();
    await other.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await other.query(`CREATE SCHEMA "${SCHEMA}"`);
    await other.query(`CREATE TABLE ${T} (n int NOT NULL)`);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
  });

  afterAll(async () => {
    await db?.$disconnect();
    await other?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await other?.end();
  });

  beforeEach(() => other.query(`TRUNCATE ${T}`));

  it('runs at Repeatable Read, read only', async () => {
    const seen = await inScope(() =>
      readInTenantSnapshot(context, async () => ({
        isolation: await setting('transaction_isolation'),
        readOnly: await setting('transaction_read_only'),
      })),
    );
    expect(seen).toEqual({ isolation: 'repeatable read', readOnly: 'on' });
  });

  it('keeps one snapshot while another connection commits, where Read Committed does not', async () => {
    const snapshot = await inScope(() =>
      readInTenantSnapshot(context, async () => {
        const before = await count();
        await other.query(`INSERT INTO ${T} VALUES (1)`);
        return { before, after: await count() };
      }),
    );
    expect(snapshot).toEqual({ before: 0, after: 0 });

    // The control: the same two reads in an ordinary transaction see the commit between them.
    const committed = await inScope(() =>
      runInTenantTransaction(context, async () => {
        const before = await count();
        await other.query(`INSERT INTO ${T} VALUES (2)`);
        return { before, after: await count() };
      }),
    );
    expect(committed).toEqual({ before: 1, after: 2 });
  });

  it('refuses a write, also one through runInTenantTransaction, and commits nothing', async () => {
    await expect(
      inScope(() =>
        readInTenantSnapshot(context, () =>
          runInTenantTransaction(context, () => context.prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES (3)`)),
        ),
      ),
    ).rejects.toThrow(/read-only transaction/);
    expect((await other.query(`SELECT count(*)::int AS n FROM ${T}`)).rows[0].n).toBe(0);
  });

  it('inside a writing transaction, joins it and leaves it writable', async () => {
    await inScope(() =>
      runInTenantTransaction(context, async () => {
        const readOnly = await readInTenantSnapshot(context, () => setting('transaction_read_only'));
        expect(readOnly).toBe('off');
        await context.prisma.$executeRawUnsafe(`INSERT INTO ${T} VALUES (4)`);
      }),
    );
    expect((await other.query(`SELECT count(*)::int AS n FROM ${T}`)).rows[0].n).toBe(1);
  });
});
