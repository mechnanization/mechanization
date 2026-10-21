import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { PaymentLedgerService, type LedgerAudit } from '../fees/payment-ledger.service';
import { ExpensesService } from './expenses.service';
import { TransfersService } from './transfers.service';
import { TreasuryLedgerService } from './treasury-ledger.service';
import { TreasuryService } from './treasury.service';
import { municipalPeriod } from '@mechanization/shared-schemas';

/**
 * «تسليم صندوق الجابي», end to end against a real Postgres.
 *
 * The flow this pins is the one the municipality actually walks: a collector
 * takes cash at a door, it lands in his custody and not in the safe, and it
 * only reaches the safe when the accountant counts it and receives it. What
 * only a database can prove is that both legs move in one transaction, that a
 * handover of more than he holds is refused, and that two clerks pressing
 * «استلم» together do not empty him twice.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_transfers_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('TransfersService — collector handover', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let ledger: TreasuryLedgerService;
  let payments: PaymentLedgerService;
  let transfers: TransfersService;
  let treasury: TreasuryService;

  let citizenId: string;
  let managerId: string;
  let collectorId: string;
  let safeLbpId: string;

  const MANAGER = { id: '', role: 'SUPER_ADMIN' };

  const scoped = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'spec', tenantSlug: 'transfers', schemaName: SCHEMA, prisma: db }, work);

  const balance = async (accountId: string): Promise<number> =>
    Number(
      (await db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } }))._sum.amount ?? 0,
    );

  const audit: LedgerAudit = (movement) => ({
    actorId: managerId,
    actorType: 'STAFF',
    action: 'PAYMENT_CONFIRMED',
    entityType: 'Payment',
    after: { receiptNumber: movement.receiptNumber },
  });

  /** A citizen pays the collector at his door, exactly as step 1 of the flow describes. */
  const collectAtDoor = async (amount: number): Promise<void> => {
    const payment = await db.citizenPayment.create({
      data: {
        citizenId,
        title: 'رسم',
        amount,
        dueDate: new Date('2026-12-31T00:00:00.000Z'),
        createdAt: new Date('2026-01-01T08:00:00.000Z'),
      },
      select: { id: true },
    });
    await scoped(() =>
      payments.record({
        audit,
        paymentId: payment.id,
        amount,
        method: 'COLLECTOR',
        collectedById: collectorId,
        recordedById: collectorId,
      }),
    );
  };

  const custodyOf = async (): Promise<{ accountId: string; held: number }> => {
    const rows = await scoped(() => transfers.custody());
    const mine = rows.find((row) => row.collectorId === collectorId && row.currency === 'LBP');
    if (!mine) throw new Error('no custody wallet for the collector yet');
    return { accountId: mine.accountId, held: mine.held };
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
    transfers = new TransfersService(context, ledger, auditService, new ExpensesService(context, ledger, auditService));
    treasury = new TreasuryService(context, ledger, auditService);

    citizenId = randomUUID();
    managerId = randomUUID();
    collectorId = randomUUID();
    MANAGER.id = managerId;
    await db.user.createMany({
      data: [
        {
          id: citizenId, kind: 'CITIZEN', tenantSlug: 'transfers',
          firstName: 'علي', middleName: 'غسان', lastName: 'خليل', phone: '71123456',
        },
        {
          id: managerId, kind: 'STAFF', tenantSlug: 'transfers', email: `m-${managerId}@t.gov.lb`,
          firstName: 'المدير', lastName: 'العام', role: 'SUPER_ADMIN',
        },
        {
          id: collectorId, kind: 'STAFF', tenantSlug: 'transfers', email: `c-${collectorId}@t.gov.lb`,
          firstName: 'حسن', lastName: 'الجابي', role: 'COLLECTOR',
        },
      ],
    });

    /*
      Where he lives, for the sector column. A sector owns parcel *numbers*
      rather than buildings (D13), so the chain the service walks is
      occupancy → unit → building.parcelNumber → the zone listing it.
    */
    const building = await db.building.create({
      data: {
        parcelNumber: '1421',
        codeSuffix: '001',
        code: '1421-001',
        structureType: 'RESIDENTIAL_BUILDING',
      },
      select: { id: true },
    });
    const unit = await db.unit.create({
      data: { buildingId: building.id, unitCode: 'A1', unitType: 'APARTMENT', floor: 1, sequence: 1 },
      select: { id: true },
    });
    await db.unitOccupancy.create({ data: { unitId: unit.id, citizenId, role: 'TENANT' } });
    await db.zone.create({
      data: { name: 'حي الزهراء', code: 'Z1', parcelNumbers: ['1421'] },
    });

    // The treasury must be live before anything credits a wallet.
    const accounts = await db.treasuryAccount.findMany({ where: { type: { not: 'COLLECTOR_CUSTODY' } } });
    await scoped(() =>
      treasury.activate(
        { balances: accounts.map((account) => ({ accountId: account.id, amount: 0 })) },
        MANAGER,
      ),
    );
    safeLbpId = (await db.treasuryAccount.findFirstOrThrow({ where: { type: 'CASH_SAFE', currency: 'LBP' } })).id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ───────────────  the money is his, not the municipality's, until he hands it in  ───────────────

  describe('after a round at the doors', () => {
    it('puts what he took in his custody and nothing in the safe', async () => {
      await collectAtDoor(500_000);
      await collectAtDoor(300_000);

      const custody = await custodyOf();
      expect(custody.held).toBe(800_000);
      expect(await balance(safeLbpId)).toBe(0);
    });

    it('reports him with the count of movements behind the figure', async () => {
      const rows = await scoped(() => transfers.custody());
      const mine = rows.find((row) => row.collectorId === collectorId);
      expect(mine).toMatchObject({ collectorName: 'حسن الجابي', currency: 'LBP', movements: 2 });
      expect(mine?.lastCollectedAt).not.toBeNull();
    });
  });

  // ──────────────────────────────  the handover  ──────────────────────────────

  describe('«تسليم صندوق الجابي»', () => {
    it('refuses more than he holds, and moves nothing', async () => {
      const custody = await custodyOf();
      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 900_000 }, MANAGER)),
      ).rejects.toMatchObject({ code: 'CUSTODY_EXCEEDS_HELD' });

      expect((await custodyOf()).held).toBe(800_000);
      expect(await balance(safeLbpId)).toBe(0);
      expect(await db.treasuryTransfer.count()).toBe(0);
    });

    it('takes a part of it, and the rest stays on his name', async () => {
      const custody = await custodyOf();
      const result = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 300_000 }, MANAGER),
      );

      expect(result.transferNumber).toMatch(new RegExp(`^TR-${municipalPeriod()}-\\d{4}$`));
      expect(result.remainingInCustody).toBe(500_000);
      expect(result.safeBalanceAfter).toBe(300_000);
      expect(await balance(safeLbpId)).toBe(300_000);
    });

    it('writes both legs against the one transfer', async () => {
      const transfer = await db.treasuryTransfer.findFirstOrThrow({ orderBy: { createdAt: 'desc' } });
      const entries = await db.treasuryEntry.findMany({
        where: { source: 'TRANSFER', sourceId: transfer.id },
        orderBy: { amount: 'asc' },
      });

      expect(entries).toHaveLength(2);
      expect(Number(entries[0].amount)).toBe(-300_000);
      expect(Number(entries[1].amount)).toBe(300_000);
      expect(entries[1].accountId).toBe(safeLbpId);
    });

    it('empties him on a full handover', async () => {
      const custody = await custodyOf();
      const result = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: custody.held }, MANAGER),
      );

      expect(result.remainingInCustody).toBe(0);
      expect(await balance(safeLbpId)).toBe(800_000);
      // He stays on the list at zero: «سلّم كل شيء» is an answer the accountant needs.
      const rows = await scoped(() => transfers.custody());
      expect(rows.find((row) => row.collectorId === collectorId)?.held).toBe(0);
    });

    it('refuses to receive from an empty custody', async () => {
      const custody = await custodyOf();
      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 1 }, MANAGER)),
      ).rejects.toMatchObject({ code: 'CUSTODY_EXCEEDS_HELD' });
    });

    it('answers a double press from the first handover, moving the money once', async () => {
      await collectAtDoor(120_000);
      const custody = await custodyOf();
      const clientRequestId = randomUUID();
      const safeBefore = await balance(safeLbpId);

      const first = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 120_000, clientRequestId }, MANAGER),
      );
      const again = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 120_000, clientRequestId }, MANAGER),
      );

      expect(again.transferNumber).toBe(first.transferNumber);
      expect(again.replayed).toBe(true);
      expect(await balance(safeLbpId)).toBe(safeBefore + 120_000);
    });

    it('lets only one of two simultaneous handovers through', async () => {
      await collectAtDoor(200_000);
      const custody = await custodyOf();

      const results = await Promise.allSettled([
        scoped(() => transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 200_000 }, MANAGER)),
        scoped(() => transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 200_000 }, MANAGER)),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((await custodyOf()).held).toBe(0);
    });

    it('refuses a custody account that does not exist', async () => {
      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId: randomUUID(), amount: 1 }, MANAGER)),
      ).rejects.toMatchObject({ code: 'CUSTODY_ACCOUNT_NOT_FOUND' });
    });

    it('refuses the safe as a source: a handover only ever leaves a custody wallet', async () => {
      await expect(
        scoped(() => transfers.receiveCustody({ custodyAccountId: safeLbpId, amount: 1 }, MANAGER)),
      ).rejects.toMatchObject({ code: 'CUSTODY_ACCOUNT_NOT_FOUND' });
    });

    it('audits the handover without naming the collector', async () => {
      const rows = await db.auditLogEntry.findMany({ where: { action: 'CUSTODY_RECEIVED' } });
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows[0].after)).not.toContain('حسن');
      expect(rows[0].after).toMatchObject({ collectorId });
    });
  });

  // ────────────────────────────────  cancelling  ────────────────────────────────

  describe('cancelling a handover', () => {
    it('puts the money back on the collector', async () => {
      await collectAtDoor(75_000);
      const custody = await custodyOf();
      const safeBefore = await balance(safeLbpId);
      const received = await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 75_000 }, MANAGER),
      );
      expect(await balance(safeLbpId)).toBe(safeBefore + 75_000);

      const voided = await scoped(() => transfers.void(received.id, 'خطأ في العدّ', MANAGER));

      expect(voided.status).toBe('VOID');
      expect(await balance(safeLbpId)).toBe(safeBefore);
      expect((await custodyOf()).held).toBe(75_000);
    });

    it('refuses a second cancellation', async () => {
      const transfer = await db.treasuryTransfer.findFirstOrThrow({ where: { voidedAt: { not: null } } });
      await expect(scoped(() => transfers.void(transfer.id, 'مرة ثانية', MANAGER))).rejects.toMatchObject({
        code: 'TRANSFER_ALREADY_VOID',
      });
    });

    it('refuses a transfer that does not exist', async () => {
      await expect(scoped(() => transfers.void(randomUUID(), 'لا شيء', MANAGER))).rejects.toMatchObject({
        code: 'TRANSFER_NOT_FOUND',
      });
    });
  });

  // ─────────────────────────────────  the list  ─────────────────────────────────

  describe('the transfer list', () => {
    it('shows each handover with both ends named', async () => {
      const { transfers: rows } = await scoped(() => transfers.list({ kind: 'HANDOVER' }));
      expect(rows.length).toBeGreaterThan(0);
      const handover = rows.find((row) => row.status === 'RECORDED');
      expect(handover?.kind).toBe('HANDOVER');
      expect(handover?.fee).toBeNull();
      expect(handover?.review).toBeNull();
      expect(handover?.to.name).toContain('صندوق النقد');
      expect(handover?.from.name).toContain('عهدة');
      expect(handover?.amount).toBe(handover?.receivedAmount);
    });
  });

  // ───────────────────────  «من حصّل الجابي» — the receipts  ───────────────────────

  describe('the receipts behind the figure', () => {
    it('names every citizen he took money from, with the receipt and the amount', async () => {
      const result = await scoped(() => transfers.collections(collectorId));

      expect(result.collector.name).toBe('حسن الجابي');
      expect(result.total).toBe(await db.paymentTransaction.count({ where: { collectedById: collectorId } }));
      expect(result.rows.length).toBe(result.total);
      expect(result.rows.every((row) => row.citizenName === 'علي غسان خليل')).toBe(true);
      const receiptShape = new RegExp(`^RCP-${municipalPeriod()}-\\d{4}$`);
      expect(result.rows.every((row) => receiptShape.test(row.receiptNumber))).toBe(true);
      expect(result.rows.map((row) => row.amount)).toContain(500_000);
    });

    /*
      The guard that matters on a screen naming citizens.

      A phone and a sector are here deliberately — the register already shows
      both to every staff role, and treasury-read is a narrower set, so this
      adds no one's sight of them. A رقم مرجعي is a different thing entirely: it
      is a sign-in credential, and so is the national id. Pinned as the exact
      key set, so a field added to the row later fails here rather than in a
      browser, and widening it stays a decision somebody made on purpose.
    */
    it('carries what the round needs and no credential', async () => {
      const result = await scoped(() => transfers.collections(collectorId));
      expect(result.rows.length).toBeGreaterThan(0);

      expect(Object.keys(result.rows[0]).sort()).toEqual([
        'amount',
        'citizenContactPhone',
        'citizenHasNoPhone',
        'citizenId',
        'citizenName',
        'citizenPhone',
        'currency',
        'id',
        'isReversal',
        'note',
        'occurredAt',
        'paymentTitle',
        'receiptNumber',
        'reversed',
        'zoneName',
      ]);
    });

    it('names him in full, with his father, and says which sector he is in', async () => {
      const result = await scoped(() => transfers.collections(collectorId));

      expect(result.rows[0]).toMatchObject({
        citizenName: 'علي غسان خليل',
        citizenPhone: '71123456',
        citizenHasNoPhone: false,
        zoneName: 'حي الزهراء',
      });
    });

    it('newest first, so the last door is the first row', async () => {
      const result = await scoped(() => transfers.collections(collectorId));
      const times = result.rows.map((row) => Date.parse(row.occurredAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    /*
      The one arithmetic claim the screen makes. Collected is the sum of the
      receipts; held is what has not been handed in. They differ by exactly what
      he brought, because a handover moves an amount and not a set of receipts —
      which is why the page refuses to mark individual receipts "handed over".
    */
    it('differs from his custody by exactly what he has handed in', async () => {
      const result = await scoped(() => transfers.collections(collectorId));
      const collected = result.totals.find((total) => total.currency === 'LBP')?.amount ?? 0;
      const held = result.custody.find((wallet) => wallet.currency === 'LBP')?.held ?? 0;

      const handedIn = await db.treasuryTransfer.aggregate({
        where: { fromAccountId: (await custodyOf()).accountId, voidedAt: null },
        _sum: { amount: true },
      });

      expect(collected - held).toBeCloseTo(Number(handedIn._sum.amount ?? 0), 2);
    });

    it('keeps a reversed payment on the list beside its opposing row', async () => {
      const before = await scoped(() => transfers.collections(collectorId));
      const collectedBefore = before.totals.find((total) => total.currency === 'LBP')?.amount ?? 0;

      await collectAtDoor(120_000);
      const fresh = await db.paymentTransaction.findFirstOrThrow({
        where: { collectedById: collectorId, amount: 120_000 },
        orderBy: { createdAt: 'desc' },
        select: { id: true, receiptNumber: true },
      });
      await scoped(() => payments.reverse({ transactionId: fresh.id, recordedById: managerId, audit }));

      const after = await scoped(() => transfers.collections(collectorId));
      const original = after.rows.find((row) => row.receiptNumber === fresh.receiptNumber);
      expect(original).toMatchObject({ amount: 120_000, isReversal: false, reversed: true });
      expect(after.rows.some((row) => row.isReversal && row.amount === -120_000)).toBe(true);

      // The pair nets to nothing, so the total is where it was.
      const collectedAfter = after.totals.find((total) => total.currency === 'LBP')?.amount ?? 0;
      expect(collectedAfter).toBeCloseTo(collectedBefore, 2);
    });

    it('refuses a collector who does not exist', async () => {
      await expect(scoped(() => transfers.collections(randomUUID()))).rejects.toMatchObject({
        code: 'COLLECTOR_NOT_FOUND',
      });
    });

    it('answers for a staff member who never collected, rather than failing', async () => {
      const result = await scoped(() => transfers.collections(managerId));
      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.custody).toEqual([]);
      expect(result.collector.name).toBe('المدير العام');
    });
  });

  // ────────────────────────  «جولتي» — his own round  ────────────────────────

  describe('the round a collector sees of himself', () => {
    it('answers an empty round for a staff member who has never collected', async () => {
      const round = await scoped(() => transfers.myRound(managerId));

      expect(round).toMatchObject({ lastHandoverAt: null, currencies: [], rows: [] });
      expect(round.collector.name).toBe('المدير العام');
    });

    it('refuses an id that is nobody', async () => {
      await expect(scoped(() => transfers.myRound(randomUUID()))).rejects.toMatchObject({
        code: 'COLLECTOR_NOT_FOUND',
      });
    });

    it('lists the doors since his last handover, with the unit he collected at', async () => {
      // Settle him up first, so the round below holds exactly what we put in it.
      const before = await custodyOf();
      if (before.held > 0) {
        await scoped(() =>
          transfers.receiveCustody({ custodyAccountId: before.accountId, amount: before.held }, MANAGER),
        );
      }
      await collectAtDoor(250_000);
      await collectAtDoor(150_000);

      const round = await scoped(() => transfers.myRound(collectorId));

      expect(round.rows).toHaveLength(2);
      expect(round.rows[0]).toMatchObject({
        citizenName: 'علي غسان خليل',
        unitCode: '0101',
        buildingCode: '1421-001',
        currency: 'LBP',
      });
      expect(round.lastHandoverAt).not.toBeNull();
    });

    it('adds up to exactly what is in his pocket', async () => {
      const round = await scoped(() => transfers.myRound(collectorId));

      expect(round.currencies.find((entry) => entry.currency === 'LBP')).toMatchObject({
        held: 400_000,
        listed: 400_000,
        carriedOver: 0,
      });
    });

    /*
      The pocket is the point of the screen, and a cancelled payment is not in
      it. Unlike the accountant's reconciliation list, which keeps the pair.
    */
    it('leaves a cancelled payment and its opposing row out', async () => {
      await collectAtDoor(90_000);
      const fresh = await db.paymentTransaction.findFirstOrThrow({
        where: { collectedById: collectorId, amount: 90_000 },
        orderBy: { createdAt: 'desc' },
        select: { id: true, receiptNumber: true },
      });
      await scoped(() => payments.reverse({ transactionId: fresh.id, recordedById: managerId, audit }));

      const round = await scoped(() => transfers.myRound(collectorId));

      expect(round.rows.some((row) => row.receiptNumber === fresh.receiptNumber)).toBe(false);
      expect(round.rows).toHaveLength(2);
      expect(round.currencies.find((entry) => entry.currency === 'LBP')).toMatchObject({
        held: 400_000,
        listed: 400_000,
        carriedOver: 0,
      });
    });

    /*
      The honest case. A handover moves an amount, not a set of receipts, so
      after a partial one no receipt is left to explain what he still holds.
      The figure is named rather than letting the list quietly disagree with
      the total above it.
    */
    it('names what is carried over after a partial handover rather than hiding it', async () => {
      const custody = await custodyOf();
      await scoped(() =>
        transfers.receiveCustody({ custodyAccountId: custody.accountId, amount: 100_000 }, MANAGER),
      );

      const round = await scoped(() => transfers.myRound(collectorId));

      expect(round.rows).toHaveLength(0);
      expect(round.currencies.find((entry) => entry.currency === 'LBP')).toMatchObject({
        held: 300_000,
        listed: 0,
        carriedOver: 300_000,
      });
    });

    it("counts his receipts for today on the accountant's panel", async () => {
      const rows = await scoped(() => transfers.custody());
      const mine = rows.find((row) => row.collectorId === collectorId);

      expect(mine?.receiptsToday).toBeGreaterThan(0);
      expect(mine?.status).toBe('COLLECTING_TODAY');
    });
  });
});

