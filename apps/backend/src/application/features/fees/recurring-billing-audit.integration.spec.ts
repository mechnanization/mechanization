import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import type { RedisCacheService } from '../../../infrastructure/cache/redis-cache.service';
import type { WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { AuditService } from '../audit/audit.service';
import { FeesService } from './fees.service';
import type { PaymentLedgerService } from './payment-ledger.service';

/**
 * The recurring biller's audit row, against real Postgres (audit item M6).
 *
 * `fee.issued` from a scheduled run carries no actor, and `AuditService`
 * wrote `actorId: 'SYSTEM'` into a uuid column. The insert was refused and
 * `write` swallowed the refusal («AUDIT WRITE FAILED»), so no
 * `FEE_RECURRING_ISSUED` row had ever been written. A mocked repository cannot
 * see that: only the column's type refuses it.
 *
 * The run's event is captured and handed to the real listener, so this pins
 * both halves: what `runRecurringBilling` emits, and what the trail keeps.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_recurring_audit_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('the recurring billing audit row', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let audit: AuditService;
  let emit: jest.Mock;
  let accountantId: string;
  let noticeId: string;

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'recurring', schemaName: SCHEMA, prisma: db }, work);

  /** Hands each `fee.issued` the run emitted to the trail's own listener, and waits for it. */
  const deliverIssued = async (): Promise<void> => {
    const issued = emit.mock.calls.filter(([channel]) => channel === 'fee.issued').map(([, payload]) => payload);
    emit.mockClear();
    for (const payload of issued) await scoped(() => audit.onFeeIssued(payload));
  };

  const rowsFor = (periodKey: string) =>
    db.auditLogEntry
      .findMany({ where: { action: 'FEE_RECURRING_ISSUED', entityId: noticeId } })
      .then((rows) => rows.filter((row) => (row.after as { periodKey?: string } | null)?.periodKey === periodKey));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    emit = jest.fn();
    fees = new FeesService(
      context,
      { emit } as unknown as EventEmitter2,
      {} as WhishGateway,
      {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue(undefined),
        invalidatePrefix: jest.fn().mockResolvedValue(undefined),
      } as unknown as RedisCacheService,
      {} as PaymentLedgerService,
      audit,
    );

    accountantId = randomUUID();
    await db.user.createMany({
      data: [
        {
          id: accountantId,
          kind: 'STAFF',
          tenantSlug: 'recurring',
          email: `accountant-${accountantId}@recurring.gov.lb`,
          firstName: 'محاسب',
          lastName: 'البلدية',
          role: 'ACCOUNTANT',
        },
        { id: randomUUID(), kind: 'CITIZEN', tenantSlug: 'recurring', firstName: 'سمير', lastName: 'الحاج' },
        { id: randomUUID(), kind: 'CITIZEN', tenantSlug: 'recurring', firstName: 'ليلى', lastName: 'الحاج' },
      ],
    });

    // A monthly flat fee first due in January: every later month is a period to bill.
    noticeId = (
      await db.feeNotice.create({
        data: {
          title: 'رسم النفايات الشهري',
          amount: 50_000,
          basis: 'FLAT',
          frequency: 'MONTHLY',
          targetType: 'ALL_CITIZENS',
          dueDate: new Date('2026-01-15T00:00:00.000Z'),
        },
        select: { id: true },
      })
    ).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it("writes the scheduled run's row as the system's, with no actor", async () => {
    const result = await scoped(() => fees.runRecurringBilling(new Date('2026-03-10T09:00:00.000Z')));
    expect(result.invoicesCreated).toBe(2);
    await deliverIssued();

    const rows = await rowsFor('2026-03');
    expect(rows).toHaveLength(1);
    // NULL, not a placeholder: the daily report tells system rows apart by `actorId IS NULL`.
    expect(rows[0]).toMatchObject({ actorId: null, actorType: 'SYSTEM', actorRole: null });
    expect(rows[0]!.after).toMatchObject({ issuedCount: 2, periodKey: '2026-03' });
  });

  it('writes a run started from the fees page under the staff member who pressed it', async () => {
    const result = await scoped(() =>
      fees.runRecurringBilling(new Date('2026-04-10T09:00:00.000Z'), { id: accountantId, role: 'ACCOUNTANT' }),
    );
    expect(result.invoicesCreated).toBe(2);
    await deliverIssued();

    const rows = await rowsFor('2026-04');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorId: accountantId, actorType: 'STAFF', actorRole: 'ACCOUNTANT' });
  });
});
