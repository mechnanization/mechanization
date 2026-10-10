import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { municipalToday } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient, Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { closedTreasuryDay } from '../../../infrastructure/prisma/check-violation';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { PaymentLedgerService, type LedgerAudit } from '../fees/payment-ledger.service';
import { DailyCashReportService } from './daily-cash-report.service';
import { DailyCountService } from './daily-count.service';
import { addDays } from './day-closing.plan';
import { DayClosureService } from './day-closure.service';
import { TreasuryLedgerService } from './treasury-ledger.service';

/**
 * The daily count and closing the day, against a real Postgres.
 *
 * What only a database can show: the 0082 triggers that keep a closed day
 * shut whatever writes to it, the CHECKs on a count and a closure, the lock a
 * close takes so nothing lands in the day while it is judged, and a payment
 * back-dated into a closed day rolling back whole.
 *
 * The services read the real clock, so the days are built back from Beirut's
 * today: the treasury went live six days ago (D0), money moved on D1 and D4,
 * only a collector moved on D3, and D2 and D5 were quiet until a test moves D5.
 * The file is ordered: each block leaves the books as the next one expects.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; CI always does.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_day_closing_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION_SQL = join(
  __dirname,
  '../../../infrastructure/prisma/tenant/migrations/0082_treasury_day_closing/migration.sql',
);

const TODAY = municipalToday();
const D0 = addDays(TODAY, -6);
const D1 = addDays(TODAY, -5);
const D2 = addDays(TODAY, -4);
const D3 = addDays(TODAY, -3);
const D4 = addDays(TODAY, -2);
const D5 = addDays(TODAY, -1);

/** Midday in Beirut on `day`, in either clock: 09:00 UTC is 11:00 or 12:00 there. */
const at = (day: string) => new Date(`${day}T09:00:00.000Z`);

