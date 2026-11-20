import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { CreateFeeNotice } from '@mechanization/shared-schemas';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { FeesService } from './fees.service';
import { PaymentLedgerService } from './payment-ledger.service';

/**
 * The duplicate notice guard (finding F11 of the 2026-11-14 billing audit,
 * task B8) against a real Postgres.
 *
 * The retry key protects one press of «إصدار». Two issuers, or one in two
 * tabs, carried two keys, created two notices and billed the town twice. An
 * active notice with the same basis, target, frequency and period is now
 * listed by the preview and refuses the issue until it is confirmed by id; two
 * issuers racing meet on the issue lock, and the second is refused.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_notice_duplicate_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('the duplicate notice guard', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  const managerId = randomUUID();
  const manager = { id: managerId, role: 'SUPER_ADMIN' };
  const citizens = [randomUUID(), randomUUID()];

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-dup', tenantSlug: 'dup', schemaName: SCHEMA, prisma: db }, work);

  const today = new Date();
  const thisMonth = today.toISOString().slice(0, 10);
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 15)).toISOString().slice(0, 10);

  /** A flat monthly cleaning fee to everyone, as a second issuer would type it. */
  const notice = (overrides: Partial<CreateFeeNotice> = {}): CreateFeeNotice =>
    ({
      title: 'رسم النظافة',
      amount: 50_000,
      basis: 'FLAT',
      bearer: 'OCCUPANT',
      frequency: 'MONTHLY',
      targetType: 'ALL_CITIZENS',
      dueDate: thisMonth,
      clientRequestId: randomUUID(),
      ...overrides,
    }) as CreateFeeNotice;

  /**
   * The notice's `FEE_ISSUED` row, once it is written. It is a Tier 2 row: the
   * listener runs after `issue` returns and nothing awaits it, so reading at once
   * races the write. Waits up to five seconds; null if it never arrives.
   */
  const issuedRowFor = async (noticeId: string) => {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const row = await db.auditLogEntry.findFirst({ where: { action: 'FEE_ISSUED', entityId: noticeId } });
      if (row || Date.now() > deadline) return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const refusal = async (call: Promise<unknown>) => {
    try {
      await call;
    } catch (error) {
      return error as { code?: string; params?: Record<string, unknown>; details?: { duplicates?: Array<{ id: string }> } };
    }
    throw new Error('expected the issue to be refused');
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    // `fee.issued` is a Tier 2 row: wired by hand here, as `@OnEvent` is in the app.
    const events = new EventEmitter2();
    events.on('fee.issued', (payload) => audit.onFeeIssued(payload));
    fees = new FeesService(
      context,
      events,
      {} as never,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as never,
      new PaymentLedgerService(context, audit, new TreasuryLedgerService(context)),
      audit,
    );

    await db.user.create({
      data: {
        id: managerId,
        kind: 'STAFF',
        tenantSlug: 'dup',
        email: `manager-${managerId}@dup.gov.lb`,
        firstName: 'رئيس',
        lastName: 'البلدية',
        role: 'SUPER_ADMIN' as never,
      },
    });
    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, baseCurrency: 'LBP', secondaryCurrency: 'USD', exchangeRate: 89_500 },
      update: {},
    });
    for (const [index, id] of citizens.entries()) {
      await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'dup', firstName: `مواطن${index}`, lastName: 'الاختبار' } });
    }
  }, SETUP_TIMEOUT_MS);

  // Each case starts with no active notice, so one case's notice is never another's duplicate.
  afterEach(async () => {
    await db.feeNotice.updateMany({ data: { isActive: false } });
  });

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('refuses a second notice issued under another key, naming the first, and writes nothing', async () => {
    const first = await within(() => fees.issue(notice(), manager));
    const [notices, bills] = [await db.feeNotice.count(), await db.citizenPayment.count()];

    const refused = await refusal(within(() => fees.issue(notice({ title: 'رسوم النظافة' }), manager)));

    expect(refused.code).toBe('FEE_NOTICE_DUPLICATE');
    expect(refused.params).toMatchObject({ title: 'رسم النظافة', count: 1 });
    expect(refused.details?.duplicates?.map((duplicate) => duplicate.id)).toEqual([first.noticeId]);
    expect(await db.feeNotice.count()).toBe(notices);
    expect(await db.citizenPayment.count()).toBe(bills);
  });

  it('lists the duplicate in the preview, with the period’s bills', async () => {
    const first = await within(() => fees.issue(notice(), manager));

    const { clientRequestId: _key, ...asked } = notice();
    const preview = await within(() => fees.previewNotice(asked));

    expect(preview.duplicates).toEqual([
      expect.objectContaining({ id: first.noticeId, title: 'رسم النظافة', amount: 50_000, billCount: citizens.length }),
    ]);
  });

  it('issues once the duplicate is confirmed by id, and records the confirmation', async () => {
    const first = await within(() => fees.issue(notice(), manager));

    const second = await within(() =>
      fees.issue(notice({ title: 'رسم الإنارة', acknowledgedDuplicates: [first.noticeId.toUpperCase()] }), manager),
    );

    expect(second.issued).toBe(citizens.length);
    const row = await issuedRowFor(second.noticeId);
    expect(row?.after).toMatchObject({ duplicatesConfirmed: [first.noticeId] });
  });

  it('does not take a confirmation of another notice for this one', async () => {
    await within(() => fees.issue(notice(), manager));

    const refused = await refusal(
      within(() => fees.issue(notice({ acknowledgedDuplicates: [randomUUID()] }), manager)),
    );

    expect(refused.code).toBe('FEE_NOTICE_DUPLICATE');
  });

  it.each([
    ['another period', { dueDate: nextMonth }],
    ['another basis', { basis: 'PER_UNIT' as const, amount: 10_000 }],
    ['another frequency', { frequency: 'ANNUALLY' as const }],
  ])('is not a duplicate in %s', async (_case, overrides) => {
    await within(() => fees.issue(notice(), manager));

    // Issued, or refused for a reason of its own (a per-unit fee on people with no units bills nobody) — never as a duplicate.
    const outcome = await within(() => fees.issue(notice(overrides as Partial<CreateFeeNotice>), manager)).then(
      () => 'issued',
      (error: { code?: string }) => error.code,
    );
    expect(outcome).not.toBe('FEE_NOTICE_DUPLICATE');
  });

  it('is not a duplicate of a stopped notice', async () => {
    const first = await within(() => fees.issue(notice(), manager));
    await db.feeNotice.update({ where: { id: first.noticeId }, data: { isActive: false } });

    await expect(within(() => fees.issue(notice(), manager))).resolves.toMatchObject({ issued: citizens.length });
  });

  it('compares one-off notices by the month they are due in', async () => {
    await within(() => fees.issue(notice({ frequency: 'ONCE', dueDate: thisMonth }), manager));

    const sameMonth = await refusal(within(() => fees.issue(notice({ frequency: 'ONCE', dueDate: thisMonth }), manager)));
    expect(sameMonth.code).toBe('FEE_NOTICE_DUPLICATE');
    await expect(
      within(() => fees.issue(notice({ frequency: 'ONCE', dueDate: nextMonth }), manager)),
    ).resolves.toMatchObject({ issued: citizens.length });
  });

  it('lets one of two issuers racing with two keys win, and refuses the other', async () => {
    const outcomes = await Promise.allSettled([
      within(() => fees.issue(notice(), manager)),
      within(() => fees.issue(notice(), manager)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const lost = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    expect((lost?.reason as { code?: string }).code).toBe('FEE_NOTICE_DUPLICATE');
    expect(await db.feeNotice.count({ where: { isActive: true } })).toBe(1);
  });
});
