import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { municipalToday } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ReportingService } from '../reporting/reporting.service';
import { TreasuryLedgerService } from '../treasury/treasury-ledger.service';
import { CitizenRequestsService } from '../citizen-requests/citizen-requests.service';
import { TreasuryService } from '../treasury/treasury.service';
import { FeesService } from './fees.service';
import { ParcelDuesService } from './parcel-dues.service';
import { PaymentLedgerService } from './payment-ledger.service';
import { PaymentSettlementService } from './payment-settlement.service';

/**
 * «شطب» (0107/0108, docs/old-debts-plan.md decision 10, docs/finance.md §3.8),
 * against a real Postgres: what is left on a bill is forgiven on a council
 * decision, every refusal says why in a code, and every read that counts what
 * is owed leaves a written-off bill out, as it leaves out a cancelled one.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_bill_write_off_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('«شطب»: writing off what is left on a bill', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let fees: FeesService;
  let payments: PaymentLedgerService;
  let settlements: PaymentSettlementService;
  let reporting: ReportingService;
  let parcelDues: ParcelDuesService;
  let requests: CitizenRequestsService;

  let citizenId: string;
  const ids = { manager: '', clerk: '' };
  const MANAGER = () => ({ id: ids.manager, role: 'SUPER_ADMIN' });
  const DECISION = { reason: 'عفو عن رسوم ما قبل 2020', decisionRef: '45/2026', decisionDate: '2026-11-01' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'write-off', schemaName: SCHEMA, prisma: db }, work);

  const bill = async (
    amount: number,
    extra: { status?: 'UNPAID' | 'PENDING_REVIEW'; propertyNumber?: string } = {},
  ): Promise<string> =>
    (
      await db.citizenPayment.create({
        data: {
          citizenId,
          title: 'رسم',
          amount,
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          createdAt: new Date('2026-01-01T08:00:00.000Z'),
          paymentStatus: extra.status ?? 'UNPAID',
          ...(extra.propertyNumber
            ? {
                assessment: {
                  basis: 'PER_AREA',
                  rate: 1000,
                  unitCount: 1,
                  totalArea: amount / 1000,
                  excludedUnitCount: 0,
                  heldUnitCount: 0,
                  uninhabitableUnitCount: 0,
                  lines: [{ propertyNumber: extra.propertyNumber, propertyType: 'LAND', unitType: 'APARTMENT', unitArea: amount / 1000 }],
                } as never,
              }
            : {}),
        },
        select: { id: true },
      })
    ).id;

  const cash = (paymentId: string, amount: number) =>
    scoped(() =>
      fees.settleInPerson({ paymentId, method: 'CASH', amount, clientRequestId: randomUUID(), actor: MANAGER() }),
    );

  const writeOff = (paymentId: string, input: Partial<typeof DECISION> = {}) =>
    scoped(() => fees.writeOffBill(paymentId, { ...DECISION, ...input }, MANAGER()));

  const onProfile = async () => (await scoped(() => reporting.getCitizenProfile(citizenId)))!;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const auditService = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    const ledger = new TreasuryLedgerService(context);
    payments = new PaymentLedgerService(context, auditService, ledger);
    const treasury = new TreasuryService(context, ledger, auditService);
    const cache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      invalidatePrefix: jest.fn().mockResolvedValue(undefined),
    } as never;
    fees = new FeesService(context, { emit: jest.fn() } as unknown as EventEmitter2, {} as never, cache, payments, auditService);
    settlements = new PaymentSettlementService(context, new EventEmitter2(), payments, auditService, ledger);
    reporting = new ReportingService(context, new EventEmitter2(), cache, { get: () => undefined } as never);
    parcelDues = new ParcelDuesService(context);
    requests = new CitizenRequestsService(
      context,
      auditService,
      parcelDues,
      new EventEmitter2(),
      {} as never,
      { isLive: false } as never,
    );

    citizenId = randomUUID();
    ids.manager = randomUUID();
    ids.clerk = randomUUID();
    await db.user.createMany({
      data: [
        { id: citizenId, kind: 'CITIZEN', tenantSlug: 'write-off', firstName: 'علي', lastName: 'خليل', phone: '71123456' },
        ...[
          [ids.manager, 'SUPER_ADMIN'],
          [ids.clerk, 'ADMINISTRATIVE_OFFICER'],
        ].map(([id, role]) => ({
          id: id!,
          kind: 'STAFF' as const,
          tenantSlug: 'write-off',
          email: `${role!.toLowerCase()}-${id}@write-off.gov.lb`,
          firstName: role!,
          lastName: 'الموظف',
          role: role as never,
        })),
      ],
    });

    await db.systemSettings.upsert({
      where: { singleton: true },
      create: { singleton: true, baseCurrency: 'LBP' },
      update: { baseCurrency: 'LBP' },
    });
    const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
    await scoped(() =>
      treasury.activate({ balances: accounts.map((account) => ({ accountId: account.id, amount: 0 })) }, MANAGER()),
    );
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  describe('the write-off', () => {
    it('writes off a whole unpaid bill, once, with the decision, and moves no money', async () => {
      const paymentId = await bill(60_000);
      const entriesBefore = await db.treasuryEntry.count();

      await expect(writeOff(paymentId)).resolves.toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
        remaining: 0,
        paidAmount: 0,
        writeOff: { amount: 60_000, ...DECISION },
      });
      expect(await db.citizenPayment.findUniqueOrThrow({ where: { id: paymentId } })).toMatchObject({
        writtenOffById: ids.manager,
        writeOffReason: DECISION.reason,
        writeOffDecisionRef: DECISION.decisionRef,
      });
      // No money moved: no receipt, no wallet entry.
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(0);
      expect(await db.treasuryEntry.count()).toBe(entriesBefore);
      const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'FEE_BILL_WRITTEN_OFF', entityId: paymentId } });
      expect(row).toMatchObject({
        actorId: ids.manager,
        before: { paymentStatus: 'UNPAID', paidAmount: 0 },
        after: { writeOffAmount: 60_000, decisionRef: DECISION.decisionRef, decisionDate: DECISION.decisionDate },
      });

      await expect(writeOff(paymentId)).rejects.toMatchObject({ code: 'BILL_ALREADY_WRITTEN_OFF' });
      expect(await db.auditLogEntry.count({ where: { action: 'FEE_BILL_WRITTEN_OFF', entityId: paymentId } })).toBe(1);
    });

    it('writes off only the rest of a part-paid bill, and its receipt stays', async () => {
      const paymentId = await bill(100_000);
      await cash(paymentId, 30_000);

      await expect(writeOff(paymentId)).resolves.toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
        paidAmount: 30_000,
        remaining: 0,
        writeOff: { amount: 70_000 },
      });
      expect(await db.paymentTransaction.count({ where: { paymentId } })).toBe(1);
    });

    it('refuses a paid bill, a cancelled one and one with a claim waiting, and writes nothing', async () => {
      const paid = await bill(20_000);
      await cash(paid, 20_000);
      await expect(writeOff(paid)).rejects.toMatchObject({ code: 'BILL_WRITE_OFF_NOTHING_LEFT' });

      const cancelled = await bill(20_000);
      await scoped(() => fees.cancelBill(cancelled, 'صدر الرسم مرتين', MANAGER()));
      await expect(writeOff(cancelled)).rejects.toMatchObject({ code: 'BILL_ALREADY_CANCELLED' });

      const claimed = await bill(20_000, { status: 'PENDING_REVIEW' });
      await expect(writeOff(claimed)).rejects.toMatchObject({ code: 'PAYMENT_CLAIM_UNDER_REVIEW' });

      expect(
        await db.citizenPayment.count({ where: { id: { in: [paid, cancelled, claimed] }, writtenOffAt: { not: null } } }),
      ).toBe(0);
    });

    it('refuses a council decision dated after today', async () => {
      const paymentId = await bill(20_000);
      const tomorrow = new Date(`${municipalToday()}T12:00:00.000Z`);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      await expect(writeOff(paymentId, { decisionDate: tomorrow.toISOString().slice(0, 10) })).rejects.toMatchObject({
        code: 'BILL_WRITE_OFF_DECISION_IN_FUTURE',
        params: { today: municipalToday() },
      });
      await expect(writeOff(paymentId, { decisionDate: municipalToday() })).resolves.toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
      });
    });

    /** A request waiting on a bill of this size, as the counter files it. */
    const requestOn = async (paymentId: string, requestType: 'RESIDENCY' | 'OTHER' = 'RESIDENCY') => {
      const request = await db.citizenRequest.create({
        data: {
          requestNumber: `REQ-${randomUUID().slice(0, 8)}`,
          citizenId,
          channel: 'COUNTER',
          requestType,
          applicantCapacity: 'OWNER',
          createdById: ids.clerk,
          clientRequestId: randomUUID(),
        },
      });
      await db.citizenRequest.update({ where: { id: request.id }, data: { citizenPaymentId: paymentId } });
      return request;
    };

    it('writes off a municipal request’s fee, and the request goes on to review: nothing is left to pay', async () => {
      const paymentId = await bill(50_000);
      const request = await requestOn(paymentId);

      await expect(writeOff(paymentId)).resolves.toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
        settledRequest: { requestId: request.id, requestNumber: request.requestNumber },
      });
      const after = await db.citizenRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(after).toMatchObject({ status: 'IN_REVIEW', citizenPaymentId: paymentId });
      // The CHECK wants a stamp on a billed request in review: it is when the fee stopped being owed.
      expect(after.paidAt).not.toBeNull();
      const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_FEE_WRITTEN_OFF', entityId: request.id } });
      expect(row).toMatchObject({
        actorId: ids.manager,
        before: { status: 'AWAITING_PAYMENT' },
        after: { status: 'IN_REVIEW', cause: 'BILL_WRITTEN_OFF', citizenPaymentId: paymentId },
      });
      // No payment was recorded: the request was not «paid».
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_PAID', entityId: request.id } })).toBe(0);
    });

    it('heals a request the write-off could not reach, and never sends it back to waiting for payment', async () => {
      const paymentId = await bill(50_000);
      // One open request per type for a citizen: the first test's is still open.
      const request = await requestOn(paymentId, 'OTHER');
      // As if the request's move had been lost: the bill is written off by the database's own rules, the request not touched.
      await db.citizenPayment.update({
        where: { id: paymentId },
        data: {
          paymentStatus: 'WRITTEN_OFF',
          writtenOffAt: new Date(),
          writtenOffById: ids.manager,
          writeOffAmount: 50_000,
          writeOffReason: 'عفو',
          writeOffDecisionRef: '7/2026',
          writeOffDecisionDate: new Date('2026-11-01'),
        },
      });
      await scoped(() => requests.reconcile({ requestIds: [request.id] }));
      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'IN_REVIEW' });
      const row = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_FEE_WRITTEN_OFF', entityId: request.id } });
      expect(row).toMatchObject({ actorType: 'SYSTEM' });

      // A second read changes nothing: the written-off bill is not "not paid".
      await scoped(() => requests.reconcile({ requestIds: [request.id] }));
      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: request.id } })).toMatchObject({ status: 'IN_REVIEW' });
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_FEE_WRITTEN_OFF', entityId: request.id } })).toBe(1);
    });

    it('is held by the database too: what is written off is exactly what was left', async () => {
      const paymentId = await bill(40_000);
      await expect(
        db.citizenPayment.update({
          where: { id: paymentId },
          data: {
            paymentStatus: 'WRITTEN_OFF',
            writtenOffAt: new Date(),
            writtenOffById: ids.manager,
            writeOffAmount: 10_000,
            writeOffReason: 'تجاوز',
            writeOffDecisionRef: '1/2026',
            writeOffDecisionDate: new Date('2026-11-01'),
          },
        }),
      ).rejects.toThrow(/citizen_payments_write_off_amount/);
    });
  });

  describe('a written-off bill takes nothing', () => {
    let partPaid: string;
    let receiptId: string;

    beforeAll(async () => {
      partPaid = await bill(90_000);
      await cash(partPaid, 10_000);
      receiptId = (await db.paymentTransaction.findFirstOrThrow({ where: { paymentId: partPaid } })).id;
      await writeOff(partPaid);
    });

    it('refuses a counter payment', async () => {
      await expect(cash(partPaid, 80_000)).rejects.toMatchObject({ code: 'PAYMENT_BILL_WRITTEN_OFF' });
    });

    it('refuses a settlement of several bills that includes it', async () => {
      const other = await bill(5_000);
      await expect(
        scoped(() =>
          settlements.settle(
            {
              citizenId,
              paymentIds: [partPaid, other],
              method: 'WHISH_MONEY',
              whishTransactionRef: `WSH-${randomUUID().slice(0, 8)}`,
              expectedDue: [{ currency: 'LBP', amount: 85_000 }],
              clientRequestId: randomUUID(),
            } as never,
            MANAGER(),
          ),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_BILL_WRITTEN_OFF' });
    });

    it('refuses a citizen’s claim', async () => {
      await expect(
        scoped(() =>
          fees.declare({ paymentId: partPaid, citizenId, method: 'WHISH_MONEY', whishTransactionRef: 'WSH-WO-CLAIM' }),
        ),
      ).rejects.toMatchObject({ code: 'PAYMENT_BILL_WRITTEN_OFF' });
    });

    it('refuses «إلغاء الفاتورة»: the debt was real', async () => {
      const whole = await bill(15_000);
      await writeOff(whole);
      await expect(scoped(() => fees.cancelBill(whole, 'خطأ في الإصدار', MANAGER()))).rejects.toMatchObject({
        code: 'BILL_ALREADY_WRITTEN_OFF',
      });
    });

    it('refuses reversing a receipt on it while the write-off stands', async () => {
      await expect(
        scoped(() => fees.reverseTransaction({ transactionId: receiptId, note: 'وصل بالخطأ', actor: MANAGER() })),
      ).rejects.toMatchObject({ code: 'PAYMENT_REVERSAL_BILL_WRITTEN_OFF' });
      expect(await db.paymentTransaction.count({ where: { reversalOfId: receiptId } })).toBe(0);
    });
  });

  describe('what is owed leaves it out', () => {
    it('the citizen file: nothing remaining, not outstanding, and only what was paid counted as billed', async () => {
      const before = (await onProfile()).fees;
      const paymentId = await bill(200_000);
      await cash(paymentId, 50_000);
      const owing = (await onProfile()).fees;
      expect(owing.outstandingTotal - before.outstandingTotal).toBe(150_000);
      expect(owing.feesTotal - before.feesTotal).toBe(200_000);

      await writeOff(paymentId);
      const after = await onProfile();
      expect(after.payments.find((row) => row.id === paymentId)).toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
        remaining: 0,
        writeOff: { amount: 150_000, decisionRef: DECISION.decisionRef },
      });
      expect(after.fees.outstandingTotal).toBe(before.outstandingTotal);
      // Billed stays paid plus outstanding: what was forgiven is not billed.
      expect(after.fees.feesTotal - before.feesTotal).toBe(50_000);
      expect(after.fees.paidTotal - before.paidTotal).toBe(50_000);
    });

    it('«المستحق على عقار»: a written-off bill no longer holds the parcel’s «براءة ذمة»', async () => {
      const propertyNumber = `7${randomUUID().slice(0, 5)}`;
      const paymentId = await bill(40_000, { propertyNumber });
      expect(await scoped(() => parcelDues.dues(propertyNumber))).toMatchObject({ total: 40_000 });

      await writeOff(paymentId);
      expect(await scoped(() => parcelDues.dues(propertyNumber))).toMatchObject({ total: 0, bills: [] });
    });

    it('«إلغاء الإشعار»: the notice’s written-off bills are counted apart, and left as they are', async () => {
      const notice = await db.feeNotice.create({
        data: {
          title: 'رسم النظافة',
          amount: 25_000,
          frequency: 'ONCE',
          targetType: 'INDIVIDUAL_CITIZEN',
          dueDate: new Date('2026-12-31T00:00:00.000Z'),
          issuedById: ids.manager,
        },
        select: { id: true },
      });
      const neighbour = randomUUID();
      await db.user.create({
        data: { id: neighbour, kind: 'CITIZEN', tenantSlug: 'write-off', firstName: 'سامي', lastName: 'خليل', phone: '71654321' },
      });
      // One bill per citizen and period on a notice.
      const onNotice = (holder: string) =>
        db.citizenPayment.create({
          data: {
            citizenId: holder,
            feeNoticeId: notice.id,
            periodKey: 'ONCE',
            title: 'رسم النظافة',
            amount: 25_000,
            dueDate: new Date('2026-12-31T00:00:00.000Z'),
          },
          select: { id: true },
        });
      const forgiven = (await onNotice(citizenId)).id;
      const open = (await onNotice(neighbour)).id;
      await writeOff(forgiven);

      expect(await scoped(() => fees.noticePeriods(notice.id))).toEqual([
        expect.objectContaining({ periodKey: 'ONCE', bills: 2, cancellable: 1, writtenOff: 1, alreadyCancelled: 0 }),
      ]);
      await expect(
        scoped(() => fees.cancelNoticeBatch(notice.id, { reason: 'صدر الإشعار خطأً', periodKeys: ['ONCE'] }, MANAGER())),
      ).resolves.toMatchObject({
        cancelled: 1,
        skipped: [expect.objectContaining({ paymentId: forgiven, reason: 'BILL_ALREADY_WRITTEN_OFF' })],
      });
      expect(await db.citizenPayment.findUniqueOrThrow({ where: { id: forgiven } })).toMatchObject({
        paymentStatus: 'WRITTEN_OFF',
      });
      expect(await db.citizenPayment.findUniqueOrThrow({ where: { id: open } })).toMatchObject({
        paymentStatus: 'CANCELLED',
      });
    });
  });
});
