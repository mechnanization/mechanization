import { randomUUID } from 'node:crypto';
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
 * PAID and back, a براءة ذمة judged against what the property owes, the staff
 * decisions, and the papers. Synthetic people only.
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

  /** A citizen with one card on a parcel of their own. */
  const citizenWithCard = async () => {
    const id = randomUUID();
    await db.user.create({ data: { id, kind: 'CITIZEN', tenantSlug: 'cr', firstName: 'سامر', lastName: 'تجربة' } });
    const registration = await db.registration.create({ data: { citizenId: id, referenceNumber: `CR-${randomUUID()}` } });
    const propertyNumber = `5${randomUUID().slice(0, 5)}`;
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

  describe('the table', () => {
    it('refuses a counter request that names no clerk, a rejection with no reason, and a cancelled request with a bill', async () => {
      const citizen = await citizenWithCard();
      const insert = (columns: string, values: string) =>
        raw(
          `INSERT INTO %s.citizen_requests ("requestNumber","citizenId","channel","requestType","applicantCapacity","clientRequestId"${columns})
           VALUES ($1,$2,$3,'OTHER','OWNER',gen_random_uuid()${values})`,
          [`REQ-T-${randomUUID().slice(0, 6)}`, citizen.id, 'COUNTER'],
        );
      await expect(insert('', '')).rejects.toThrow(/citizen_requests_counter_names_clerk/);
      await expect(
        raw(
          `INSERT INTO %s.citizen_requests ("requestNumber","citizenId","channel","requestType","applicantCapacity","clientRequestId","status","rejectedAt","rejectedById")
           VALUES ($1,$2,'ONLINE','OTHER','OWNER',gen_random_uuid(),'REJECTED',now(),$3)`,
          [`REQ-T-${randomUUID().slice(0, 6)}`, citizen.id, clerk.id],
        ),
      ).rejects.toThrow(/citizen_requests_rejected_stamp/);
      await expect(
        raw(
          `INSERT INTO %s.citizen_requests ("requestNumber","citizenId","channel","requestType","applicantCapacity","clientRequestId","status","cancelledAt")
           VALUES ($1,$2,'ONLINE','OTHER','OWNER',gen_random_uuid(),'READY_FOR_PICKUP',now())`,
          [`REQ-T-${randomUUID().slice(0, 6)}`, citizen.id],
        ),
      ).rejects.toThrow(/citizen_requests_(ready|cancelled)_stamp/);
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
      expect(view).toMatchObject({ status: 'IN_REVIEW', fee: 0, bill: null });
      const row = await db.citizenRequest.findUniqueOrThrow({ where: { id: unbilled.id } });
      expect(row.paidAt).toBeNull();
      expect(await db.auditLogEntry.count({ where: { action: 'REQUEST_FEE_WAIVED', entityId: unbilled.id } })).toBe(1);
      // A request already billed keeps its bill and its wait: the fee was the one in force then (D1).
      expect(await within(() => service.get(billed.id))).toMatchObject({ status: 'AWAITING_PAYMENT', fee: 75_000 });
    });
  });

  describe('the staff decisions', () => {
    const paidRequest = async (type: 'CLEARANCE' | 'RESIDENCY') => {
      const citizen = await citizenWithCard();
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
