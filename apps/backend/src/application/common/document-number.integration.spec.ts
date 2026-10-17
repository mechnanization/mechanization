import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from '../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../infrastructure/prisma/tenant-test-client';
import { tenantSchemaRef } from '../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber, allocateDocumentNumbers } from './document-number';

/**
 * The counter book, against real Postgres.
 *
 * What only a database can prove: that the counter restarts on the first of the
 * month, that two clerks drawing in the same moment are never handed the same
 * number, and that a number drawn inside a transaction that fails goes back.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_docnum_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('allocateDocumentNumbers', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  const S = tenantSchemaRef(SCHEMA);

  /** Each draw in its own transaction, as every real caller does. */
  const draw = (kind: Parameters<typeof allocateDocumentNumber>[2], period?: string): Promise<string> =>
    db.$transaction((tx) => allocateDocumentNumber(tx, S, kind, period));

  const drawMany = (
    kind: Parameters<typeof allocateDocumentNumbers>[2],
    count: number,
    period?: string,
  ): Promise<string[]> => db.$transaction((tx) => allocateDocumentNumbers(tx, S, kind, count, period));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('starts a book at 0001', async () => {
    expect(await draw('RECEIPT', '2610')).toBe('RCP-2610-0001');
    expect(await draw('RECEIPT', '2610')).toBe('RCP-2610-0002');
  });

  /* The whole reason this is a table and not a sequence. */
  it('restarts at 0001 in a new month', async () => {
    expect(await draw('RECEIPT', '2611')).toBe('RCP-2611-0001');
    // …and the month before it carries on untouched.
    expect(await draw('RECEIPT', '2610')).toBe('RCP-2610-0003');
  });

  it('counts each book separately', async () => {
    expect(await draw('INVOICE', '2610')).toBe('INV-2610-0001');
    expect(await draw('VOUCHER', '2610')).toBe('PV-2610-0001');
    expect(await draw('TRANSFER', '2610')).toBe('TR-2610-0001');
    // Drawing three other books did not move the receipt book.
    expect(await draw('RECEIPT', '2610')).toBe('RCP-2610-0004');
  });

  it('hands out a contiguous block and advances by exactly its size', async () => {
    const block = await drawMany('INVOICE', 3, '2610');

    expect(block).toEqual(['INV-2610-0002', 'INV-2610-0003', 'INV-2610-0004']);
    expect(await draw('INVOICE', '2610')).toBe('INV-2610-0005');
  });

  it('refuses a block that is not a positive whole number', async () => {
    await expect(drawMany('INVOICE', 0, '2610')).rejects.toThrow(/positive integer/);
    await expect(drawMany('INVOICE', -1, '2610')).rejects.toThrow(/positive integer/);
    await expect(drawMany('INVOICE', 1.5, '2610')).rejects.toThrow(/positive integer/);
  });

  /*
    The guarantee the whole mechanism exists for. Two clerks pressing «سجّل
    الدفعة» in the same moment must not print one number on two receipts; the
    second waits on the row rather than reading the same maximum.
  */
  it('never hands the same number to two concurrent draws', async () => {
    const drawn = await Promise.all(
      Array.from({ length: 12 }, () => draw('RECEIPT', '2612')),
    );

    expect(new Set(drawn).size).toBe(12);
    expect([...drawn].sort()).toEqual(
      Array.from({ length: 12 }, (_, i) => `RCP-2612-${String(i + 1).padStart(4, '0')}`),
    );
  });

  /*
    A sequence keeps its advance when the surrounding transaction rolls back;
    this counter goes back with it. That is the one way this mechanism is
    *better* than what it replaces — a payment that fails halfway no longer
    burns the number it was going to print.
  */
  it('gives the number back when the transaction fails', async () => {
    const before = await draw('VOUCHER', '2610');

    await expect(
      db.$transaction(async (tx) => {
        await allocateDocumentNumber(tx, S, 'VOUCHER', '2610');
        throw new Error('the voucher failed after the number was drawn');
      }),
    ).rejects.toThrow('the voucher failed');

    const after = await draw('VOUCHER', '2610');
    const next = (value: string): string =>
      `PV-2610-${String(Number(value.slice(-4)) + 1).padStart(4, '0')}`;
    expect(after).toBe(next(before));
  });

  it('keeps the counter where the rows say it is', async () => {
    const rows = await db.$queryRaw<Array<{ kind: string; period: string; nextValue: number }>>`
      SELECT "kind", "period", "nextValue" FROM ${S}document_counters
       WHERE "kind" = 'RECEIPT' ORDER BY "period"
    `;

    expect(rows).toEqual([
      { kind: 'RECEIPT', period: '2610', nextValue: 5 },
      { kind: 'RECEIPT', period: '2611', nextValue: 2 },
      { kind: 'RECEIPT', period: '2612', nextValue: 13 },
    ]);
  });
});
