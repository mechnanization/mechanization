import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { municipalToday, type CreateTransferInput } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { DailyCountService } from './daily-count.service';
import { addDays } from './day-closing.plan';
import { DayClosureService } from './day-closure.service';
import { ExpensesService } from './expenses.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';

/**
 * «سجّل الجرد» beside a writer that touches two counted wallets, against a real
 * Postgres (docs/finance.md §7.1, §14; the review of 2026-10-11).
 *
 * A count's insert checks its foreign key to the wallet and takes `FOR KEY
 * SHARE` on it. The count wrote its lines in the order the sheet sends them —
 * by type, currency and name, not by id — while every money writer locks its
 * wallets `FOR UPDATE` in id order. With the higher-id wallet first on the
 * sheet, the count held it and waited for the lower one, which a transfer held
 * while waiting for the higher: `40P01`, and a 500 for whichever Postgres chose.
 *
 * Pinned by interleaving the two by hand (docs/gotchas.md, «Several payments in
 * one transaction…»): the count is paused right after its first line is
 * written, the transfer is started and given time to take its first wallet and
 * queue on the other, then the count goes on. A free-running race only finds
 * the window sometimes; this finds it every time, and passes only when the
 * count takes its wallets in id order before it writes a line.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_count_lock_order_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const TODAY = municipalToday();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describeIfDb('The daily count and a writer over the same two wallets', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let audit: AuditService;
  let closures: DayClosureService;
  let counts: DailyCountService;
  let transfers: TransfersService;

  let managerId: string;
  let accountantId: string;
  let low: string;
  let high: string;

  const scopedWith = <T>(prisma: unknown, work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'countlock', schemaName: SCHEMA, prisma: prisma as never }, work);
  const scoped = <T>(work: () => Promise<T>): Promise<T> => scopedWith(db, work);

  /**
   * A client whose first `treasuryCount.upsert` returns only once `open` is
   * called — a count stopped right after it has written its first line.
   */
  const pausingClient = () => {
    let reached!: () => void;
    let open!: () => void;
    const reachedFirst = new Promise<void>((resolve) => (reached = resolve));
    const gate = new Promise<void>((resolve) => (open = resolve));
    let calls = 0;
    const client = db.$extends({
      query: {
        treasuryCount: {
          async upsert({ args, query }) {
            const result = await query(args);
            calls += 1;
            if (calls === 1) {
              reached();
              await gate;
            }
            return result;
          },
        },
      },
    });
    return { client, reachedFirst, open };
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ledger = new TreasuryLedgerService(context);
    closures = new DayClosureService(context, ledger, audit);
    counts = new DailyCountService(context, ledger, closures, audit);
    transfers = new TransfersService(context, ledger, audit, new ExpensesService(context, ledger, audit));

    managerId = randomUUID();
    accountantId = randomUUID();
    await db.user.createMany({
      data: [
        {
          id: managerId, kind: 'STAFF', tenantSlug: 'countlock', email: `m-${managerId}@t.gov.lb`,
          firstName: 'المدير', lastName: 'العام', role: 'SUPER_ADMIN',
        },
        {
          id: accountantId, kind: 'STAFF', tenantSlug: 'countlock', email: `a-${accountantId}@t.gov.lb`,
          firstName: 'رنا', lastName: 'المحاسبة', role: 'ACCOUNTANT',
        },
      ],
    });

    // Live since yesterday, with ليرة in the safe and on Whish.
    const goLiveAt = new Date(`${addDays(TODAY, -1)}T06:00:00.000Z`);
    await ddl.query(
      `INSERT INTO "${SCHEMA}"."system_settings" ("id", "singleton", "updatedAt", "treasuryGoLiveAt")
       VALUES (gen_random_uuid(), true, now(), $1)
       ON CONFLICT ("singleton") DO UPDATE SET "treasuryGoLiveAt" = EXCLUDED."treasuryGoLiveAt"`,
      [goLiveAt],
    );
    await ddl.query(`UPDATE "${SCHEMA}"."treasury_accounts" SET "createdAt" = $1::timestamptz - interval '1 day'`, [
      goLiveAt,
    ]);
    const wallet = async (type: string) =>
      (await db.treasuryAccount.findFirstOrThrow({ where: { type: type as never, currency: 'LBP', isPrimary: true } })).id;
    [low, high] = [await wallet('CASH_SAFE'), await wallet('WHISH_ACCOUNT')].sort();
    await scoped(() =>
      db.$transaction((tx) =>
        ledger.post(
          tx,
          [
            { accountId: low!, currency: 'LBP', amount: new Prisma.Decimal(5_000_000) },
            { accountId: high!, currency: 'LBP', amount: new Prisma.Decimal(5_000_000) },
          ],
          { source: 'OPENING_BALANCE', sourceId: null, actorId: managerId, occurredAt: goLiveAt },
        ),
      ),
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('lets a transfer wait for a count that lists the higher-id wallet first, with no deadlock', async () => {
    const outcomes: string[] = [];
    for (let round = 0; round < 3; round++) {
      /*
        The first count of a wallet on a day is an INSERT, the one that checks
        the foreign key; a recount is an UPDATE that keeps it. So each round
        starts with today's counts gone, the way a day's first «سجّل الجرد» finds it.
      */
      await ddl.query(`DELETE FROM "${SCHEMA}"."treasury_counts" WHERE "businessDate" = $1::date`, [TODAY]);
      const sheet = await scoped(() => counts.sheet(TODAY));
      const line = (accountId: string) => {
        const shown = sheet.lines.find((candidate) => candidate.account.id === accountId)!;
        return { accountId, expectedAmount: shown.expectedAmount, countedAmount: shown.expectedAmount };
      };

      const { client, reachedFirst, open } = pausingClient();
      const counted = scopedWith(client, () =>
        counts.record({ businessDate: TODAY, counts: [line(high), line(low)] }, { id: accountantId, role: 'ACCOUNTANT' }),
      );
      counted.catch(() => undefined);
      await reachedFirst;

      // Low → high: the transfer locks the lower id first, then waits on the higher.
      const moved = scoped(() =>
        transfers.create(
          {
            kind: 'SAME_CURRENCY',
            fromAccountId: low,
            toAccountId: high,
            amount: 1_000,
            description: 'مناقلة أثناء الجرد',
            clientRequestId: randomUUID(),
          } as CreateTransferInput,
          { id: managerId, role: 'SUPER_ADMIN' },
        ),
      );
      moved.catch(() => undefined);
      await pause(400);
      open();

      for (const result of await Promise.allSettled([counted, moved])) {
        outcomes.push(result.status === 'fulfilled' ? 'ok' : String((result.reason as Error).message).slice(0, 160));
      }
    }
    expect(outcomes).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
    // Each transfer waited for its count, then moved: three of 1,000 ل.ل from the lower id to the higher.
    const balance = async (accountId: string) =>
      Number((await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0);
    expect(await balance(low)).toBe(5_000_000 - 3_000);
    expect(await balance(high)).toBe(5_000_000 + 3_000);
  });
});
