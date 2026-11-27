import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { municipalToday, type ArrearsTemplateCells } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { APP_CONFIG } from '../../common/app.config';
import { AuditService } from '../audit/audit.service';
import { CitizenMergeService } from '../citizens/citizen-merge.service';
import { ParcelDuesService } from '../fees/parcel-dues.service';
import { ArrearsBatchService } from './arrears-batch.service';
import { ArrearsService } from './arrears.service';
import { StaffActor } from '../../common/actor';

/**
 * Old debts after the import (task 5, docs/old-debts-plan.md §4.4–§4.7), against
 * a real tenant schema: submit with the pages' total, return, discard, approve —
 * which raises exactly the kept, matched lines as «ARR-» bills and nothing twice —
 * a single line, the link of a «للمطابقة» line, and the cutoff year.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_arrears_batch_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/** The years are read from today, so the spec outlives the calendar: the cutoff is this year, a debt is last year's. */
const THIS_YEAR = Number(municipalToday().slice(0, 4));
const CUTOFF = THIS_YEAR;
const LAST = THIS_YEAR - 1;
const OLDER = THIS_YEAR - 2;
/** Past 31 December of its year + 5. */
const PRESCRIBED = THIS_YEAR - 6;

describeIfDb('old debts: submit, approve, link', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let importer: ArrearsService;
  let batches: ArrearsBatchService;
  let parcelDues: ParcelDuesService;
  let merges: CitizenMergeService;

  const ids = { accountant: randomUUID(), otherAccountant: randomUUID(), manager: randomUUID() };
  const ACCOUNTANT: StaffActor = { id: ids.accountant, role: 'ACCOUNTANT' };
  const OTHER_ACCOUNTANT: StaffActor = { id: ids.otherAccountant, role: 'ACCOUNTANT' };
  const MANAGER: StaffActor = { id: ids.manager, role: 'SUPER_ADMIN' };
  const person = { amal: randomUUID(), bassem: randomUUID(), dalal: randomUUID(), elias: randomUUID(), fadi: randomUUID() };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'arb', tenantSlug: 'arb', schemaName: SCHEMA, prisma: db }, work);

  /** A DRAFT batch for these people, rowKeys 1…n in order, and the file imported into it. */
  const draft = async (citizens: string[], rows: ArrearsTemplateCells[], drops: Array<{ row: number; component: 'PRINCIPAL' | 'PENALTY'; reason: string }> = []) => {
    const batch = await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } });
    await db.arrearsBatchCitizen.createMany({ data: citizens.map((citizenId, index) => ({ batchId: batch.id, citizenId, rowKey: index + 1 })) });
    await within(() => importer.importLines(batch.id, { rows, startRow: 1, drops, dryRun: false }, ACCOUNTANT));
    return batch.id;
  };
  const debt = (rowKey: number | string, property: string, year: number, principal: string, extra: ArrearsTemplateCells = {}): ArrearsTemplateCells => ({
    rowKey: String(rowKey),
    propertyNumber: property,
    year: String(year),
    feeType: 'RENTAL_VALUE',
    principal,
    ...extra,
  });
  const unique = () => `9${randomUUID().replace(/\D/g, '').slice(0, 5)}`;

  const total = async (batchId: string) =>
    (await db.arrearsLine.findMany({ where: { batchId }, select: { amount: true } })).reduce((sum, line) => sum + Math.round(Number(line.amount) * 100), 0) / 100;
  const submit = async (batchId: string, actor = ACCOUNTANT) =>
    within(async () => batches.submit(batchId, { controlTotal: await total(batchId) }, actor));
  const approve = (batchId: string, actor = MANAGER) => within(() => batches.approve(batchId, actor));
  const billsOf = (batchId: string) => db.citizenPayment.findMany({ where: { arrearsLine: { batchId } }, include: { arrearsLine: true }, orderBy: { amount: 'asc' } });
  const setCutoff = (year: number | null) => within(() => batches.setCutoff({ arrearsCutoffYear: year }, MANAGER));
  /** Moves the cutoff behind the service's back: what an earlier state of the register looked like, for a scenario. */
  const forceCutoff = (year: number | null) => db.systemSettings.updateMany({ data: { arrearsCutoffYear: year } });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    importer = new ArrearsService(context, audit);
    batches = new ArrearsBatchService(context, audit, importer, new EventEmitter2());
    parcelDues = new ParcelDuesService(context);
    merges = new CitizenMergeService(context, new EventEmitter2(), audit);

    const citizen = (id: string, firstName: string, isActive = true) => ({
      id, kind: 'CITIZEN' as const, tenantSlug: 'arb', firstName, middleName: 'محمد', lastName: 'حداد', isActive,
      referenceNumber: `REF-${id.slice(0, 8)}`, phone: '+96170123456',
    });
    const staff = (id: string, role: string) => ({ id, kind: 'STAFF' as const, tenantSlug: 'arb', email: `${id}@arb.gov.lb`, firstName: role, lastName: 'البلدية', role: role as never });
    await db.user.createMany({
      data: [
        staff(ids.accountant, 'ACCOUNTANT'),
        staff(ids.otherAccountant, 'ACCOUNTANT'),
        staff(ids.manager, 'SUPER_ADMIN'),
        citizen(person.amal, 'أمل'),
        citizen(person.bassem, 'باسم'),
        citizen(person.dalal, 'دلال', false),
        citizen(person.elias, 'إلياس'),
        citizen(person.fadi, 'فادي'),
      ],
    });
    await db.systemSettings.create({ data: { arrearsCutoffYear: CUTOFF } });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('the cutoff year, before any batch is approved', () => {
    it('is read, set, cleared and audited, and moves freely', async () => {
      try {
        expect(await within(() => batches.settings())).toMatchObject({ arrearsCutoffYear: CUTOFF, controlTotals: [] });
        await expect(setCutoff(CUTOFF + 1)).resolves.toMatchObject({ arrearsCutoffYear: CUTOFF + 1 });
        await expect(setCutoff(null)).resolves.toMatchObject({ arrearsCutoffYear: null });
        const row = await db.auditLogEntry.findFirstOrThrow({
          where: { action: 'ARREARS_CUTOFF_CHANGED' },
          orderBy: { createdAt: 'desc' },
        });
        expect(row).toMatchObject({ actorId: ids.manager, before: { arrearsCutoffYear: CUTOFF + 1 }, after: { arrearsCutoffYear: null } });
      } finally {
        await forceCutoff(CUTOFF);
      }
    });
  });

  describe('submit', () => {
    it('refuses a batch with no line, and a total that is not the lines’ sum', async () => {
      const empty = (await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } })).id;
      await expect(within(() => batches.submit(empty, { controlTotal: 0 }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_BATCH_EMPTY' });

      const property = unique();
      const batch = await draft([person.amal], [debt(1, property, LAST, '100000'), debt(1, property, OLDER, '50000.50')]);
      await expect(within(() => batches.submit(batch, { controlTotal: 150_000 }, ACCOUNTANT))).rejects.toMatchObject({
        code: 'ARREARS_CONTROL_TOTAL_MISMATCH',
        params: { controlTotal: 150_000, linesTotal: 150_000.5 },
      });
      expect((await db.arrearsBatch.findUniqueOrThrow({ where: { id: batch } })).status).toBe('DRAFT');
    });

    it('holds the total to the cent, counts dropped and unmatched lines too, and locks the draft', async () => {
      const property = unique();
      // One kept, one dropped by the accountant, one for a person not in the set, one prescribed: all in the pages.
      const batch = await draft(
        [person.amal],
        [
          debt(1, property, LAST, '100000'),
          debt(1, property, OLDER, '40000'),
          { fullName: 'غريب عن الملف', propertyNumber: property, year: String(LAST), feeType: 'CLEANING', principal: '25000' },
          debt(1, property, PRESCRIBED, '10000', { feeType: 'CLEANING' }),
        ],
        [{ row: 2, component: 'PRINCIPAL', reason: 'سقط بقرار المجلس' }],
      );
      const view = await submit(batch);
      expect(view).toMatchObject({ status: 'SUBMITTED', controlTotal: 175_000, lineCount: 4 });
      expect((await db.arrearsBatch.findUniqueOrThrow({ where: { id: batch } })).submittedById).toBe(ids.accountant);

      await expect(submit(batch)).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_DRAFT', params: { status: 'SUBMITTED' } });
      // The submitted batch takes no more lines.
      await expect(
        within(() => importer.importLines(batch, { rows: [debt(1, property, LAST, '1')], startRow: 1, drops: [], dryRun: false }, ACCOUNTANT)),
      ).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_DRAFT' });
    });

    it('is the preparer’s, or the manager’s, to send', async () => {
      const batch = await draft([person.fadi], [debt(1, unique(), LAST, '5000')]);
      await expect(submit(batch, OTHER_ACCOUNTANT)).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_YOURS' });
      await expect(submit(batch, MANAGER)).resolves.toMatchObject({ status: 'SUBMITTED' });
    });
  });

  describe('return and discard', () => {
    it('returns a submitted batch to its preparer as a draft, with the note, and it takes lines again', async () => {
      const property = unique();
      const batch = await draft([person.bassem], [debt(1, property, LAST, '30000')]);
      await submit(batch);
      await expect(within(() => batches.returnBatch(batch, { note: 'المجموع ينقصه سطر' }, MANAGER))).resolves.toMatchObject({
        status: 'DRAFT',
        returnNote: 'المجموع ينقصه سطر',
      });
      expect(await db.arrearsBatch.findUniqueOrThrow({ where: { id: batch } })).toMatchObject({ submittedAt: null, submittedById: null });

      await within(() =>
        importer.importLines(batch, { rows: [debt(1, property, LAST, '30000'), debt(1, property, OLDER, '7000')], startRow: 1, drops: [], dryRun: false }, ACCOUNTANT),
      );
      await expect(submit(batch)).resolves.toMatchObject({ status: 'SUBMITTED', controlTotal: 37_000 });
      // Only a submitted batch is returned.
      await expect(within(() => batches.returnBatch(randomUUID(), { note: 'خطأ' }, MANAGER))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_FOUND' });
    });

    it('lets a draft be discarded by its preparer, not by another accountant, and frees its debts for a new batch', async () => {
      const property = unique();
      const first = await draft([person.dalal], [debt(1, property, LAST, '12000')]);
      await expect(within(() => batches.discard(first, { reason: 'ملف خاطئ' }, OTHER_ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_YOURS' });

      // The same debt, held by the first batch, is a duplicate in a second…
      const second = await db.arrearsBatch.create({ data: { preparedById: ids.accountant }, select: { id: true } });
      await db.arrearsBatchCitizen.create({ data: { batchId: second.id, citizenId: person.dalal, rowKey: 1 } });
      const check = (rows: ArrearsTemplateCells[]) => within(() => importer.importLines(second.id, { rows, startRow: 1, drops: [], dryRun: true }, ACCOUNTANT));
      expect((await check([debt(1, property, LAST, '12000')])).lines[0]).toMatchObject({ status: 'REFUSED', issues: ['DUPLICATE_LIVE_LINE'] });

      // …until the first is discarded.
      await expect(within(() => batches.discard(first, { reason: 'ملف خاطئ' }, ACCOUNTANT))).resolves.toMatchObject({ status: 'DISCARDED' });
      expect(await db.arrearsLine.count({ where: { batchId: first, discardedAt: { not: null } } })).toBe(1);
      expect((await check([debt(1, property, LAST, '12000')])).lines[0]).toMatchObject({ status: 'KEEP' });
      await expect(within(() => batches.discard(first, { reason: 'مرة ثانية' }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_DRAFT' });
    });

    it('leaves a submitted batch to the manager alone to discard', async () => {
      const batch = await draft([person.fadi], [debt(1, unique(), OLDER, '3000')]);
      await submit(batch);
      await expect(within(() => batches.discard(batch, { reason: 'تراجع' }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_YOURS' });
      await expect(within(() => batches.discard(batch, { reason: 'تراجع' }, MANAGER))).resolves.toMatchObject({ status: 'DISCARDED' });
    });
  });

  describe('approve', () => {
    let batchId: string;
    let property: string;
    let unmatchedLineId: string;

    beforeAll(async () => {
      property = unique();
      // Amal: a principal and its penalty (two bills). Bassem: dropped by the accountant. Dalal: an archived file, still billed.
      // A stranger in the books: waits in «للمطابقة». A prescribed line: dropped, no bill.
      batchId = await draft(
        [person.amal, person.bassem, person.dalal],
        [
          debt(1, property, LAST, '100000', { penalty: '20000', oldReference: 'دفتر 3 ص 14' }),
          debt(2, property, OLDER, '50000'),
          debt(3, property, LAST, '30000', { feeType: 'OTHER', feeTypeNote: 'رسم المياه' }),
          { fullName: 'غريب عن الملف', propertyNumber: property, year: String(LAST), feeType: 'CLEANING', principal: '40000' },
          debt(1, property, PRESCRIBED, '10000', { feeType: 'CLEANING' }),
        ],
        [{ row: 2, component: 'PRINCIPAL', reason: 'سقط بقرار المجلس' }],
      );
      await submit(batchId);
    });

    it('is refused for a batch that is not waiting for approval', async () => {
      const draftOnly = await draft([person.fadi], [debt(1, unique(), LAST, '1000')]);
      await expect(approve(draftOnly)).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_SUBMITTED', params: { status: 'DRAFT' } });
    });

    it('raises exactly the kept lines that have a citizen, as «ARR-» bills on the files', async () => {
      await expect(approve(batchId)).resolves.toMatchObject({ status: 'APPROVED', approvedBy: { id: ids.manager } });

      const bills = await billsOf(batchId);
      // Amal's principal and penalty, and Dalal's archived file: three. Not the drop, the stranger or the prescribed.
      expect(bills.map((bill) => Number(bill.amount))).toEqual([20_000, 30_000, 100_000]);
      const principal = bills.find((bill) => Number(bill.amount) === 100_000)!;
      expect(principal).toMatchObject({
        citizenId: person.amal,
        title: `متأخرات ${LAST} — رسم القيمة التأجيرية`,
        currency: 'LBP',
        periodKey: String(LAST),
        paymentStatus: 'UNPAID',
        issuedById: ids.manager,
        feeNoticeId: null,
      });
      expect(principal.invoiceNumber).toMatch(/^ARR-\d{4}-\d{4}$/);
      expect(principal.dueDate.toISOString()).toBe(`${LAST}-12-31T00:00:00.000Z`);
      expect(principal.assessment).toMatchObject({ basis: 'FLAT', lines: [{ propertyNumber: property, propertyType: 'ARREARS' }] });
      expect(bills.find((bill) => Number(bill.amount) === 20_000)!.title).toBe(`متأخرات ${LAST} — رسم القيمة التأجيرية — غرامة`);
      // The archived file is billed here (decision 12), and an «رسم آخر» is named by the books' word.
      expect(bills.find((bill) => bill.citizenId === person.dalal)).toMatchObject({ title: `متأخرات ${LAST} — رسم المياه` });
      expect(new Set(bills.map((bill) => bill.invoiceNumber)).size).toBe(3);

      // Nothing for the other four lines, and none of them touched.
      const without = await db.arrearsLine.findMany({ where: { batchId, bill: null } });
      expect(without.map((line) => line.decision === 'DROP' || line.citizenId === null).sort()).toEqual([true, true, true]);
      unmatchedLineId = without.find((line) => line.citizenId === null)!.id;
      expect(await db.citizenPayment.count({ where: { citizenId: person.bassem, arrearsLineId: { not: null } } })).toBe(0);
    });

    it('writes one audit row for the batch and one for each bill, without a name', async () => {
      const batchRow = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'ARREARS_BATCH_APPROVED', entityId: batchId } });
      expect(batchRow).toMatchObject({ actorId: ids.manager, after: { bills: 3, total: 150_000, citizens: 2, waitingForMatch: 1, dropped: 2 } });
      const billIds = (await billsOf(batchId)).map((bill) => bill.id);
      expect(await db.auditLogEntry.count({ where: { action: 'ARREARS_BILL_RAISED', entityId: { in: billIds } } })).toBe(3);
    });

    it('is refused a second time, and raises nothing twice', async () => {
      const before = await db.citizenPayment.count({ where: { arrearsLineId: { not: null } } });
      await expect(approve(batchId)).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_SUBMITTED', params: { status: 'APPROVED' } });
      expect(await db.citizenPayment.count({ where: { arrearsLineId: { not: null } } })).toBe(before);
      // An approved batch is final.
      await expect(within(() => batches.returnBatch(batchId, { note: 'تراجع' }, MANAGER))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_SUBMITTED' });
      await expect(within(() => batches.discard(batchId, { reason: 'تراجع' }, MANAGER))).rejects.toMatchObject({ code: 'ARREARS_BATCH_NOT_DRAFT' });
    });

    it('holds a «براءة ذمة» back while an «ARR-» bill on the رقم العقار is unpaid', async () => {
      expect(await within(() => parcelDues.dues(property))).toMatchObject({ total: 150_000 });
      const bills = await billsOf(batchId);
      await db.citizenPayment.updateMany({ where: { id: { in: bills.map((bill) => bill.id) } }, data: { paymentStatus: 'PAID', paidAmount: 0 } });
      // Paid bills are off the parcel; the dues read open statuses only.
      expect(await within(() => parcelDues.dues(property))).toMatchObject({ total: 0 });
    });

    it('lists the stranger’s line for matching', async () => {
      const { items } = await within(() => batches.unmatched());
      expect(items).toContainEqual(expect.objectContaining({ id: unmatchedLineId, sourceName: 'غريب عن الملف', propertyNumber: property, amount: 40_000 }));
    });
  });

  describe('approve, when the register moved since the import', () => {
    it('refuses a citizen folded into another file, names the line, and raises nothing', async () => {
      const batch = await draft([person.elias], [debt(1, unique(), LAST, '8000')]);
      await submit(batch);
      await db.citizenMerge.create({ data: { survivorId: person.amal, absorbedId: person.elias, reason: 'ملف مكرر', footprint: {} } });

      const refusal = await approve(batch).catch((error) => error);
      expect(refusal).toMatchObject({ code: 'ARREARS_APPROVAL_CHECKS_FAILED', params: { count: 1 } });
      const line = await db.arrearsLine.findFirstOrThrow({ where: { batchId: batch } });
      expect(refusal.details).toEqual({ problems: [{ lineId: line.id, issue: 'CITIZEN_MERGED_AWAY' }] });
      expect((await db.arrearsBatch.findUniqueOrThrow({ where: { id: batch } })).status).toBe('SUBMITTED');
      expect(await billsOf(batch)).toHaveLength(0);

      // The manager returns it; the preparer starts again.
      await expect(within(() => batches.returnBatch(batch, { note: 'الملف دُمج' }, MANAGER))).resolves.toMatchObject({ status: 'DRAFT' });
    });

    it('asks the cutoff again: a year the manager has since moved down to is no longer old', async () => {
      const batch = await draft([person.fadi], [debt(1, unique(), LAST, '9000')]);
      await submit(batch);
      try {
        await forceCutoff(LAST);
        await expect(approve(batch)).rejects.toMatchObject({ code: 'ARREARS_APPROVAL_CHECKS_FAILED' });
        await forceCutoff(null);
        await expect(approve(batch)).rejects.toMatchObject({ code: 'ARREARS_APPROVAL_CHECKS_FAILED' });
      } finally {
        await forceCutoff(CUTOFF);
      }
      await expect(approve(batch)).resolves.toMatchObject({ status: 'APPROVED' });
    });
  });

  describe('approve, whoever prepared the batch', () => {
    it('may approve it while the rule is off, and not once it is on', async () => {
      const config = APP_CONFIG.arrears as { approverMustDifferFromPreparer: boolean };
      // The manager prepares it this time.
      const own = await db.arrearsBatch.create({ data: { preparedById: ids.manager }, select: { id: true } });
      await db.arrearsBatchCitizen.create({ data: { batchId: own.id, citizenId: person.fadi, rowKey: 1 } });
      await within(() => importer.importLines(own.id, { rows: [debt(1, unique(), OLDER, '6000')], startRow: 1, drops: [], dryRun: false }, MANAGER));
      await submit(own.id, MANAGER);

      config.approverMustDifferFromPreparer = true;
      try {
        await expect(approve(own.id)).rejects.toMatchObject({ code: 'ARREARS_APPROVER_IS_PREPARER' });
      } finally {
        config.approverMustDifferFromPreparer = false;
      }
      await expect(approve(own.id)).resolves.toMatchObject({ status: 'APPROVED' });
    });
  });

  describe('a single line', () => {
    const line = (over: Record<string, unknown> = {}) => ({
      propertyNumber: unique(),
      year: LAST,
      feeType: 'CLEANING' as const,
      component: 'PRINCIPAL' as const,
      amount: 15_000,
      currency: 'LBP' as const,
      clientRequestId: randomUUID(),
      ...over,
    });
    const add = (input: ReturnType<typeof line> & Record<string, unknown>, actor = ACCOUNTANT) =>
      within(() => batches.addSingleLine(input as never, actor));

    it('is a batch of one, sent at once with its own amount as the total, and approved like any other', async () => {
      const input = line({ citizenId: person.fadi });
      const view = await add(input);
      expect(view).toMatchObject({ status: 'SUBMITTED', lineCount: 1, controlTotal: 15_000, preparedBy: { id: ids.accountant } });
      // Not a bill before the manager approves it.
      expect(await billsOf(view.id)).toHaveLength(0);
      await approve(view.id);
      expect(await billsOf(view.id)).toMatchObject([{ citizenId: person.fadi, periodKey: String(LAST) }]);
      // Fadi was never put in an export's set by it.
      expect(await db.arrearsBatchCitizen.count({ where: { batchId: view.id } })).toBe(0);
    });

    it('answers a retry with the first batch, and refuses the key for another line', async () => {
      const input = line({ citizenId: person.amal });
      const first = await add(input);
      const again = await add(input);
      expect(again.id).toBe(first.id);
      expect(await db.arrearsLine.count({ where: { batchId: first.id } })).toBe(1);
      await expect(add({ ...input, amount: 16_000 })).rejects.toMatchObject({ code: 'ARREARS_LINE_REQUEST_REUSED', params: { batchId: first.id } });
    });

    it('goes through the import’s checks: the cutoff, prescription and a duplicate', async () => {
      await expect(add(line({ citizenId: person.amal, year: CUTOFF }))).rejects.toMatchObject({
        code: 'ARREARS_LINE_REFUSED',
        details: { issues: ['YEAR_NOT_BEFORE_CUTOFF'] },
      });
      await expect(add(line({ citizenId: person.amal, year: PRESCRIBED }))).rejects.toMatchObject({ code: 'ARREARS_LINE_PRESCRIBED' });

      const input = line({ citizenId: person.bassem, propertyNumber: unique() });
      await add(input);
      await expect(add({ ...input, clientRequestId: randomUUID() })).rejects.toMatchObject({
        code: 'ARREARS_LINE_REFUSED',
        details: { issues: ['DUPLICATE_LIVE_LINE'] },
      });
    });

    it('does not take an archived file: restore it first', async () => {
      await expect(add(line({ citizenId: person.dalal }))).rejects.toMatchObject({ code: 'FEE_CITIZEN_ARCHIVED' });
    });

    it('keeps a person not on the register by the name in the books, waiting for a link', async () => {
      const view = await add(line({ sourceName: 'مقيم لم يسجَّل بعد' }));
      expect(await db.arrearsLine.findFirstOrThrow({ where: { batchId: view.id } })).toMatchObject({ citizenId: null, sourceName: 'مقيم لم يسجَّل بعد' });
      await approve(view.id);
      expect(await billsOf(view.id)).toHaveLength(0);
    });
  });

  describe('link a «للمطابقة» line', () => {
    const waiting = async (over: Record<string, unknown> = {}) => {
      const view = await within(() =>
        batches.addSingleLine(
          { propertyNumber: unique(), year: LAST, feeType: 'RENTAL_VALUE', component: 'PRINCIPAL', amount: 22_000, currency: 'LBP', clientRequestId: randomUUID(), sourceName: 'غريب', ...over } as never,
          ACCOUNTANT,
        ),
      );
      const line = await db.arrearsLine.findFirstOrThrow({ where: { batchId: view.id } });
      return { batchId: view.id, lineId: line.id, propertyNumber: line.propertyNumber };
    };

    it('raises its bill on the chosen file, stamps who and when, and does it once', async () => {
      const { batchId, lineId, propertyNumber } = await waiting();
      await approve(batchId);
      await expect(within(() => batches.link(lineId, { citizenId: person.fadi }, OTHER_ACCOUNTANT))).resolves.toMatchObject({ id: lineId });

      expect(await db.arrearsLine.findUniqueOrThrow({ where: { id: lineId } })).toMatchObject({ citizenId: person.fadi, linkedById: ids.otherAccountant });
      const [bill] = await billsOf(batchId);
      expect(bill).toMatchObject({ citizenId: person.fadi, issuedById: ids.otherAccountant, periodKey: String(LAST) });
      expect(bill!.invoiceNumber).toMatch(/^ARR-/);
      expect(await within(() => parcelDues.dues(propertyNumber))).toMatchObject({ total: 22_000 });
      expect(await db.auditLogEntry.count({ where: { action: 'ARREARS_LINE_LINKED', entityId: lineId } })).toBe(1);

      await expect(within(() => batches.link(lineId, { citizenId: person.amal }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_LINE_NOT_WAITING' });
      expect(await billsOf(batchId)).toHaveLength(1);
    });

    it('does not choose an archived file, and the line keeps waiting', async () => {
      const { batchId, lineId } = await waiting();
      await approve(batchId);
      await expect(within(() => batches.link(lineId, { citizenId: person.dalal }, ACCOUNTANT))).rejects.toMatchObject({ code: 'FEE_CITIZEN_ARCHIVED' });
      expect(await db.arrearsLine.findUniqueOrThrow({ where: { id: lineId } })).toMatchObject({ citizenId: null, linkedAt: null });
      expect(await billsOf(batchId)).toHaveLength(0);
    });

    it('is refused before the batch is approved, for a file folded into another, and for a debt the file already holds', async () => {
      const early = await waiting();
      await expect(within(() => batches.link(early.lineId, { citizenId: person.amal }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_LINE_NOT_WAITING' });

      const merged = await waiting();
      await approve(merged.batchId);
      await expect(within(() => batches.link(merged.lineId, { citizenId: person.elias }, ACCOUNTANT))).rejects.toMatchObject({ code: 'CITIZEN_MERGED_AWAY' });
      await expect(within(() => batches.link(randomUUID(), { citizenId: person.amal }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_LINE_NOT_FOUND' });

      const property = unique();
      const held = await draft([person.fadi], [debt(1, property, LAST, '22000')]);
      await submit(held);
      const twin = await waiting({ propertyNumber: property });
      await approve(twin.batchId);
      await approve(held);
      await expect(within(() => batches.link(twin.lineId, { citizenId: person.fadi }, ACCOUNTANT))).rejects.toMatchObject({ code: 'ARREARS_LINE_DUPLICATE' });
      expect(await billsOf(twin.batchId)).toHaveLength(0);
    });
  });

  describe('«دمج ملفين»', () => {
    const newCitizen = async (firstName: string) => {
      const id = randomUUID();
      await db.user.create({
        data: {
          id,
          kind: 'CITIZEN',
          tenantSlug: 'arb',
          firstName,
          middleName: 'محمد',
          lastName: 'سلمان',
          referenceNumber: `REF-${id.slice(0, 8)}`,
          phone: '+96170123456',
        },
      });
      return id;
    };
    const merge = async (keepId: string, absorbId: string) => {
      const preview = await within(() => merges.preview({ keepId, absorbId }));
      return within(() =>
        merges.merge({
          keepId,
          absorbId,
          reason: 'الشخص نفسه — ملف مكرر',
          expected: { keep: preview.keep.version, absorb: preview.absorb.version },
          tenantSlug: 'arb',
          actor: MANAGER,
        }),
      );
    };
    const undo = async (absorbId: string) => {
      const into = (await within(() => merges.mergesOf(absorbId))).into!;
      await within(() => merges.unmerge({ mergeId: into.id, reason: 'دُمجا خطأً — شخصان', tenantSlug: 'arb', actor: MANAGER }));
    };

    it('moves the absorbed person’s old debts with their bills, and the undo puts them back', async () => {
      const keep = await newCitizen('كريم');
      const absorb = await newCitizen('كريمة');
      const batch = await draft([absorb], [debt(1, unique(), LAST, '70000')]);
      await submit(batch);
      await approve(batch);
      const line = await db.arrearsLine.findFirstOrThrow({ where: { batchId: batch } });
      const place = await db.arrearsBatchCitizen.findFirstOrThrow({ where: { batchId: batch } });

      await merge(keep, absorb);
      expect(await db.arrearsLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ citizenId: keep });
      expect(await db.arrearsBatchCitizen.findUniqueOrThrow({ where: { id: place.id } })).toMatchObject({ citizenId: keep });
      // The bill and its line are on the same file.
      expect(await db.citizenPayment.findFirstOrThrow({ where: { arrearsLineId: line.id } })).toMatchObject({ citizenId: keep });

      await undo(absorb);
      expect(await db.arrearsLine.findUniqueOrThrow({ where: { id: line.id } })).toMatchObject({ citizenId: absorb });
      expect(await db.arrearsBatchCitizen.findUniqueOrThrow({ where: { id: place.id } })).toMatchObject({ citizenId: absorb });
      expect(await db.citizenPayment.findFirstOrThrow({ where: { arrearsLineId: line.id } })).toMatchObject({ citizenId: absorb });
    });

    it('leaves a live line on the absorbed file when the kept file already holds the same debt', async () => {
      const keep = await newCitizen('نادر');
      const absorb = await newCitizen('نادرة');
      const property = unique();
      // The same debt on two files is allowed: the index is per citizen. Merged, it would be one citizen twice.
      const kept = await draft([keep], [debt(1, property, LAST, '1000')]);
      const absorbed = await draft([absorb], [debt(1, property, LAST, '1000'), debt(1, property, OLDER, '2000')]);

      await merge(keep, absorb);
      const lines = await db.arrearsLine.findMany({ where: { batchId: absorbed }, orderBy: { year: 'asc' } });
      // The older debt moved; the one the kept file holds stayed, for the accountant to settle.
      expect(lines.map((line) => [line.year, line.citizenId])).toEqual([
        [OLDER, keep],
        [LAST, absorb],
      ]);
      expect(await db.arrearsLine.count({ where: { batchId: kept, citizenId: keep } })).toBe(1);

      await undo(absorb);
      expect((await db.arrearsLine.findMany({ where: { batchId: absorbed } })).every((line) => line.citizenId === absorb)).toBe(true);
    });
  });

  describe('the cutoff year, once a batch is approved', () => {
    it('is fixed: another year is refused and nothing changes, the same year is accepted', async () => {
      // Earlier cases approved batches in this schema.
      expect(await db.arrearsBatch.count({ where: { status: 'APPROVED' } })).toBeGreaterThan(0);
      const audits = await db.auditLogEntry.count({ where: { action: 'ARREARS_CUTOFF_CHANGED' } });

      await expect(setCutoff(CUTOFF + 1)).rejects.toMatchObject({ code: 'ARREARS_CUTOFF_LOCKED', params: { cutoffYear: CUTOFF } });
      await expect(setCutoff(null)).rejects.toMatchObject({ code: 'ARREARS_CUTOFF_LOCKED' });
      expect(await within(() => batches.settings())).toMatchObject({ arrearsCutoffYear: CUTOFF });
      expect(await db.auditLogEntry.count({ where: { action: 'ARREARS_CUTOFF_CHANGED' } })).toBe(audits);

      await expect(setCutoff(CUTOFF)).resolves.toMatchObject({ arrearsCutoffYear: CUTOFF });
    });
  });

  describe('the lists', () => {
    it('lists the batches newest first, and a review shows the totals and what approval would raise', async () => {
      const property = unique();
      const batch = await draft(
        [person.amal],
        [debt(1, property, LAST, '100000'), debt(1, property, OLDER, '40000', { feeType: 'CLEANING' })],
        [{ row: 2, component: 'PRINCIPAL', reason: 'سقط بقرار المجلس' }],
      );
      await submit(batch);
      const review = await within(() => batches.review(batch));
      expect(review.totals).toMatchObject({ kept: { count: 1, amount: 100_000 }, dropped: { count: 1, amount: 40_000 }, fileTotal: 140_000, controlTotal: 140_000 });
      expect(review.bills).toEqual({ count: 1, amount: 100_000, citizens: 1 });
      expect(review.byYearAndFee).toEqual([{ year: LAST, feeType: 'RENTAL_VALUE', component: 'PRINCIPAL', count: 1, amount: 100_000 }]);
      // The preparer's own drop is shown to the manager; prescription's would not be.
      expect(review.flagged).toMatchObject([{ status: 'DROP', dropReason: 'سقط بقرار المجلس' }]);

      const { items } = await within(() => batches.list());
      expect(items[0]!.createdAt >= items[items.length - 1]!.createdAt).toBe(true);
      expect(items.find((item) => item.id === batch)).toMatchObject({ status: 'SUBMITTED', lineCount: 2, preparedBy: { id: ids.accountant } });
    });
  });
});