describeIfDb('Daily count and closing', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let payments: PaymentLedgerService;
  let closures: DayClosureService;
  let counts: DailyCountService;
  let reports: DailyCashReportService;

  let citizenId: string;
  let managerId: string;
  let accountantId: string;
  let collectorId: string;

  let safeLbp: string;
  let safeUsd: string;
  let whishLbp: string;
  let whishUsd: string;

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'closing', schemaName: SCHEMA, prisma: db }, work);

  const accountant = () => ({ id: accountantId, role: 'ACCOUNTANT' });
  const manager = () => ({ id: managerId, role: 'SUPER_ADMIN' });

  const audit: LedgerAudit = (movement) => ({
    actorId: managerId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  const invoice = async (amount: number) =>
    (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount,
          currency: 'LBP',
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
        },
        select: { id: true },
      })
    ).id;

  /** A movement written the way every writer writes one: through `post`. */
  const move = (accountId: string, currency: string, amount: number, occurredAt: Date, source = 'ADJUSTMENT') =>
    scoped(() =>
      db.$transaction((tx) =>
        ledger.post(tx, [{ accountId, currency, amount: new Prisma.Decimal(amount) }], {
          source: source as never,
          sourceId: null,
          actorId: managerId,
          occurredAt,
        }),
      ),
    );

  const sheet = (day?: string) => scoped(() => counts.sheet(day));

  /** Every wallet counted at exactly the books' figure, except those given. */
  const countDay = async (
    day: string,
    overrides: Record<string, { countedAmount: number; varianceReason?: string }> = {},
  ) => {
    const current = await sheet(day);
    return scoped(() =>
      counts.record(
        {
          businessDate: day,
          counts: current.lines.map((line) => ({
            accountId: line.account.id,
            expectedAmount: line.expectedAmount,
            countedAmount: overrides[line.account.id]?.countedAmount ?? line.expectedAmount,
            varianceReason: overrides[line.account.id]?.varianceReason,
          })),
        },
        accountant(),
      ),
    );
  };

  const close = (day: string) => scoped(() => closures.close({ businessDate: day }, accountant()));

  const balance = async (accountId: string): Promise<number> =>
    Number((await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0);

  /** Runs statements in a transaction that is always rolled back, so a CHECK test leaves nothing behind. */
  const rolledBack = async (work: (client: Client) => Promise<unknown>): Promise<void> => {
    await ddl.query('BEGIN');
    try {
      await work(ddl);
    } finally {
      await ddl.query('ROLLBACK');
    }
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    closures = new DayClosureService(context, ledger, auditService);
    counts = new DailyCountService(context, ledger, closures, auditService);
    reports = new DailyCashReportService(context, ledger, closures);

    citizenId = randomUUID();
    managerId = randomUUID();
    accountantId = randomUUID();
    collectorId = randomUUID();
    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'closing', firstName: 'علي', lastName: 'خليل' },
        {
          id: managerId, kind: 'STAFF', tenantSlug: 'closing', email: `m-${managerId}@t.gov.lb`,
          firstName: 'المدير', lastName: 'العام', role: 'SUPER_ADMIN',
        },
        {
          id: accountantId, kind: 'STAFF', tenantSlug: 'closing', email: `a-${accountantId}@t.gov.lb`,
          firstName: 'رنا', lastName: 'المحاسبة', role: 'ACCOUNTANT',
        },
        {
          id: collectorId, kind: 'STAFF', tenantSlug: 'closing', email: `c-${collectorId}@t.gov.lb`,
          firstName: 'حسن', lastName: 'الجابي', role: 'COLLECTOR',
        },
      ],
    });

    const wallet = (type: string, currency: string) =>
      db.treasuryAccount.findFirstOrThrow({ where: { type: type as never, currency, isPrimary: true }, select: { id: true } });
    safeLbp = (await wallet('CASH_SAFE', 'LBP')).id;
    safeUsd = (await wallet('CASH_SAFE', 'USD')).id;
    whishLbp = (await wallet('WHISH_ACCOUNT', 'LBP')).id;
    whishUsd = (await wallet('WHISH_ACCOUNT', 'USD')).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────────────────────  the schema  ───────────────────────────────

  describe('the schema (migration 0082)', () => {
    it('is idempotent: running the file again changes nothing', async () => {
      const sql = readFileSync(MIGRATION_SQL, 'utf8');
      await ddl.query(`SET search_path TO "${SCHEMA}"`);
      await ddl.query(sql);
      await ddl.query(sql);
      await ddl.query('RESET search_path');
      const triggers = await ddl.query(
        `SELECT tg.tgname FROM pg_trigger tg
           JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1
            AND (tg.tgname LIKE '%respect_closed_days' OR tg.tgname = 'treasury_day_closures_no_delete')
          ORDER BY 1`,
        [SCHEMA],
      );
      expect(triggers.rows.map((row: { tgname: string }) => row.tgname)).toEqual([
        'treasury_counts_respect_closed_days',
        'treasury_day_closures_no_delete',
        'treasury_entries_respect_closed_days',
      ]);
    });

    it('pins every function to its own schema, so a write is judged by its own municipality’s closures', async () => {
      const functions = await ddl.query(
        `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = $1
            AND p.proname IN ('reject_closed_day_entry', 'reject_closed_day_count', 'reject_day_closure_delete')
          ORDER BY 1`,
        [SCHEMA],
      );
      expect(functions.rows).toHaveLength(3);
      for (const row of functions.rows as Array<{ proconfig: string[] }>) {
        expect(row.proconfig.join(' ')).toContain(`search_path=${SCHEMA}, pg_catalog`);
      }
    });

    it('requires a reopened day to say who and why, and a closed one to carry neither', async () => {
      await expect(
        rolledBack((client) =>
          client.query(
            `INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "status", "closedById")
             VALUES ($1, 'REOPENED', $2)`,
            ['2020-01-01', managerId],
          ),
        ),
      ).rejects.toThrow(/treasury_day_closures_reopen_iff_reopened/);
      await expect(
        rolledBack((client) =>
          client.query(
            `INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "status", "closedById", "reopenReason")
             VALUES ($1, 'CLOSED', $2, 'سبب')`,
            ['2020-01-01', managerId],
          ),
        ),
      ).rejects.toThrow(/treasury_day_closures_reopen_iff_reopened/);
    });

    it('keeps a count’s difference honest, and requires a reason for one', async () => {
      const insert = (client: Client, expected: number, counted: number, difference: number, reason: string | null) =>
        client.query(
          `INSERT INTO "${SCHEMA}"."treasury_counts"
             ("accountId", "currency", "businessDate", "expectedAmount", "countedAmount", "difference", "varianceReason", "countedById")
           VALUES ($1, 'LBP', $2, $3, $4, $5, $6, $7)`,
          [safeLbp, '2020-01-01', expected, counted, difference, reason, accountantId],
        );
      await expect(rolledBack((client) => insert(client, 100, 90, 0, 'x'))).rejects.toThrow(
        /treasury_counts_difference_consistent/,
      );
      await expect(rolledBack((client) => insert(client, 100, 90, -10, null))).rejects.toThrow(
        /treasury_counts_variance_explained/,
      );
      await expect(rolledBack((client) => insert(client, 100, -5, -105, 'x'))).rejects.toThrow(
        /treasury_counts_counted_not_negative/,
      );
      await expect(rolledBack((client) => insert(client, 100, 100, 0, null))).resolves.toBeUndefined();
    });

    it('refuses a count in a currency other than its wallet’s', async () => {
      await expect(
        rolledBack((client) =>
          client.query(
            `INSERT INTO "${SCHEMA}"."treasury_counts"
               ("accountId", "currency", "businessDate", "expectedAmount", "countedAmount", "difference", "countedById")
             VALUES ($1, 'USD', $2, 0, 0, 0, $3)`,
            [safeLbp, '2020-01-01', accountantId],
          ),
        ),
      ).rejects.toThrow(/treasury_counts_account_currency_fkey/);
    });

    it('never lets a closure be deleted', async () => {
      await expect(
        rolledBack(async (client) => {
          await client.query(
            `INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "closedById") VALUES ($1, $2)`,
            ['2020-01-01', managerId],
          );
          await client.query(`DELETE FROM "${SCHEMA}"."treasury_day_closures"`);
        }),
      ).rejects.toThrow(/never deleted/);
    });

    it('refuses an entry on or before a closed day, and lets one after it through', async () => {
      await expect(
        rolledBack(async (client) => {
          await client.query(
            `INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "closedById") VALUES ($1, $2)`,
            ['2020-01-10', managerId],
          );
          // 20:30 UTC on the 10th is 22:30 in Beirut: still the 10th.
          await client.query(
            `INSERT INTO "${SCHEMA}"."treasury_entries" ("accountId", "currency", "amount", "source", "occurredAt")
             VALUES ($1, 'LBP', 1, 'ADJUSTMENT', '2020-01-10T20:30:00Z')`,
            [safeLbp],
          );
        }),
      ).rejects.toThrow(/treasury day 2020-01-10 is closed/);

      await expect(
        rolledBack(async (client) => {
          await client.query(
            `INSERT INTO "${SCHEMA}"."treasury_day_closures" ("businessDate", "closedById") VALUES ($1, $2)`,
            ['2020-01-10', managerId],
          );
          // 22:30 UTC on the 10th is 00:30 on the 11th in Beirut: an open day.
          await client.query(
            `INSERT INTO "${SCHEMA}"."treasury_entries" ("accountId", "currency", "amount", "source", "occurredAt")
             VALUES ($1, 'LBP', 1, 'ADJUSTMENT', '2020-01-10T22:30:00Z')`,
            [safeLbp],
          );
        }),
      ).resolves.toBeUndefined();
    });
  });

  // ──────────────────────────────  before go-live  ─────────────────────────────

  describe('before the treasury is live', () => {
    it('has nothing to count and nothing to close', async () => {
      const current = await sheet();
      expect(current.goLiveOn).toBeNull();
      expect(current.nextDayToClose).toBeNull();
      expect(current.closure).toEqual({ ok: false, code: 'TREASURY_NOT_ACTIVE' });

      await expect(
        scoped(() =>
          counts.record(
            { businessDate: TODAY, counts: [{ accountId: safeLbp, expectedAmount: 0, countedAmount: 0 }] },
            accountant(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'TREASURY_NOT_ACTIVE' });
    });
  });

  // ─────────────────────────────  the week's books  ────────────────────────────

  describe('a week of movement', () => {
    beforeAll(async () => {
      // Live since 09:00 Beirut on D0, with two counted opening balances.
      const goLiveAt = new Date(`${D0}T06:00:00.000Z`);
      await ddl.query(
        `INSERT INTO "${SCHEMA}"."system_settings" ("id", "singleton", "updatedAt", "treasuryGoLiveAt")
         VALUES (gen_random_uuid(), true, now(), $1)`,
        [goLiveAt],
      );
      // The four wallets are seeded by the migration, which in real life ran before go-live.
      await ddl.query(`UPDATE "${SCHEMA}"."treasury_accounts" SET "createdAt" = $1::timestamptz - interval '1 day'`, [
        goLiveAt,
      ]);
      await scoped(() =>
        db.$transaction((tx) =>
          ledger.post(
            tx,
            [
              { accountId: safeLbp, currency: 'LBP', amount: new Prisma.Decimal(1_000_000) },
              { accountId: safeUsd, currency: 'USD', amount: new Prisma.Decimal(100) },
            ],
            { source: 'OPENING_BALANCE', sourceId: null, actorId: managerId, occurredAt: goLiveAt },
          ),
        ),
      );

      // D1: a counter payment into the safe, and a collector's round into his pocket.
      const counter = await invoice(250_000);
      await scoped(() =>
        payments.record({ audit, paymentId: counter, amount: 250_000, method: 'CASH', recordedById: managerId, occurredAt: at(D1) }),
      );
      const round = await invoice(150_000);
      await scoped(() =>
        payments.record({
          audit,
          paymentId: round,
          amount: 150_000,
          method: 'COLLECTOR',
          collectedById: collectorId,
          recordedById: managerId,
          occurredAt: at(D1),
        }),
      );

      // D3: only the collector moved. D4: an expense left the safe.
      const late = await invoice(75_000);
      await scoped(() =>
        payments.record({
          audit,
          paymentId: late,
          amount: 75_000,
          method: 'COLLECTOR',
          collectedById: collectorId,
          recordedById: managerId,
          occurredAt: at(D3),
        }),
      );
      await move(safeLbp, 'LBP', -40_000, at(D4), 'EXPENSE_VOUCHER');
    }, SETUP_TIMEOUT_MS);

    // ────────────────────────────────  counting  ────────────────────────────────

    describe('counting', () => {
      it('opens on the go-live day, with every counted wallet and its books', async () => {
        const current = await sheet();
        expect(current.goLiveOn).toBe(D0);
        expect(current.nextDayToClose).toBe(D0);
        expect(current.day).toMatchObject({ businessDate: D0, status: 'OPEN' });
        expect(current.lines.map((line) => [line.account.id, line.expectedAmount, line.count])).toEqual([
          [safeLbp, 1_000_000, null],
          [safeUsd, 100, null],
          [whishLbp, 0, null],
          [whishUsd, 0, null],
        ]);
        expect(current.closure).toEqual({ ok: false, code: 'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS', accounts: 4 });
      });

      it('never lists a collector’s custody among the wallets to count', async () => {
        const current = await sheet(D1);
        expect(current.lines.map((line) => line.account.type)).not.toContain('COLLECTOR_CUSTODY');
      });

      it('refuses a day to come, a day before go-live, and a collector’s custody, writing nothing', async () => {
        const custody = await db.treasuryAccount.findFirstOrThrow({ where: { ownerId: collectorId }, select: { id: true } });
        const record = (businessDate: string, accountId = safeLbp, expectedAmount = 0) =>
          scoped(() =>
            counts.record({ businessDate, counts: [{ accountId, expectedAmount, countedAmount: expectedAmount }] }, accountant()),
          );
        await expect(record(addDays(TODAY, 1))).rejects.toMatchObject({ code: 'COUNT_DATE_IN_FUTURE' });
        await expect(record(addDays(D0, -1))).rejects.toMatchObject({ code: 'DAY_BEFORE_GO_LIVE', params: { date: D0 } });
        await expect(record(D1, custody.id, 150_000)).rejects.toMatchObject({ code: 'TREASURY_ACCOUNT_NOT_FOUND' });
        expect(await db.treasuryCount.count()).toBe(0);
      });

      it('refuses a count made against a figure the books no longer hold', async () => {
        await expect(
          scoped(() =>
            counts.record(
              { businessDate: D0, counts: [{ accountId: safeLbp, expectedAmount: 900_000, countedAmount: 900_000 }] },
              accountant(),
            ),
          ),
        ).rejects.toMatchObject({ code: 'COUNT_EXPECTED_CHANGED', params: { count: 1 } });
      });

      it('refuses an unexplained difference, and writes none of the request', async () => {
        await expect(
          scoped(() =>
            counts.record(
              {
                businessDate: D0,
                counts: [
                  { accountId: safeUsd, expectedAmount: 100, countedAmount: 100 },
                  { accountId: safeLbp, expectedAmount: 1_000_000, countedAmount: 990_000 },
                ],
              },
              accountant(),
            ),
          ),
        ).rejects.toMatchObject({ code: 'COUNT_VARIANCE_REASON_REQUIRED', params: { account: 'صندوق النقد — ليرة' } });
        expect(await db.treasuryCount.count()).toBe(0);
      });

      it('records a shortage with its reason, moves no money, and files the audit row under the day', async () => {
        const before = await balance(safeLbp);
        const after = await countDay(D0, { [safeLbp]: { countedAmount: 990_000, varianceReason: 'ورقة ١٠ آلاف ناقصة' } });

        const line = after.lines.find((row) => row.account.id === safeLbp)!;
        expect(line.count).toMatchObject({
          expectedAmount: 1_000_000,
          countedAmount: 990_000,
          difference: -10_000,
          varianceReason: 'ورقة ١٠ آلاف ناقصة',
          countedByName: 'رنا المحاسبة',
          stale: false,
        });
        expect(await balance(safeLbp)).toBe(before);
        expect(after.closure).toEqual({ ok: true, sweeps: [] });

        const rows = await db.auditLogEntry.findMany({ where: { entityType: 'TreasuryDay', entityId: D0 } });
        expect(rows.map((row) => row.action)).toEqual(['TREASURY_COUNT_RECORDED']);
      });

      it('replaces a wallet’s count when it is counted again', async () => {
        await countDay(D0, { [safeLbp]: { countedAmount: 1_000_000, varianceReason: 'عُدّ مرة ثانية' } });
        const rows = await db.treasuryCount.findMany({ where: { accountId: safeLbp } });
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.difference)).toBe(0);
        expect(rows[0]!.varianceReason).toBe('عُدّ مرة ثانية');
      });
    });

    // ────────────────────────────────  closing  ────────────────────────────────

    describe('closing', () => {
      it('refuses today: only a day that has ended closes', async () => {
        await expect(close(TODAY)).rejects.toMatchObject({ code: 'DAY_NOT_OVER' });
      });

      it('refuses a later day while an earlier one with movement is open', async () => {
        await expect(close(D1)).rejects.toMatchObject({
          code: 'UNRESOLVED_ACTIVE_DAYS_EXIST',
          params: { date: D0, count: 1 },
        });
      });

      it('refuses a count the books moved past after it was taken, until it is recounted', async () => {
        await move(safeUsd, 'USD', 5, new Date(`${D0}T15:00:00.000Z`));
        expect((await sheet(D0)).lines.find((line) => line.account.id === safeUsd)!.count!.stale).toBe(true);
        await expect(close(D0)).rejects.toMatchObject({ code: 'COUNT_EXPECTED_CHANGED', params: { count: 1 } });
        await countDay(D0);
      });

      it('closes the go-live day, linking its counts and auditing the figures', async () => {
        const result = await close(D0);
        expect(result).toMatchObject({ businessDate: D0, sweptDays: [] });

        const closure = await db.treasuryDayClosure.findFirstOrThrow({ select: { id: true, status: true, autoClosed: true } });
        expect(closure).toMatchObject({ status: 'CLOSED', autoClosed: false });
        const linked = await db.treasuryCount.findMany({ where: { closureId: closure.id } });
        expect(linked).toHaveLength(4);

        const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'TREASURY_DAY_CLOSED', entityId: D0 } });
        expect((row.after as { counts: unknown[] }).counts).toHaveLength(4);
        expect(row.actorId).toBe(accountantId);
      });

      it('refuses anything dated on the closed day — through the ledger, the payment path and the database', async () => {
        await expect(move(safeLbp, 'LBP', 1_000, at(D0))).rejects.toMatchObject({
          code: 'CLOSED_DAY_MUTATION_BLOCKED',
          params: { date: D0 },
        });

        // A collector's round back-dated into it: refused before a receipt is drawn, and nothing written.
        const bill = await invoice(30_000);
        const receiptsBefore = await db.paymentTransaction.count();
        await expect(
          scoped(() =>
            payments.record({
              audit,
              paymentId: bill,
              amount: 30_000,
              method: 'COLLECTOR',
              collectedById: collectorId,
              recordedById: managerId,
              occurredAt: at(D0),
            }),
          ),
        ).rejects.toMatchObject({ code: 'CLOSED_DAY_MUTATION_BLOCKED' });
        expect(await db.paymentTransaction.count()).toBe(receiptsBefore);
        expect((await db.citizenPayment.findUniqueOrThrow({ where: { id: bill } })).paymentStatus).toBe('UNPAID');

        // The trigger underneath, as Prisma reports it — and the mapper that reads it back.
        const refused = await db.treasuryEntry
          .create({ data: { accountId: safeLbp, currency: 'LBP', amount: 1, source: 'ADJUSTMENT', occurredAt: at(D0) } })
          .then(
            () => null,
            (error: unknown) => error,
          );
        expect(refused).toBeInstanceOf(Error);
        expect(closedTreasuryDay(refused)).toBe(D0);

        // Today is open, so the counter keeps working.
        const today = await invoice(10_000);
        await expect(
          scoped(() => payments.record({ audit, paymentId: today, amount: 10_000, method: 'CASH', recordedById: managerId })),
        ).resolves.toMatchObject({ paymentStatus: 'PAID' });
      });

      it('locks the closed day’s counts, except against a recount through the service', async () => {
        await expect(
          scoped(() =>
            counts.record(
              { businessDate: D0, counts: [{ accountId: safeLbp, expectedAmount: 1_000_000, countedAmount: 1_000_000 }] },
              accountant(),
            ),
          ),
        ).rejects.toMatchObject({ code: 'DAY_ALREADY_CLOSED' });
        await expect(
          ddl.query(`UPDATE "${SCHEMA}"."treasury_counts" SET "varianceReason" = 'x' WHERE "accountId" = $1`, [safeLbp]),
        ).rejects.toThrow(/treasury day .* is closed/);
        await expect(
          ddl.query(`DELETE FROM "${SCHEMA}"."treasury_counts" WHERE "accountId" = $1`, [safeLbp]),
        ).rejects.toThrow(/treasury day .* is closed/);
      });

      it('closes D1, then sweeps the quiet D2 and the custody-only D3 when D4 closes', async () => {
        expect((await sheet()).nextDayToClose).toBe(D1);
        await countDay(D1);
        await close(D1);

        expect((await sheet()).nextDayToClose).toBe(D4);
        await countDay(D4);
        const preview = await sheet(D4);
        expect(preview.closure).toEqual({ ok: true, sweeps: [D2, D3] });

        const result = await close(D4);
        expect(result.sweptDays).toEqual([D2, D3]);

        const days = await db.treasuryDayClosure.findMany({
          orderBy: { businessDate: 'asc' },
          select: { businessDate: true, status: true, autoClosed: true },
        });
        expect(days.map((day) => [day.businessDate.toISOString().slice(0, 10), day.status, day.autoClosed])).toEqual([
          [D0, 'CLOSED', false],
          [D1, 'CLOSED', false],
          [D2, 'CLOSED', true],
          [D3, 'CLOSED', true],
          [D4, 'CLOSED', false],
        ]);
        expect(
          await db.auditLogEntry.count({ where: { action: 'TREASURY_DAY_AUTO_CLOSED', entityId: { in: [D2, D3] } } }),
        ).toBe(2);

        // A swept day is locked like any other.
        await expect(move(safeLbp, 'LBP', 500, at(D3))).rejects.toMatchObject({ code: 'CLOSED_DAY_MUTATION_BLOCKED' });
      });

      it('refuses a day already closed, swept or not', async () => {
        await expect(close(D4)).rejects.toMatchObject({ code: 'DAY_ALREADY_CLOSED' });
        await expect(close(D2)).rejects.toMatchObject({ code: 'DAY_ALREADY_CLOSED' });
      });
    });

    // ───────────────────────────────  reopening  ────────────────────────────────

    describe('reopening', () => {
      const reason = 'سند صرف سُجّل بمبلغ خاطئ';

      it('refuses an older day, a day that is not closed, and a reason too short to keep', async () => {
        const reopen = (businessDate: string, why = reason) =>
          scoped(() => closures.reopen({ businessDate, reason: why }, manager()));
        await expect(reopen(D1)).rejects.toMatchObject({
          code: 'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED',
          params: { date: D4 },
        });
        await expect(reopen(D5)).rejects.toMatchObject({ code: 'DAY_NOT_CLOSED' });
        await expect(reopen(D4, 'خطأ')).rejects.toMatchObject({ code: 'REOPEN_REASON_REQUIRED' });
      });

      it('reopens the latest day, which then takes entries while the day before stays shut', async () => {
        const state = await scoped(() => closures.reopen({ businessDate: D4, reason }, manager()));
        expect(state).toMatchObject({ businessDate: D4, status: 'REOPENED', reopenReason: reason, reopenedByName: 'المدير العام' });

        await move(safeLbp, 'LBP', -5_000, at(D4), 'EXPENSE_VOUCHER');
        await expect(move(safeLbp, 'LBP', 500, at(D3))).rejects.toMatchObject({ code: 'CLOSED_DAY_MUTATION_BLOCKED' });

        const current = await sheet();
        expect(current.nextDayToClose).toBe(D4);
        expect(current.reopenable).toBe(false);
      });

      it('holds every later day until the reopened one is closed again', async () => {
        await expect(close(D5)).rejects.toMatchObject({ code: 'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER', params: { date: D4 } });
      });

      it('closes the reopened day again, once its stale count is redone', async () => {
        await expect(close(D4)).rejects.toMatchObject({ code: 'COUNT_EXPECTED_CHANGED' });
        await countDay(D4);
        await close(D4);

        const row = await db.treasuryDayClosure.findFirstOrThrow({ where: { status: 'CLOSED', autoClosed: false }, orderBy: { businessDate: 'desc' } });
        expect(row).toMatchObject({ reopenedAt: null, reopenedById: null, reopenReason: null });
        expect((await sheet(D4)).reopenable).toBe(true);
      });
    });

    // ─────────────────────────────  the day's report  ───────────────────────────

    describe('the daily cash report', () => {
      it('adds up each wallet’s day, keeps custody apart, and shows the count', async () => {
        const report = await scoped(() => reports.daily(D1, accountantId));
        expect(report.day).toMatchObject({ businessDate: D1, status: 'CLOSED', closedByName: 'رنا المحاسبة' });
        expect(report.generatedByName).toBe('رنا المحاسبة');

        const safe = report.wallets.find((wallet) => wallet.account.id === safeLbp)!;
        expect(safe).toMatchObject({
          openingBalance: 1_000_000,
          receipts: 250_000,
          payments: 0,
          closingBalance: 1_250_000,
          movements: 1,
          bySource: [{ source: 'CITIZEN_PAYMENT', receipts: 250_000, payments: 0 }],
        });
        expect(safe.count).toMatchObject({ countedAmount: 1_250_000, difference: 0, stale: false });

        expect(report.custody).toEqual([
          {
            collectorId,
            collectorName: 'حسن الجابي',
            currency: 'LBP',
            receipts: 150_000,
            payments: 0,
            heldAtClose: 150_000,
          },
        ]);
        expect(report.custodyTotals).toEqual([{ currency: 'LBP', heldAtClose: 150_000 }]);

        const lbp = report.totals.find((total) => total.currency === 'LBP')!;
        expect(lbp).toMatchObject({ openingBalance: 1_000_000, receipts: 250_000, closingBalance: 1_250_000, counted: 1_250_000, difference: 0 });
      });

      it('tells the day’s history, the reopening and its reason included', async () => {
        const report = await scoped(() => reports.daily(D4, accountantId));
        expect(report.timeline.map((event) => event.action)).toEqual([
          'TREASURY_COUNT_RECORDED',
          'TREASURY_DAY_CLOSED',
          'TREASURY_DAY_REOPENED',
          'TREASURY_COUNT_RECORDED',
          'TREASURY_DAY_CLOSED',
        ]);
        expect(report.timeline[2]).toMatchObject({ actorName: 'المدير العام', reason: 'سند صرف سُجّل بمبلغ خاطئ' });

        const safe = report.wallets.find((wallet) => wallet.account.id === safeLbp)!;
        expect(safe).toMatchObject({ payments: 45_000, bySource: [{ source: 'EXPENSE_VOUCHER', receipts: 0, payments: 45_000 }] });

        // D3's custody money is still in the collector's pocket at the end of D4.
        expect(report.custody[0]).toMatchObject({ receipts: 0, heldAtClose: 225_000 });
      });

      it('reports a swept day as closed by the day that swept it, with no count', async () => {
        const report = await scoped(() => reports.daily(D2, managerId));
        expect(report.day).toMatchObject({ status: 'CLOSED', autoClosed: true });
        expect(report.wallets.every((wallet) => wallet.count === null && wallet.movements === 0)).toBe(true);
      });
    });

    // ──────────────────────────────  under a race  ──────────────────────────────

    describe('under a race', () => {
      it('waits for a write already landing in the day, then judges the count against it', async () => {
        await move(safeLbp, 'LBP', 20_000, at(D5), 'INCOME_VOUCHER');
        await countDay(D5);

        // An entry in D5 that has not committed yet.
        await ddl.query('BEGIN');
        await ddl.query(
          `INSERT INTO "${SCHEMA}"."treasury_entries" ("accountId", "currency", "amount", "source", "occurredAt")
           VALUES ($1, 'LBP', 7000, 'INCOME_VOUCHER', $2)`,
          [safeLbp, at(D5)],
        );

        let settled = false;
        const closing = close(D5).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(settled).toBe(false);

        await ddl.query('COMMIT');
        await expect(closing).rejects.toMatchObject({ code: 'COUNT_EXPECTED_CHANGED' });
      });

      it('lets one of two simultaneous closes through, and refuses the other', async () => {
        await countDay(D5);
        const outcomes = await Promise.allSettled([close(D5), close(D5)]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        const refused = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
        expect(refused.reason).toMatchObject({ code: 'DAY_ALREADY_CLOSED' });
        expect(await db.treasuryDayClosure.count({ where: { status: 'CLOSED' } })).toBe(6);
      });

      it('leaves nothing to close once yesterday is closed, and offers today', async () => {
        const current = await sheet();
        expect(current.closedThrough).toBe(D5);
        expect(current.nextDayToClose).toBe(TODAY);
        expect(current.closure).toEqual({ ok: false, code: 'DAY_NOT_OVER' });
      });
    });
  });
});
