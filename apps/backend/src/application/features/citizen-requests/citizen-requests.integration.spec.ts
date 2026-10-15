import { randomInt, randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import type { RequestFileStorage } from '../../../domain/interfaces/request-file-storage.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ParcelDuesService } from '../fees/parcel-dues.service';
import { CitizenRequestsService, type RequestActor } from './citizen-requests.service';

/**
 * Municipal requests against a real tenant schema (migration 0092): the CHECKs
 * and the open-request index, filing online and at the counter, the retry key
 * and its race, the fee's bill raised once, the request following its bill to
 * PAID and back and to CANCELLED, the fee shown only while one is owed, a
 * براءة ذمة judged against what the property owes, the staff decisions, and the
 * papers. Synthetic people only.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_citizen_requests_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describeIfDb('CitizenRequestsService', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let service: CitizenRequestsService;
  let files: { put: jest.Mock; createSignedUrl: jest.Mock; remove: jest.Mock };
  let clerk: { id: string; role: string };
  /** Online payment is paused unless a test opens it (open-decisions §21). */
  const whish = { isLive: false };
  let staffActor: RequestActor;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-cr', tenantSlug: 'cr', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    files = {
      put: jest.fn(async (file: { requestId: string; extension: string }) => ({
        storagePath: `cr/requests/${file.requestId}/${randomUUID()}${file.extension}`,
      })),
      createSignedUrl: jest.fn(async () => 'https://bucket.example/signed'),
      remove: jest.fn(async () => undefined),
    };
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    service = new CitizenRequestsService(
      context,
      audit,
      new ParcelDuesService(context),
      new EventEmitter2(),
      files as unknown as RequestFileStorage,
      whish,
    );
    const clerkId = randomUUID();
    await db.user.create({
      data: {
        id: clerkId,
        kind: 'STAFF',
        tenantSlug: 'cr',
        firstName: 'موظف',
        lastName: 'القلم',
        email: `clerk-${clerkId}@example.test`,
        role: 'ADMINISTRATIVE_OFFICER',
      },
    });
    clerk = { id: clerkId, role: 'ADMINISTRATIVE_OFFICER' };
    staffActor = { kind: 'STAFF', ...clerk };
    await within(async () => {
      await service.updateType('CLEARANCE', { enabled: true, feeAmount: 200_000 }, { id: clerkId, role: 'SUPER_ADMIN' });
      await service.updateType('RESIDENCY', { enabled: true, feeAmount: 100_000 }, { id: clerkId, role: 'SUPER_ADMIN' });
      await service.updateType('OTHER', { enabled: true, feeAmount: 0 }, { id: clerkId, role: 'SUPER_ADMIN' });
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** A citizen with one card on a parcel of their own; its رقم العقار as typed, when given. */
  const citizenWithCard = async (propertyNumber = `5${randomUUID().slice(0, 5)}`) => {
    const id = randomUUID();
    await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'cr', firstName: 'سامر', lastName: 'تجربة' } });
    const registration = await db.registration.create({ data: { citizenId: id, referenceNumber: `CR-${randomUUID()}` } });
    const card = await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER', propertyType: 'LAND', propertyNumber },
    });
    return { id, cardId: card.id, propertyNumber, actor: { kind: 'CITIZEN', id } as RequestActor };
  };

  const fileOnline = (citizen: { id: string; cardId: string; actor: RequestActor }, overrides: Record<string, unknown> = {}) =>
    within(() =>
      service.submit(
        {
          citizenId: citizen.id,
          requestType: 'CLEARANCE',
          applicantCapacity: 'OWNER',
          propertyEntryId: citizen.cardId,
          clientRequestId: randomUUID(),
          ...overrides,
        } as never,
        citizen.actor,
      ),
    );

  const raw = (sql: string, values: unknown[] = []) => ddl.query(sql.replaceAll('%s', `"${SCHEMA}"`), values);

  /** A bill withdrawn as `FeesService.cancelBill` writes it, by a path that did not reach its request. */
  const cancelBillAlone = (citizenPaymentId: string) =>
    db.citizenPayment.update({
      where: { id: citizenPaymentId },
      data: {
        paymentStatus: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledById: clerk.id,
        cancellationReason: 'رسم الطلب صدر خطأً',
      },
    });

  describe('isolation', () => {
    it('answers another citizen\'s request as not found on every portal call, and writes nothing', async () => {
      const owner = await citizenWithCard();
      const other = await citizenWithCard();
      const filed = await fileOnline(owner);
      const scope = { citizenId: other.id };
      const notFound = { code: 'REQUEST_NOT_FOUND' };

      await expect(within(() => service.mineOne(other.id, filed.id))).rejects.toMatchObject(notFound);
      expect((await within(() => service.mine(other.id))).map((row: { id: string }) => row.id)).not.toContain(filed.id);
      const puts = files.put.mock.calls.length;
      await expect(
        within(() => service.addAttachment(filed.id, { buffer: PDF, size: PDF.length }, 'IDENTITY', other.actor, scope)),
      ).rejects.toMatchObject(notFound);
      expect(files.put.mock.calls.length).toBe(puts);
      // Online payment opened for this call, so the refusal is the scope's and not the pause's.
      whish.isLive = true;
      try {
        await expect(within(() => service.raiseBill(filed.id, other.actor, scope))).rejects.toMatchObject(notFound);
      } finally {
        whish.isLive = false;
      }
      await expect(within(() => service.cancel(filed.id, other.actor, scope))).rejects.toMatchObject(notFound);

      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).toMatchObject({
        status: 'AWAITING_PAYMENT',
        citizenPaymentId: null,
      });
      expect(await db.citizenRequestAttachment.count({ where: { requestId: filed.id } })).toBe(0);
    });

    it('does not reach a request from another municipality\'s schema, even with its citizen\'s id', async () => {
      const OTHER_SCHEMA = 'tenant_citizen_requests_spec_other';
      await ddl.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
      await migrateTenantSchema(ddl, OTHER_SCHEMA);
      const otherDb = tenantTestClient(TEST_DATABASE_URL!, OTHER_SCHEMA);
      try {
        const owner = await citizenWithCard();
        const filed = await fileOnline(owner);
        const elsewhere = <T>(work: () => Promise<T>): Promise<T> =>
          context.run({ tenantId: 'tenant-other', tenantSlug: 'other', schemaName: OTHER_SCHEMA, prisma: otherDb }, work);

        await expect(elsewhere(() => service.mineOne(owner.id, filed.id))).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
        await expect(elsewhere(() => service.cancel(filed.id, owner.actor, { citizenId: owner.id }))).rejects.toMatchObject({
          code: 'REQUEST_NOT_FOUND',
        });
        expect((await elsewhere(() => service.queue({ page: 1, pageSize: 50 } as never))).items).toHaveLength(0);
        expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('AWAITING_PAYMENT');
      } finally {
        await otherDb.$disconnect();
        await ddl.query(`DROP SCHEMA IF EXISTS "${OTHER_SCHEMA}" CASCADE`);
      }
    }, SETUP_TIMEOUT_MS);
  });

  describe('the table', () => {
    it('refuses a counter request that names no clerk, a rejection with no reason, a request that skips a step, and a cancellation over a live bill', async () => {
      const citizen = await citizenWithCard();
      const insert = (channel: string, extraColumns = '', extraValues = '', extra: unknown[] = []) =>
        raw(
          `INSERT INTO %s.citizen_requests ("requestNumber","citizenId","channel","requestType","applicantCapacity","clientRequestId"${extraColumns})
           VALUES ($1,$2,$3,'OTHER','OWNER',gen_random_uuid()${extraValues}) RETURNING "id"`,
          [`REQ-T-${randomUUID().slice(0, 6)}`, citizen.id, channel, ...extra],
        );
      // 0092's CHECKs.
      await expect(insert('COUNTER')).rejects.toThrow(/citizen_requests_counter_names_clerk/);
      const { rows } = await insert('ONLINE');
      const id = rows[0].id as string;
      await expect(
        raw(`UPDATE %s.citizen_requests SET "status"='REJECTED',"rejectedAt"=now(),"rejectedById"=$2 WHERE "id"=$1`, [id, clerk.id]),
      ).rejects.toThrow(/citizen_requests_rejected_stamp/);
      // 0094's guard: a request starts AWAITING_PAYMENT or IN_REVIEW, and is not cancelled over a live bill.
      await expect(insert('ONLINE', ',"status"', `,'READY_FOR_PICKUP'`)).rejects.toThrow(/a request starts AWAITING_PAYMENT or IN_REVIEW/);
      const live = await db.citizenPayment.create({
        data: { citizenId: citizen.id, title: 'رسم الطلب', amount: 100_000, dueDate: new Date('2030-12-31') },
      });
      await raw(`UPDATE %s.citizen_requests SET "citizenPaymentId"=$2 WHERE "id"=$1`, [id, live.id]);
      await expect(
        raw(`UPDATE %s.citizen_requests SET "status"='CANCELLED',"cancelledAt"=now() WHERE "id"=$1`, [id]),
      ).rejects.toThrow(/cancelled while its bill .* still stands/);
    });
  });

  describe('filing', () => {
    it('files an online request with a «REQ-» number, awaiting its fee, and audits it without its free text', async () => {
      const citizen = await citizenWithCard();
      const result = await fileOnline(citizen, { purpose: 'لبيع العقار — اسم المشتري سامي' });
      expect(result).toMatchObject({ status: 'AWAITING_PAYMENT', fee: 200_000, replayed: false });
      expect(result.requestNumber).toMatch(/^REQ-\d{4}-\d{4,}$/);
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: result.id } });
      expect(row).toMatchObject({ channel: 'ONLINE', createdById: null, citizenPaymentId: null });
      const audit = await db.auditLogEntry.findMany({ where: { action: 'REQUEST_SUBMITTED', entityId: result.id } });
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]!.after)).not.toContain('سامي');
    });

    it('starts a free type in review, with no bill', async () => {
      const citizen = await citizenWithCard();
      const result = await fileOnline(citizen, { requestType: 'OTHER', propertyEntryId: undefined });
      expect(result).toMatchObject({ status: 'IN_REVIEW', fee: 0 });
    });

    it('refuses a type the municipality has not switched on, a missing card, and another citizen’s card', async () => {
      const citizen = await citizenWithCard();
      const other = await citizenWithCard();
      await expect(fileOnline(citizen, { requestType: 'SIGNAGE' })).rejects.toMatchObject({ code: 'REQUEST_TYPE_NOT_OFFERED' });
      await expect(fileOnline(citizen, { propertyEntryId: undefined })).rejects.toMatchObject({
        code: 'REQUEST_PROPERTY_REQUIRED',
      });
      await expect(fileOnline(citizen, { propertyEntryId: other.cardId })).rejects.toMatchObject({
        code: 'REQUEST_PROPERTY_NOT_YOURS',
      });
    });

    it('keeps one open request per citizen, type and card', async () => {
      const citizen = await citizenWithCard();
      const first = await fileOnline(citizen);
      await expect(fileOnline(citizen)).rejects.toMatchObject({
        code: 'REQUEST_ALREADY_OPEN',
        params: { number: first.requestNumber },
      });
    });

    it('records the clerk on a counter request', async () => {
      const citizen = await citizenWithCard();
      const result = await within(() =>
        service.submit(
          { citizenId: citizen.id, requestType: 'RESIDENCY', applicantCapacity: 'TENANT', clientRequestId: randomUUID() },
          staffActor,
        ),
      );
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: result.id } });
      expect(row).toMatchObject({ channel: 'COUNTER', createdById: clerk.id });
    });
  });

  describe('the retry key', () => {
    it('answers a second press with the first request, and refuses the key for another request', async () => {
      const citizen = await citizenWithCard();
      const key = randomUUID();
      const first = await fileOnline(citizen, { clientRequestId: key });
      const again = await fileOnline(citizen, { clientRequestId: key });
      expect(again).toMatchObject({ id: first.id, requestNumber: first.requestNumber, replayed: true });
      await expect(fileOnline(citizen, { clientRequestId: key, requestType: 'RESIDENCY' })).rejects.toMatchObject({
        code: 'REQUEST_KEY_REUSED',
      });
    });

    it('refuses the key when the press after a lost answer changed what the paper reads', async () => {
      const citizen = await citizenWithCard();
      const key = randomUUID();
      const first = await fileOnline(citizen, { clientRequestId: key, purpose: 'للمدرسة' });
      // Another capacity, or another purpose, under the same key: refused, naming the first.
      await expect(fileOnline(citizen, { clientRequestId: key, purpose: 'للمدرسة', applicantCapacity: 'TENANT' })).rejects.toMatchObject({
        code: 'REQUEST_KEY_REUSED',
        params: { number: first.requestNumber },
      });
      await expect(fileOnline(citizen, { clientRequestId: key, purpose: 'لكاتب العدل' })).rejects.toMatchObject({
        code: 'REQUEST_KEY_REUSED',
      });
      expect(await db.citizenRequest.count({ where: { clientRequestId: key } })).toBe(1);
    });

    it('files once when two presses race', async () => {
      const citizen = await citizenWithCard();
      const key = randomUUID();
      const results = await Promise.all([fileOnline(citizen, { clientRequestId: key }), fileOnline(citizen, { clientRequestId: key })]);
      expect(new Set(results.map((result) => result.requestNumber)).size).toBe(1);
      expect(results.filter((result) => result.replayed)).toHaveLength(1);
      expect(await db.citizenRequest.count({ where: { clientRequestId: key } })).toBe(1);
    });
  });

  describe('the fee', () => {
    it('raises no bill on a file archived since it was filed, as no other fee is (FEE_CITIZEN_ARCHIVED)', async () => {
      const citizen = await citizenWithCard();
      const filed = await within(() =>
        service.submit(
          { citizenId: citizen.id, requestType: 'RESIDENCY', applicantCapacity: 'OWNER', clientRequestId: randomUUID() },
          staffActor,
        ),
      );
      await db.user.update({ where: { id: citizen.id }, data: { isActive: false } });
      await expect(within(() => service.raiseBill(filed.id, staffActor))).rejects.toMatchObject({
        code: 'FEE_CITIZEN_ARCHIVED',
      });
      expect(await db.citizenPayment.count({ where: { citizenId: citizen.id } })).toBe(0);
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).citizenPaymentId).toBeNull();
    });

    it('is not raised by the citizen while online payment is paused, and leaves the request cancellable', async () => {
      const citizen = await citizenWithCard();
      const filed = await fileOnline(citizen);
      await within(() =>
        service.addAttachment(filed.id, { buffer: JPEG, size: JPEG.length }, 'IDENTITY', citizen.actor, { citizenId: citizen.id }),
      );
      await expect(within(() => service.raiseBill(filed.id, citizen.actor, { citizenId: citizen.id }))).rejects.toMatchObject({
        code: 'ONLINE_PAYMENT_UNAVAILABLE',
      });
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } });
      expect(row.citizenPaymentId).toBeNull();
      expect(await db.citizenPayment.count({ where: { citizenId: citizen.id } })).toBe(0);
      await within(() => service.cancel(filed.id, citizen.actor, { citizenId: citizen.id }));
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('CANCELLED');
    });

    it('raises the bill at the counter once an online request carries an identity copy, and answers it again after', async () => {
      const citizen = await citizenWithCard();
      const filed = await fileOnline(citizen);
      await expect(within(() => service.raiseBill(filed.id, staffActor))).rejects.toMatchObject({
        code: 'REQUEST_IDENTITY_COPY_REQUIRED',
      });
      await within(() =>
        service.addAttachment(filed.id, { buffer: JPEG, size: JPEG.length }, 'IDENTITY', citizen.actor, { citizenId: citizen.id }),
      );
      const bill = await within(() => service.raiseBill(filed.id, staffActor));
      expect(bill).toMatchObject({ amount: 200_000, currency: 'LBP', existed: false });
      expect(bill.invoiceNumber).toMatch(/^INV-\d{4}-\d{4,}$/);
      const payment = await db.citizenPayment.findUniqueOrThrow({ where: { id: bill.citizenPaymentId } });
      expect(payment).toMatchObject({ citizenId: citizen.id, title: 'رسم براءة ذمة بلدية', paymentStatus: 'UNPAID' });
      const again = await within(() => service.raiseBill(filed.id, staffActor));
      expect(again).toMatchObject({ citizenPaymentId: bill.citizenPaymentId, existed: true });
      // Once online payment opens, the citizen's own route answers the same bill.
      whish.isLive = true;
      try {
        const online = await within(() => service.raiseBill(filed.id, citizen.actor, { citizenId: citizen.id }));
        expect(online).toMatchObject({ citizenPaymentId: bill.citizenPaymentId, existed: true });
      } finally {
        whish.isLive = false;
      }
      // Billed and unpaid: neither the citizen nor a clerk can cancel it now (D10).
      await expect(within(() => service.cancel(filed.id, citizen.actor, { citizenId: citizen.id }))).rejects.toMatchObject({
        code: 'REQUEST_BILL_OPEN',
      });
    });

    it('moves to review when its bill is paid, and back if the payment is reversed', async () => {
      const citizen = await citizenWithCard();
      const filed = await within(() =>
        service.submit(
          { citizenId: citizen.id, requestType: 'RESIDENCY', applicantCapacity: 'OWNER', clientRequestId: randomUUID() },
          staffActor,
        ),
      );
      const bill = await within(() => service.raiseBill(filed.id, staffActor));
      // Part-paid: still waiting.
      await db.citizenPayment.update({ where: { id: bill.citizenPaymentId }, data: { paidAmount: 50_000 } });
      await within(() => service.onPaymentReviewed({ paymentId: bill.citizenPaymentId }));
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('AWAITING_PAYMENT');

      await db.citizenPayment.update({
        where: { id: bill.citizenPaymentId },
        data: { paidAmount: 100_000, paymentStatus: 'PAID', paidAt: new Date() },
      });
      await within(() => service.onPaymentReviewed({ paymentId: bill.citizenPaymentId }));
      const paid = await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } });
      expect(paid.status).toBe('IN_REVIEW');
      expect(paid.paidAt).not.toBeNull();
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_PAID', entityId: filed.id } })).toBe(1);

      await db.citizenPayment.update({
        where: { id: bill.citizenPaymentId },
        data: { paidAmount: 0, paymentStatus: 'UNPAID', paidAt: null },
      });
      // A lost event is caught up by the next read.
      const view = await within(() => service.get(filed.id));
      expect(view.status).toBe('AWAITING_PAYMENT');
    });

    it('goes to review without a bill when its type became free before it was billed', async () => {
      const manager = { id: clerk.id, role: 'SUPER_ADMIN' };
      await within(() => service.updateType('OCCUPANCY', { enabled: true, feeAmount: 75_000 }, manager));
      const atCounter = (citizen: { id: string; cardId: string }) =>
        within(() =>
          service.submit(
            {
              citizenId: citizen.id,
              requestType: 'OCCUPANCY',
              applicantCapacity: 'OWNER',
              propertyEntryId: citizen.cardId,
              clientRequestId: randomUUID(),
            },
            staffActor,
          ),
        );
      const unbilled = await atCounter(await citizenWithCard());
      const billed = await atCounter(await citizenWithCard());
      await within(() => service.raiseBill(billed.id, staffActor));
      expect(unbilled.status).toBe('AWAITING_PAYMENT');

      await within(() => service.updateType('OCCUPANCY', { enabled: true, feeAmount: 0 }, manager));
      const view = await within(() => service.get(unbilled.id));
      // Past the wait with no bill: it shows no fee, not the type's (`feeShown`).
      expect(view).toMatchObject({ status: 'IN_REVIEW', fee: null, bill: null });
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: unbilled.id } });
      expect(row.paidAt).toBeNull();
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_FEE_WAIVED', entityId: unbilled.id } })).toBe(1);
      // A request already billed keeps its bill and its wait: the fee was the one in force then (D1).
      expect(await within(() => service.get(billed.id))).toMatchObject({ status: 'AWAITING_PAYMENT', fee: 75_000 });
    });

    it('shows the type’s fee only while a request waits for its bill, and none once it never will be billed', async () => {
      const citizen = await citizenWithCard();
      const filed = await fileOnline(citizen);
      // Waiting, not yet billed: what the bill will be.
      expect(await within(() => service.get(filed.id))).toMatchObject({ status: 'AWAITING_PAYMENT', fee: 200_000, bill: null });

      await within(() => service.cancel(filed.id, citizen.actor, { citizenId: citizen.id }));
      // Cancelled before any bill: no fee on any of the three reads, whatever the type costs today.
      expect(await within(() => service.get(filed.id))).toMatchObject({ status: 'CANCELLED', fee: null });
      const [mine] = await within(() => service.mine(citizen.id));
      expect(mine).toMatchObject({ id: filed.id, fee: null });
      const queue = await within(() => service.queue({ page: 1, pageSize: 100, search: filed.requestNumber } as never));
      expect(queue.items).toMatchObject([{ id: filed.id, fee: null, billStatus: null }]);

      const rejected = await fileOnline(await citizenWithCard());
      await within(() => service.reject(rejected.id, 'الطلب لا يخص هذا العقار', clerk));
      expect(await within(() => service.get(rejected.id))).toMatchObject({ status: 'REJECTED', fee: null });
    });
  });

  describe('a cancelled bill', () => {
    it('cancels a request a lost reversal left in review once its bill is cancelled, on the next read, and frees its place', async () => {
      const citizen = await citizenWithCard();
      const residency = () =>
        within(() =>
          service.submit(
            { citizenId: citizen.id, requestType: 'RESIDENCY', applicantCapacity: 'OWNER', clientRequestId: randomUUID() },
            staffActor,
          ),
        );
      const filed = await residency();
      const bill = await within(() => service.raiseBill(filed.id, staffActor));
      await db.citizenPayment.update({
        where: { id: bill.citizenPaymentId },
        data: { paidAmount: 100_000, paymentStatus: 'PAID', paidAt: new Date() },
      });
      await within(() => service.onPaymentReviewed({ paymentId: bill.citizenPaymentId }));
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('IN_REVIEW');

      // The receipt reversed, and its event lost (`onPaymentReversed` is never called: a restart).
      await db.citizenPayment.update({
        where: { id: bill.citizenPaymentId },
        data: { paidAmount: 0, paymentStatus: 'UNPAID', paidAt: null },
      });
      await cancelBillAlone(bill.citizenPaymentId);
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('IN_REVIEW');

      // The next read: cancelled, where it once went back to AWAITING_PAYMENT on a bill nobody can pay.
      expect(await within(() => service.get(filed.id))).toMatchObject({ status: 'CANCELLED', bill: { paymentStatus: 'CANCELLED' } });
      expect(await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).toMatchObject({
        paidAt: null,
        cancelledById: null,
      });
      const cancelled = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_CANCELLED', entityId: filed.id } });
      expect(cancelled).toMatchObject({
        actorId: null,
        actorType: 'SYSTEM',
        after: { status: 'CANCELLED', cause: 'BILL_CANCELLED', citizenPaymentId: bill.citizenPaymentId },
      });
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_PAYMENT_REVERSED', entityId: filed.id } })).toBe(1);
      // `citizen_requests_one_open_key` no longer holds it: the citizen can file it again.
      expect(await residency()).toMatchObject({ status: 'AWAITING_PAYMENT', replayed: false });
    });

    it('heals a request already left waiting on a cancelled bill, on the citizen’s own read', async () => {
      const citizen = await citizenWithCard();
      const filed = await within(() =>
        service.submit(
          { citizenId: citizen.id, requestType: 'RESIDENCY', applicantCapacity: 'OWNER', clientRequestId: randomUUID() },
          staffActor,
        ),
      );
      const bill = await within(() => service.raiseBill(filed.id, staffActor));
      // The state the old reconcile left behind: AWAITING_PAYMENT on a CANCELLED bill.
      await cancelBillAlone(bill.citizenPaymentId);
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('AWAITING_PAYMENT');

      const [mine] = await within(() => service.mine(citizen.id));
      expect(mine).toMatchObject({ id: filed.id, status: 'CANCELLED' });
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_PAYMENT_REVERSED', entityId: filed.id } })).toBe(0);
      expect(
        await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_CANCELLED', entityId: filed.id } }),
      ).toMatchObject({ actorType: 'SYSTEM', after: { cause: 'BILL_CANCELLED' } });
    });
  });

  describe('the staff decisions', () => {
    const paidRequest = async (type: 'CLEARANCE' | 'RESIDENCY', holder?: Awaited<ReturnType<typeof citizenWithCard>>) => {
      const citizen = holder ?? (await citizenWithCard());
      const filed = await within(() =>
        service.submit(
          {
            citizenId: citizen.id,
            requestType: type,
            applicantCapacity: 'OWNER',
            propertyEntryId: citizen.cardId,
            clientRequestId: randomUUID(),
          },
          staffActor,
        ),
      );
      const bill = await within(() => service.raiseBill(filed.id, staffActor));
      await db.citizenPayment.update({
        where: { id: bill.citizenPaymentId },
        data: { paidAmount: bill.amount, paymentStatus: 'PAID', paidAt: new Date() },
      });
      await within(() => service.reconcile({ requestIds: [filed.id] }));
      return { citizen, filed };
    };

    it('refuses a براءة ذمة while the property owes, and keeps the check on the request once clear', async () => {
      const { citizen, filed } = await paidRequest('CLEARANCE');
      const owing = await db.citizenPayment.create({
        data: {
          citizenId: citizen.id,
          title: 'رسم القيمة التأجيرية',
          amount: 40_000,
          dueDate: new Date('2030-12-31'),
          assessment: {
            basis: 'PER_AREA',
            rate: 1000,
            unitCount: 1,
            totalArea: 40,
            excludedUnitCount: 0,
            heldUnitCount: 0,
            uninhabitableUnitCount: 0,
            lines: [{ propertyNumber: citizen.propertyNumber, propertyType: 'LAND', unitType: 'APARTMENT', unitArea: 40 }],
          } as never,
        },
      });
      await expect(within(() => service.approve(filed.id, 'لا رسوم مستحقة على العقار.', clerk))).rejects.toMatchObject({
        code: 'REQUEST_CLEARANCE_DUES_OUTSTANDING',
        params: { total: 40_000 },
      });

      await db.citizenPayment.update({ where: { id: owing.id }, data: { paidAmount: 40_000, paymentStatus: 'PAID' } });
      const ready = await within(() => service.approve(filed.id, 'لا رسوم مستحقة على العقار.', clerk));
      expect(ready.status).toBe('READY_FOR_PICKUP');
      expect(ready.clearance).toMatchObject({ propertyNumber: citizen.propertyNumber, total: 0 });
      expect(ready.statement).toBe('لا رسوم مستحقة على العقار.');
    });

    it('refuses a براءة ذمة on a card typed in Arabic-Indic digits while the property owes, and checks it in Latin digits', async () => {
      const latin = `7${randomInt(10 ** 8, 10 ** 9)}`;
      const typed = latin.replace(/\d/g, (digit) => String.fromCharCode(0x0660 + Number(digit)));
      const { citizen, filed } = await paidRequest('CLEARANCE', await citizenWithCard(typed));
      expect(citizen.propertyNumber).toBe(typed);
      // The bill's line copies the card as it was typed, «٧…».
      const owing = await db.citizenPayment.create({
        data: {
          citizenId: citizen.id,
          title: 'رسم القيمة التأجيرية',
          amount: 40_000,
          dueDate: new Date('2030-12-31'),
          assessment: {
            basis: 'PER_AREA',
            rate: 1000,
            unitCount: 1,
            totalArea: 40,
            excludedUnitCount: 0,
            heldUnitCount: 0,
            uninhabitableUnitCount: 0,
            lines: [{ propertyNumber: typed, propertyType: 'LAND', unitType: 'APARTMENT', unitArea: 40 }],
          } as never,
        },
      });
      // `approve` passes the card's own value, not the HTTP route's normalised one.
      await expect(within(() => service.approve(filed.id, 'لا رسوم مستحقة على العقار.', clerk))).rejects.toMatchObject({
        code: 'REQUEST_CLEARANCE_DUES_OUTSTANDING',
        params: { total: 40_000 },
      });
      expect((await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } })).status).toBe('IN_REVIEW');

      await db.citizenPayment.update({ where: { id: owing.id }, data: { paidAmount: 40_000, paymentStatus: 'PAID' } });
      const ready = await within(() => service.approve(filed.id, 'لا رسوم مستحقة على العقار.', clerk));
      expect(ready.clearance).toMatchObject({ propertyNumber: latin, total: 0 });
    });

    it('does not hold a براءة ذمة on a bill the manager cancelled: it owes nothing (0090)', async () => {
      const { citizen, filed } = await paidRequest('CLEARANCE');
      // Raised on the property and then withdrawn («إلغاء الفاتورة»), as `FeesService.cancelBill` writes it.
      await db.citizenPayment.create({
        data: {
          citizenId: citizen.id,
          title: 'رسم صدر خطأً',
          amount: 55_000,
          dueDate: new Date('2030-12-31'),
          paymentStatus: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: clerk.id,
          cancellationReason: 'صدر الرسم مرتين',
          assessment: {
            basis: 'PER_AREA',
            rate: 1000,
            unitCount: 1,
            totalArea: 55,
            excludedUnitCount: 0,
            heldUnitCount: 0,
            uninhabitableUnitCount: 0,
            lines: [{ propertyNumber: citizen.propertyNumber, propertyType: 'LAND', unitType: 'APARTMENT', unitArea: 55 }],
          } as never,
        },
      });
      const ready = await within(() => service.approve(filed.id, 'لا رسوم مستحقة على العقار.', clerk));
      expect(ready.status).toBe('READY_FOR_PICKUP');
      expect(ready.clearance).toMatchObject({ propertyNumber: citizen.propertyNumber, total: 0, unlinkedTotal: 0 });
    });

    it('hands over an approved request, and refuses a step from the wrong status', async () => {
      const { filed } = await paidRequest('RESIDENCY');
      await expect(within(() => service.complete(filed.id, clerk))).rejects.toMatchObject({
        code: 'REQUEST_STATE_CHANGED',
        params: { status: 'IN_REVIEW' },
      });
      await within(() => service.approve(filed.id, 'يقيم في نطاق البلدية.', clerk));
      const done = await within(() => service.complete(filed.id, clerk));
      expect(done.status).toBe('COMPLETED');
      expect(done.completedAt).not.toBeNull();
    });

    it('rejects a paid request with its reason, which stays out of the audit row', async () => {
      const { filed } = await paidRequest('RESIDENCY');
      const rejected = await within(() => service.reject(filed.id, 'المستندات غير مكتملة — ينقص سند الملكية', clerk));
      expect(rejected).toMatchObject({ status: 'REJECTED', rejectionReason: 'المستندات غير مكتملة — ينقص سند الملكية' });
      const audit = await db.auditLogEntry.findFirstOrThrow({ where: { action: 'REQUEST_REJECTED', entityId: filed.id } });
      expect(JSON.stringify(audit.after)).not.toContain('سند');
      expect(audit.after).toMatchObject({ paid: true });
    });

    it('lets a citizen cancel their own unbilled request, and nobody else’s', async () => {
      const citizen = await citizenWithCard();
      const stranger = await citizenWithCard();
      const filed = await fileOnline(citizen);
      await expect(within(() => service.cancel(filed.id, stranger.actor, { citizenId: stranger.id }))).rejects.toMatchObject({
        code: 'REQUEST_NOT_FOUND',
      });
      await within(() => service.cancel(filed.id, citizen.actor, { citizenId: citizen.id }));
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: filed.id } });
      expect(row).toMatchObject({ status: 'CANCELLED', cancelledById: null });
    });
  });

  describe('the papers', () => {
    it('types a paper from its bytes, refuses what it cannot read, and removes the object when the row cannot be written', async () => {
      const citizen = await citizenWithCard();
      const filed = await fileOnline(citizen);
      const added = await within(() =>
        service.addAttachment(filed.id, { buffer: PDF, size: PDF.length }, 'OWNERSHIP_PROOF', citizen.actor, {
          citizenId: citizen.id,
        }),
      );
      expect(added).toMatchObject({ type: 'OWNERSHIP_PROOF', mimeType: 'application/pdf', uploadedByKind: 'CITIZEN' });

      const script = Buffer.from('<script>alert(1)</script>');
      await expect(
        within(() =>
          service.addAttachment(filed.id, { buffer: script, size: script.length }, 'OTHER', citizen.actor, { citizenId: citizen.id }),
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_ATTACHMENT_UNSUPPORTED' });

      // Closed while the object was being written: the row is refused and the object removed.
      // The write is held open until the request is cancelled, so the order is fixed, not raced.
      files.remove.mockClear();
      let entered!: () => void;
      let release!: () => void;
      const writing = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      files.put.mockImplementationOnce(async (file: { requestId: string; extension: string }) => {
        entered();
        await gate;
        return { storagePath: `cr/requests/${file.requestId}/${randomUUID()}${file.extension}` };
      });
      const closing = within(() =>
        service.addAttachment(filed.id, { buffer: PDF, size: PDF.length }, 'OTHER', citizen.actor, { citizenId: citizen.id }),
      );
      await writing;
      await db.citizenRequest.update({ where: { id: filed.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      release();
      await expect(closing).rejects.toMatchObject({ code: 'REQUEST_ATTACHMENTS_CLOSED' });
      expect(files.remove).toHaveBeenCalledTimes(1);
    });

    it('opens a paper for staff through a short link, and audits the view', async () => {
      const citizen = await citizenWithCard();
      const filed = await fileOnline(citizen);
      const added = await within(() =>
        service.addAttachment(filed.id, { buffer: JPEG, size: JPEG.length }, 'IDENTITY', citizen.actor, { citizenId: citizen.id }),
      );
      const link = await within(() => service.attachmentUrl(filed.id, added.id, clerk));
      expect(link).toEqual({ url: 'https://bucket.example/signed', expiresInSeconds: 300 });
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_ATTACHMENT_VIEWED', entityId: filed.id } })).toBe(1);
      await expect(within(() => service.attachmentUrl(filed.id, randomUUID(), clerk))).rejects.toMatchObject({
        code: 'REQUEST_ATTACHMENT_NOT_FOUND',
      });
    });
  });
});
