import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import {
  citizenDisplayName,
  getLabels,
  municipalToday,
  OPEN_REQUEST_STATUSES,
  REQUEST_ATTACHMENTS_MAX,
  REQUEST_STATUSES_TAKING_ATTACHMENTS,
  REQUEST_TYPE,
  requestNeedsProperty,
  type CitizenRequestListResult,
  type CitizenRequestView,
  type ListRequestsQuery,
  type MyCitizenRequestView,
  type RaiseRequestBillResult,
  type RequestAttachmentType,
  type RequestAttachmentUrl,
  type RequestAttachmentView,
  type RequestBillView,
  type RequestClearanceSnapshot,
  type RequestPropertyView,
  type RequestStatus,
  type RequestType,
  type RequestTypeSettingView,
  type SubmitRequestResult,
  type UpdateRequestTypeSettingInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import {
  REQUEST_FILE_STORAGE,
  type RequestFileStorage,
} from '../../../domain/interfaces/request-file-storage.interface';
import { WHISH_GATEWAY, type WhishGateway } from '../../../domain/interfaces/whish-gateway.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { allocateDocumentNumber } from '../../common/document-number';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { sniffAttachment } from '../../common/file-sniff';
import { AuditService, type AuditEntryInput } from '../audit/audit.service';
import { assertNotMergedAway } from '../citizens/merged-away';
import { raiseOneOffBill } from '../fees/one-off-bill';
import { ParcelDuesService } from '../fees/parcel-dues.service';
import { isUniqueViolationOn } from '../treasury/retry-key';

/** Who is acting: a citizen through the portal, or a member of staff. */
export type RequestActor = { kind: 'CITIZEN'; id: string } | { kind: 'STAFF'; id: string; role: string };

/** What a citizen-scoped call is limited to: their own requests. */
interface Scope {
  citizenId?: string;
}

/** How long a request's fee bill stays due before it reads as overdue. */
const BILL_DUE_DAYS = 30;

/** How long a staff link to a paper lives. Same as the registration documents (`APP_CONFIG.documents`). */
const ATTACHMENT_URL_TTL_SECONDS = 300;

const REQUEST_SELECT = {
  id: true,
  requestNumber: true,
  status: true,
  channel: true,
  requestType: true,
  applicantCapacity: true,
  citizenId: true,
  purpose: true,
  statement: true,
  rejectionReason: true,
  clearanceSnapshot: true,
  createdAt: true,
  paidAt: true,
  readyAt: true,
  completedAt: true,
  rejectedAt: true,
  cancelledAt: true,
  citizen: {
    select: {
      id: true,
      firstName: true,
      middleName: true,
      lastName: true,
      residence: true,
      referenceNumber: true,
      identityDocNumber: true,
    },
  },
  propertyEntry: {
    select: { id: true, propertyNumber: true, propertyType: true, neighborhood: true, buildingName: true },
  },
  buildingUnit: { select: { id: true, floor: true, unit: { select: { unitCode: true } } } },
  citizenPayment: {
    select: {
      id: true,
      invoiceNumber: true,
      amount: true,
      paidAmount: true,
      currency: true,
      paymentStatus: true,
      dueDate: true,
    },
  },
  attachments: {
    select: { id: true, type: true, mimeType: true, sizeBytes: true, createdAt: true, uploadedBy: { select: { kind: true } } },
    orderBy: { createdAt: 'asc' as const },
  },
  createdBy: { select: { firstName: true, middleName: true, lastName: true } },
  readyBy: { select: { firstName: true, middleName: true, lastName: true } },
} satisfies Prisma.CitizenRequestSelect;

type RequestRow = Prisma.CitizenRequestGetPayload<{ select: typeof REQUEST_SELECT }>;

/**
 * المعاملات والإفادات — a citizen asks the municipality for a paper, pays its fee,
 * and collects the stamped paper at the counter. Design:
 * docs/municipal-requests-plan.md; decisions: docs/open-decisions.md §20; the
 * tables and their CHECKs: tenant migration 0092.
 *
 * ## Two ways in, one request
 *
 * A citizen submits through the portal, or a clerk files at the counter for a
 * citizen who is present (D8). Both go through `submit`: the same checks, the
 * same retry key, the same «REQ-» book. Only the actor and `channel` differ.
 *
 * ## The fee
 *
 * The amount is the manager's, from `request_type_settings` (D1). The bill is
 * raised when the citizen goes to pay (`raiseBill`), not when the request is
 * filed (D10): nothing on this branch can cancel a bill, so a request abandoned
 * before payment leaves no open debt behind. A free type has no bill and starts
 * in review.
 *
 * ## Paid is the bill's word
 *
 * A request moves to review when its bill is PAID, whoever took the money — the
 * counter, Whish, a reviewed transfer, a bulk settlement. The payment paths emit
 * `payment.reviewed` and `payment.reversed` after their commit; this service
 * listens and re-reads the bill (`reconcile`), because those events also fire
 * for part payments and refusals. A listener's failure is swallowed by the event
 * emitter, so every read of the queue or of a request reconciles again first:
 * a lost event costs a moment, never a request stuck behind a paid bill.
 *
 * ## The papers
 *
 * Stored in the private documents bucket through `REQUEST_FILE_STORAGE`, typed
 * from their bytes (`sniffAttachment`), never served to the portal, and opened
 * by staff through a five-minute link whose every use is audited (D6).
 */
@Injectable()
export class CitizenRequestsService {
  private readonly logger = new Logger(CitizenRequestsService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
    private readonly parcelDues: ParcelDuesService,
    private readonly events: EventEmitter2,
    @Inject(REQUEST_FILE_STORAGE) private readonly files: RequestFileStorage,
    /** Read for `isLive` only: whether a citizen can pay online at all (open-decisions §21). */
    @Inject(WHISH_GATEWAY) private readonly whish: Pick<WhishGateway, 'isLive'>,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────  Request types (D1)  ─────────────────────────────

  /** Every type, offered or not, with its fee — the manager's list, read by staff. */
  async listTypes(): Promise<RequestTypeSettingView[]> {
    const rows = await this.db.requestTypeSetting.findMany();
    const byType = new Map(rows.map((row) => [row.requestType as RequestType, row]));
    return REQUEST_TYPE.map((type) => {
      const row = byType.get(type);
      return {
        requestType: type,
        enabled: row?.enabled ?? false,
        feeAmount: row ? Number(row.feeAmount) : 0,
        needsProperty: requestNeedsProperty(type),
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  /** The types a citizen or a clerk may file now. */
  async offeredTypes(): Promise<RequestTypeSettingView[]> {
    return (await this.listTypes()).filter((type) => type.enabled);
  }

  async updateType(
    type: RequestType,
    input: UpdateRequestTypeSettingInput,
    actor: { id: string; role: string },
  ): Promise<RequestTypeSettingView[]> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const before = await tx.requestTypeSetting.findUnique({ where: { requestType: type } });
      await tx.requestTypeSetting.upsert({
        where: { requestType: type },
        create: { requestType: type, enabled: input.enabled, feeAmount: input.feeAmount, updatedById: actor.id },
        update: { enabled: input.enabled, feeAmount: input.feeAmount, updatedById: actor.id },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'REQUEST_TYPE_UPDATED',
        entityType: 'RequestTypeSetting',
        entityId: null,
        before: before ? { requestType: type, enabled: before.enabled, feeAmount: Number(before.feeAmount) } : null,
        after: { requestType: type, enabled: input.enabled, feeAmount: input.feeAmount },
      });
    });
    return this.listTypes();
  }

  // ─────────────────────────────  Submitting  ─────────────────────────────

  async submit(
    input: {
      citizenId: string;
      requestType: RequestType;
      applicantCapacity: RequestRow['applicantCapacity'];
      propertyEntryId?: string;
      buildingUnitId?: string;
      purpose?: string;
      clientRequestId: string;
    },
    actor: RequestActor,
  ): Promise<SubmitRequestResult> {
    try {
      return await runInTenantTransaction(this.tenantContext, () => this.submitInTransaction(input, actor));
    } catch (error) {
      if (isUniqueViolationOn(error, 'clientRequestId')) {
        const replay = await this.replay(input, actor);
        if (replay) return replay;
      }
      if ((error as { code?: string }).code === 'P2002') {
        // The partial index on open requests: a race the friendly check below lost. The
        // winner is committed by now; its number is what the refusal's message names.
        const open = await this.db.citizenRequest.findFirst({
          where: {
            citizenId: input.citizenId,
            requestType: input.requestType,
            propertyEntryId: input.propertyEntryId ?? null,
            status: { in: [...OPEN_REQUEST_STATUSES] },
          },
          select: { requestNumber: true },
        });
        throw new ConflictError({
          code: 'REQUEST_ALREADY_OPEN',
          message: 'An open request of this type exists.',
          params: { number: open?.requestNumber ?? '—' },
        });
      }
      throw error;
    }
  }

  private async submitInTransaction(
    input: Parameters<CitizenRequestsService['submit']>[0],
    actor: RequestActor,
  ): Promise<SubmitRequestResult> {
    const tx = this.db as Prisma.TransactionClient;
    const lockKey = `${this.tenantContext.schemaName}:citizen-request:${input.clientRequestId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const replay = await this.replay(input, actor);
    if (replay) return replay;

    const citizen = await tx.user.findFirst({
      where: { id: input.citizenId, kind: 'CITIZEN', deletedAt: null },
      select: { id: true },
    });
    if (!citizen) {
      throw new NotFoundError({ code: 'CITIZEN_NOT_FOUND', message: `Citizen ${input.citizenId} was not found` });
    }
    await assertNotMergedAway(tx, citizen.id);

    const setting = await tx.requestTypeSetting.findUnique({ where: { requestType: input.requestType } });
    if (!setting?.enabled) {
      throw new ValidationError({
        code: 'REQUEST_TYPE_NOT_OFFERED',
        message: 'This request type is not offered.',
        params: { type: input.requestType },
      });
    }
    if (requestNeedsProperty(input.requestType) && !input.propertyEntryId) {
      throw new ValidationError({ code: 'REQUEST_PROPERTY_REQUIRED', message: 'This request names a property.' });
    }
    await this.assertOwnCard(tx, citizen.id, input.propertyEntryId, input.buildingUnitId);

    const open = await tx.citizenRequest.findFirst({
      where: {
        citizenId: citizen.id,
        requestType: input.requestType,
        propertyEntryId: input.propertyEntryId ?? null,
        status: { in: ['AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP'] },
      },
      select: { requestNumber: true },
    });
    if (open) {
      throw new ConflictError({
        code: 'REQUEST_ALREADY_OPEN',
        message: 'An open request of this type exists for this property.',
        params: { number: open.requestNumber },
      });
    }

    const fee = Number(setting.feeAmount);
    const status: RequestStatus = fee > 0 ? 'AWAITING_PAYMENT' : 'IN_REVIEW';
    const requestNumber = await allocateDocumentNumber(tx, this.S, 'REQUEST');
    const channel = actor.kind === 'CITIZEN' ? 'ONLINE' : 'COUNTER';
    const created = await tx.citizenRequest.create({
      data: {
        requestNumber,
        citizenId: citizen.id,
        channel,
        requestType: input.requestType,
        applicantCapacity: input.applicantCapacity,
        status,
        propertyEntryId: input.propertyEntryId ?? null,
        buildingUnitId: input.buildingUnitId ?? null,
        purpose: input.purpose ?? null,
        clientRequestId: input.clientRequestId,
        createdById: actor.kind === 'STAFF' ? actor.id : null,
      },
      select: { id: true },
    });
    await this.audit.recordInTransaction({
      ...this.actorEntry(actor),
      action: 'REQUEST_SUBMITTED',
      entityType: 'CitizenRequest',
      entityId: created.id,
      // Ids, numbers and enums only: `purpose` is free text and may name a person.
      after: {
        requestNumber,
        requestType: input.requestType,
        channel,
        citizenId: citizen.id,
        propertyEntryId: input.propertyEntryId ?? null,
        fee,
        status,
      },
    });
    return { id: created.id, requestNumber, status, fee, replayed: false };
  }

  /**
   * A key already used: the same request answers again, flagged; a different
   * request under it is refused, never silently mapped onto the first.
   */
  private async replay(
    input: Parameters<CitizenRequestsService['submit']>[0],
    actor: RequestActor,
  ): Promise<SubmitRequestResult | null> {
    const row = await this.db.citizenRequest.findUnique({
      where: { clientRequestId: input.clientRequestId },
      select: {
        id: true,
        requestNumber: true,
        status: true,
        citizenId: true,
        requestType: true,
        applicantCapacity: true,
        propertyEntryId: true,
        buildingUnitId: true,
        purpose: true,
        channel: true,
        citizenPayment: { select: { amount: true } },
      },
    });
    if (!row) return null;
    // Every field the paper reads: an edit made after a lost answer (another unit, another
    // capacity) is another request, refused under this key, never answered as the first.
    const same =
      row.citizenId === input.citizenId &&
      row.requestType === input.requestType &&
      row.applicantCapacity === input.applicantCapacity &&
      (row.propertyEntryId ?? null) === (input.propertyEntryId ?? null) &&
      (row.buildingUnitId ?? null) === (input.buildingUnitId ?? null) &&
      (row.purpose ?? null) === (input.purpose ?? null) &&
      row.channel === (actor.kind === 'CITIZEN' ? 'ONLINE' : 'COUNTER');
    if (!same) {
      throw new ConflictError({
        code: 'REQUEST_KEY_REUSED',
        message: 'This request key was already used for another request.',
        params: { number: row.requestNumber },
      });
    }
    const fee = row.citizenPayment ? Number(row.citizenPayment.amount) : await this.currentFee(row.requestType as RequestType);
    return { id: row.id, requestNumber: row.requestNumber, status: row.status as RequestStatus, fee, replayed: true };
  }

  /** The card is the citizen's and current, and the unit line is on it and current. */
  private async assertOwnCard(
    tx: Prisma.TransactionClient,
    citizenId: string,
    propertyEntryId: string | undefined,
    buildingUnitId: string | undefined,
  ): Promise<void> {
    if (!propertyEntryId) return;
    const card = await tx.propertyEntry.findFirst({
      where: { id: propertyEntryId, endedAt: null, registration: { citizenId } },
      select: { id: true },
    });
    const unit = buildingUnitId
      ? await tx.buildingUnit.findFirst({
          where: { id: buildingUnitId, propertyEntryId, endedAt: null },
          select: { id: true },
        })
      : { id: '' };
    if (!card || !unit) {
      throw new ValidationError({
        code: 'REQUEST_PROPERTY_NOT_YOURS',
        message: 'The property is not one of this citizen\'s current cards.',
      });
    }
  }

  private async currentFee(type: RequestType): Promise<number> {
    const setting = await this.db.requestTypeSetting.findUnique({ where: { requestType: type } });
    return setting ? Number(setting.feeAmount) : 0;
  }

  // ─────────────────────────────  Reading  ─────────────────────────────

  async queue(query: ListRequestsQuery): Promise<CitizenRequestListResult> {
    await this.reconcile();
    const where: Prisma.CitizenRequestWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.channel ? { channel: query.channel } : {}),
      ...(query.type ? { requestType: query.type } : {}),
      ...(query.search
        ? {
            OR: [
              { requestNumber: { contains: query.search, mode: 'insensitive' } },
              { citizen: { referenceNumber: { contains: query.search, mode: 'insensitive' } } },
              { citizen: { firstName: { contains: query.search, mode: 'insensitive' } } },
              { citizen: { lastName: { contains: query.search, mode: 'insensitive' } } },
              { propertyEntry: { propertyNumber: { contains: query.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total, fees] = await Promise.all([
      this.db.citizenRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          requestNumber: true,
          status: true,
          channel: true,
          requestType: true,
          citizenId: true,
          createdAt: true,
          citizen: { select: { firstName: true, middleName: true, lastName: true, residence: true } },
          propertyEntry: { select: { propertyNumber: true } },
          citizenPayment: { select: { amount: true, paymentStatus: true, dueDate: true } },
          _count: { select: { attachments: true } },
        },
      }),
      this.db.citizenRequest.count({ where }),
      this.feesByType(),
    ]);
    return {
      total,
      items: rows.map((row) => ({
        id: row.id,
        requestNumber: row.requestNumber,
        status: row.status as RequestStatus,
        channel: row.channel,
        requestType: row.requestType as RequestType,
        citizenId: row.citizenId,
        citizenName: citizenDisplayName(row.citizen),
        propertyNumber: row.propertyEntry?.propertyNumber ?? null,
        fee: row.citizenPayment ? Number(row.citizenPayment.amount) : (fees.get(row.requestType as RequestType) ?? 0),
        billStatus: row.citizenPayment ? billStatus(row.citizenPayment) : null,
        attachmentCount: row._count.attachments,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** One request, as staff read it. */
  async get(id: string): Promise<CitizenRequestView> {
    await this.reconcile({ requestIds: [id] });
    const row = await this.db.citizenRequest.findUnique({ where: { id }, select: REQUEST_SELECT });
    if (!row) throw new NotFoundError({ code: 'REQUEST_NOT_FOUND', message: `Request ${id} was not found` });
    // Before a bill exists, the fee is the type's current one: what the bill will be when raised.
    const fee = row.citizenPayment ? Number(row.citizenPayment.amount) : await this.currentFee(row.requestType as RequestType);
    return this.staffView(row, fee);
  }

  /** «طلباتي». */
  async mine(citizenId: string): Promise<MyCitizenRequestView[]> {
    await this.reconcile({ citizenId });
    const rows = await this.db.citizenRequest.findMany({
      where: { citizenId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: REQUEST_SELECT,
    });
    const fees = await this.feesByType();
    return rows.map((row) => this.citizenView(row, fees));
  }

  async mineOne(citizenId: string, id: string): Promise<MyCitizenRequestView> {
    await this.reconcile({ requestIds: [id] });
    const row = await this.db.citizenRequest.findFirst({ where: { id, citizenId }, select: REQUEST_SELECT });
    if (!row) throw new NotFoundError({ code: 'REQUEST_NOT_FOUND', message: `Request ${id} was not found` });
    return this.citizenView(row, await this.feesByType());
  }

  private async feesByType(): Promise<Map<RequestType, number>> {
    const rows = await this.db.requestTypeSetting.findMany({ select: { requestType: true, feeAmount: true } });
    return new Map(rows.map((row) => [row.requestType as RequestType, Number(row.feeAmount)]));
  }

  // ─────────────────────────────  The fee's bill  ─────────────────────────────

  /**
   * Raises the request's fee as a bill — «تحصيل الرسم» at the counter, or «ادفع
   * الآن» online once online payment is open — or answers the bill already
   * raised. One bill per request: the row is locked, and `citizenPaymentId` is
   * unique.
   *
   * A citizen raises it only to pay it online, so while online payment is paused
   * (the product owner's decision of 2026-10-13, open-decisions §21) the
   * citizen's route is refused before anything is locked, numbered or written: a
   * bill raised for nothing would only take away their «إلغاء الطلب» (D10). The
   * counter raises it when the person pays there.
   */
  async raiseBill(id: string, actor: RequestActor, scope: Scope = {}): Promise<RaiseRequestBillResult> {
    if (actor.kind === 'CITIZEN' && !this.whish.isLive) {
      throw new ConflictError({
        code: 'ONLINE_PAYMENT_UNAVAILABLE',
        message: 'Online payment is paused; the fee is paid at the municipality.',
      });
    }
    const outcome = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await this.lock(tx, id, scope);
      const existing = await tx.citizenRequest.findUniqueOrThrow({
        where: { id },
        select: {
          requestNumber: true,
          requestType: true,
          channel: true,
          citizenId: true,
          citizenPayment: { select: { id: true, invoiceNumber: true, amount: true, currency: true } },
          _count: { select: { attachments: { where: { type: 'IDENTITY' } } } },
        },
      });
      if (existing.citizenPayment) {
        return {
          raised: false,
          result: {
            citizenPaymentId: existing.citizenPayment.id,
            invoiceNumber: existing.citizenPayment.invoiceNumber,
            amount: Number(existing.citizenPayment.amount),
            currency: existing.citizenPayment.currency,
            existed: true,
          },
        };
      }
      if (locked.status !== 'AWAITING_PAYMENT') {
        throw new ConflictError({
          code: 'REQUEST_STATE_CHANGED',
          message: 'The request is not awaiting its fee.',
          params: { status: locked.status },
        });
      }
      // An online request carries a copy of an identity paper before its fee is paid (D2).
      if (existing.channel === 'ONLINE' && existing._count.attachments === 0) {
        throw new ValidationError({
          code: 'REQUEST_IDENTITY_COPY_REQUIRED',
          message: 'Attach a copy of an identity paper first.',
        });
      }
      const fee = await this.currentFee(existing.requestType as RequestType);
      if (fee <= 0) {
        throw new ConflictError({ code: 'REQUEST_FREE_NO_BILL', message: 'This request type has no fee.' });
      }
      const bill = await raiseOneOffBill(tx, this.S, {
        citizenId: existing.citizenId,
        title: billTitle(existing.requestType as RequestType),
        amount: fee,
        dueDate: dueDate(),
        // Who raised it (0091): the clerk at the counter; online, the citizen's own press, so nobody on the staff.
        issuedById: actor.kind === 'STAFF' ? actor.id : null,
      });
      await tx.citizenRequest.update({ where: { id }, data: { citizenPaymentId: bill.id } });
      await this.audit.recordInTransaction({
        ...this.actorEntry(actor),
        action: 'REQUEST_BILL_RAISED',
        entityType: 'CitizenRequest',
        entityId: id,
        after: {
          requestNumber: existing.requestNumber,
          citizenPaymentId: bill.id,
          invoiceNumber: bill.invoiceNumber,
          amount: fee,
          currency: 'LBP',
        },
      });
      return {
        raised: true,
        result: { citizenPaymentId: bill.id, invoiceNumber: bill.invoiceNumber, amount: fee, currency: 'LBP', existed: false },
      };
    });
    if (outcome.raised) {
      this.events.emit('request.bill.raised', { tenantSlug: this.tenantContext.tenantSlug, requestId: id });
    }
    return outcome.result;
  }

  // ─────────────────────────────  Paid is the bill's word  ─────────────────────────────

  @OnEvent('payment.reviewed')
  async onPaymentReviewed(payload: { paymentId?: string }): Promise<void> {
    if (!payload?.paymentId) return;
    await this.afterBillMoved(payload.paymentId);
  }

  @OnEvent('payment.reversed')
  async onPaymentReversed(payload: { transactionId?: string }): Promise<void> {
    if (!payload?.transactionId) return;
    try {
      const movement = await this.db.paymentTransaction.findUnique({
        where: { id: payload.transactionId },
        select: { paymentId: true },
      });
      if (movement) await this.afterBillMoved(movement.paymentId);
    } catch (error) {
      this.logger.error(`Request reconcile after a reversal failed (transaction ${payload.transactionId}): ${String(error)}`);
    }
  }

  private async afterBillMoved(paymentId: string): Promise<void> {
    const run = async () => {
      try {
        const request = await this.db.citizenRequest.findUnique({
          where: { citizenPaymentId: paymentId },
          select: { id: true },
        });
        if (request) await this.reconcile({ requestIds: [request.id] });
      } catch (error) {
        // Ids only. The next read of the request reconciles again.
        this.logger.error(`Request reconcile failed (bill ${paymentId}): ${String(error)}`);
      }
    };
    const transaction = this.tenantContext.peek()?.transaction;
    if (transaction) {
      transaction.afterCommit.push(run);
      return;
    }
    await run();
  }

  /**
   * Brings requests in line with their bills: AWAITING_PAYMENT → IN_REVIEW once
   * the bill is PAID, and IN_REVIEW → AWAITING_PAYMENT if a reversal took it back.
   * A request already approved, handed over or rejected is left alone: a refund
   * there is the accountant's decision (D5), not a status change. Cheap when
   * nothing has moved: one indexed read, no transaction.
   *
   * And one move with no bill: a request still waiting for its fee, never billed,
   * whose type the manager has since made free. The fee is the one in force when
   * the bill is raised (D1), so there is nothing left to pay, and it goes to review
   * — without this it could be neither billed (`REQUEST_FREE_NO_BILL`) nor approved.
   */
  async reconcile(filter: { requestIds?: string[]; citizenId?: string } = {}): Promise<void> {
    const S = this.S;
    const byIds = filter.requestIds?.length ? Prisma.sql`AND r."id" = ANY(${filter.requestIds}::uuid[])` : Prisma.empty;
    const byCitizen = filter.citizenId ? Prisma.sql`AND r."citizenId" = ${filter.citizenId}::uuid` : Prisma.empty;
    // `FOR UPDATE OF r` locks the request alone, the preserved side of both outer joins.
    const moved = (lock: boolean) => Prisma.sql`
      SELECT r."id", r."requestNumber", r."status"::text AS "status", b."paymentStatus"::text AS "paymentStatus"
      FROM ${S}citizen_requests r
      LEFT JOIN ${S}citizen_payments b ON b."id" = r."citizenPaymentId"
      LEFT JOIN ${S}request_type_settings t ON t."requestType" = r."requestType"
      WHERE ((r."status" = 'AWAITING_PAYMENT' AND b."paymentStatus" = 'PAID')
          OR (r."status" = 'IN_REVIEW' AND b."paymentStatus" <> 'PAID')
          OR (r."status" = 'AWAITING_PAYMENT' AND r."citizenPaymentId" IS NULL AND t."feeAmount" = 0))
      ${byIds} ${byCitizen}
      ${lock ? Prisma.sql`FOR UPDATE OF r` : Prisma.empty}`;
    const candidates = await this.db.$queryRaw<Array<{ id: string }>>(moved(false));
    if (candidates.length === 0) return;

    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const rows = await tx.$queryRaw<
        Array<{ id: string; requestNumber: string; status: string; paymentStatus: string | null }>
      >(moved(true));
      for (const row of rows) {
        if (row.paymentStatus === null) {
          // No bill, and the type is free now: nothing to pay, so no `paidAt` either.
          await tx.citizenRequest.update({ where: { id: row.id }, data: { status: 'IN_REVIEW' } });
          await this.audit.recordInTransaction({
            actorId: null,
            actorType: 'SYSTEM',
            action: 'REQUEST_FEE_WAIVED',
            entityType: 'CitizenRequest',
            entityId: row.id,
            before: { status: row.status },
            after: { requestNumber: row.requestNumber, status: 'IN_REVIEW', fee: 0 },
          });
          continue;
        }
        const paid = row.paymentStatus === 'PAID';
        await tx.citizenRequest.update({
          where: { id: row.id },
          data: paid ? { status: 'IN_REVIEW', paidAt: new Date() } : { status: 'AWAITING_PAYMENT', paidAt: null },
        });
        await this.audit.recordInTransaction({
          actorId: null,
          actorType: 'SYSTEM',
          action: paid ? 'REQUEST_PAID' : 'REQUEST_PAYMENT_REVERSED',
          entityType: 'CitizenRequest',
          entityId: row.id,
          before: { status: row.status },
          after: { requestNumber: row.requestNumber, status: paid ? 'IN_REVIEW' : 'AWAITING_PAYMENT' },
        });
      }
    });
  }

  // ─────────────────────────────  Staff decisions  ─────────────────────────────

  /**
   * «جاهزة للاستلام»: the clerk writes what the paper certifies (D3). A براءة ذمة
   * is judged here, against what is owed on the property by its bills, and the
   * answer is kept on the request for the paper's «حتى تاريخ».
   */
  async approve(id: string, statement: string, actor: { id: string; role: string }): Promise<CitizenRequestView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await this.lock(tx, id);
      this.expectStatus(locked.status, ['IN_REVIEW']);
      const row = await tx.citizenRequest.findUniqueOrThrow({
        where: { id },
        select: { requestNumber: true, requestType: true, propertyEntry: { select: { propertyNumber: true } } },
      });
      let clearance: RequestClearanceSnapshot | null = null;
      if (row.requestType === 'CLEARANCE') {
        const propertyNumber = row.propertyEntry?.propertyNumber?.trim();
        if (!propertyNumber) {
          throw new ValidationError({
            code: 'REQUEST_CLEARANCE_NO_PROPERTY_NUMBER',
            message: 'The property has no رقم العقار to check dues against.',
          });
        }
        const dues = await this.parcelDues.dues(propertyNumber);
        if (dues.total > 0) {
          throw new ConflictError({
            code: 'REQUEST_CLEARANCE_DUES_OUTSTANDING',
            message: 'The property still owes.',
            params: { total: dues.total },
          });
        }
        clearance = {
          propertyNumber: dues.propertyNumber,
          total: dues.total,
          unlinkedTotal: dues.unlinkedTotal,
          checkedAt: new Date().toISOString(),
        };
      }
      await tx.citizenRequest.update({
        where: { id },
        data: {
          status: 'READY_FOR_PICKUP',
          statement,
          readyAt: new Date(),
          readyById: actor.id,
          clearanceSnapshot: (clearance ?? Prisma.DbNull) as never,
        },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'REQUEST_READY',
        entityType: 'CitizenRequest',
        entityId: id,
        before: { status: locked.status },
        after: {
          requestNumber: row.requestNumber,
          status: 'READY_FOR_PICKUP',
          ...(clearance ? { clearanceTotal: clearance.total, clearanceUnlinkedTotal: clearance.unlinkedTotal } : {}),
        },
      });
    });
    return this.get(id);
  }

  /** «رفض الطلب», with the reason the citizen reads. A paid fee stays recorded (D5). */
  async reject(id: string, reason: string, actor: { id: string; role: string }): Promise<CitizenRequestView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await this.lock(tx, id);
      this.expectStatus(locked.status, ['AWAITING_PAYMENT', 'IN_REVIEW']);
      if (locked.status === 'AWAITING_PAYMENT' && locked.citizenPaymentId) {
        throw new ConflictError({
          code: 'REQUEST_BILL_OPEN',
          message: 'The fee has been billed and is not paid; it cannot be cancelled yet.',
        });
      }
      await tx.citizenRequest.update({
        where: { id },
        data: { status: 'REJECTED', rejectionReason: reason, rejectedAt: new Date(), rejectedById: actor.id },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'REQUEST_REJECTED',
        entityType: 'CitizenRequest',
        entityId: id,
        // The reason is free text and may name a person: it stays on the request, not in the audit row.
        before: { status: locked.status },
        after: { requestNumber: locked.requestNumber, status: 'REJECTED', paid: Boolean(locked.citizenPaymentId) },
      });
    });
    return this.get(id);
  }

  /** «تسليم المعاملة», against the original identity card at the counter. */
  async complete(id: string, actor: { id: string; role: string }): Promise<CitizenRequestView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await this.lock(tx, id);
      this.expectStatus(locked.status, ['READY_FOR_PICKUP']);
      await tx.citizenRequest.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id },
      });
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'REQUEST_COMPLETED',
        entityType: 'CitizenRequest',
        entityId: id,
        before: { status: locked.status },
        after: { requestNumber: locked.requestNumber, status: 'COMPLETED' },
      });
    });
    return this.get(id);
  }

  /** Cancelled by the citizen or a clerk, while no bill has been raised (D10). */
  async cancel(id: string, actor: RequestActor, scope: Scope = {}): Promise<void> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      const locked = await this.lock(tx, id, scope);
      this.expectStatus(locked.status, ['AWAITING_PAYMENT']);
      if (locked.citizenPaymentId) {
        throw new ConflictError({
          code: 'REQUEST_BILL_OPEN',
          message: 'The fee has been billed; the request waits for it to be paid.',
        });
      }
      await tx.citizenRequest.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancelledById: actor.kind === 'STAFF' ? actor.id : null,
        },
      });
      await this.audit.recordInTransaction({
        ...this.actorEntry(actor),
        action: 'REQUEST_CANCELLED',
        entityType: 'CitizenRequest',
        entityId: id,
        before: { status: locked.status },
        after: { requestNumber: locked.requestNumber, status: 'CANCELLED' },
      });
    });
  }

  // ─────────────────────────────  Papers  ─────────────────────────────

  /**
   * Adds a paper. Typed from its bytes, written to the bucket before the row (a
   * transaction is never held open across S3), and the object removed again if
   * the row cannot be recorded. A citizen adds papers while the request is being
   * prepared or read; staff, until it is closed.
   */
  async addAttachment(
    id: string,
    file: { buffer: Buffer; size: number },
    type: RequestAttachmentType,
    actor: RequestActor,
    scope: Scope = {},
  ): Promise<RequestAttachmentView> {
    const open = actor.kind === 'CITIZEN' ? REQUEST_STATUSES_TAKING_ATTACHMENTS : ['AWAITING_PAYMENT', 'IN_REVIEW', 'READY_FOR_PICKUP'];
    const before = await this.db.citizenRequest.findFirst({
      where: { id, ...(scope.citizenId ? { citizenId: scope.citizenId } : {}) },
      select: { status: true, _count: { select: { attachments: true } } },
    });
    if (!before) throw new NotFoundError({ code: 'REQUEST_NOT_FOUND', message: `Request ${id} was not found` });
    this.assertTakesAttachments(before.status as RequestStatus, before._count.attachments, open);

    if (!file.buffer || file.size === 0 || file.buffer.length === 0) {
      throw new ValidationError({ code: 'REQUEST_ATTACHMENT_EMPTY', message: 'The file is empty.' });
    }
    const sniffed = sniffAttachment(file.buffer);
    if (!sniffed) {
      throw new ValidationError({
        code: 'REQUEST_ATTACHMENT_UNSUPPORTED',
        message: 'Only JPEG, PNG, WebP and PDF files are accepted.',
      });
    }

    const { storagePath } = await this.files.put({
      tenantSlug: this.tenantContext.tenantSlug,
      requestId: id,
      extension: sniffed.extension,
      mimeType: sniffed.mimeType,
      content: file.buffer,
    });
    try {
      return await runInTenantTransaction(this.tenantContext, async () => {
        const tx = this.db as Prisma.TransactionClient;
        const locked = await this.lock(tx, id, scope);
        const count = await tx.citizenRequestAttachment.count({ where: { requestId: id } });
        this.assertTakesAttachments(locked.status, count, open);
        const created = await tx.citizenRequestAttachment.create({
          data: { requestId: id, type, storagePath, mimeType: sniffed.mimeType, sizeBytes: file.buffer.length, uploadedById: actor.id },
          select: { id: true, type: true, mimeType: true, sizeBytes: true, createdAt: true },
        });
        await this.audit.recordInTransaction({
          ...this.actorEntry(actor),
          action: 'REQUEST_ATTACHMENT_ADDED',
          entityType: 'CitizenRequest',
          entityId: id,
          after: {
            requestNumber: locked.requestNumber,
            attachmentId: created.id,
            type,
            mimeType: sniffed.mimeType,
            sizeBytes: file.buffer.length,
          },
        });
        return {
          id: created.id,
          type: created.type as RequestAttachmentType,
          mimeType: created.mimeType,
          sizeBytes: created.sizeBytes,
          createdAt: created.createdAt.toISOString(),
          uploadedByKind: actor.kind,
        };
      });
    } catch (error) {
      await this.files.remove(storagePath);
      throw error;
    }
  }

  /** A five-minute link to one paper, for staff; every use is an audit row (D6). */
  async attachmentUrl(id: string, attachmentId: string, actor: { id: string; role: string }): Promise<RequestAttachmentUrl> {
    const attachment = await this.db.citizenRequestAttachment.findFirst({
      where: { id: attachmentId, requestId: id },
      select: { id: true, type: true, storagePath: true, request: { select: { requestNumber: true } } },
    });
    if (!attachment) {
      throw new NotFoundError({ code: 'REQUEST_ATTACHMENT_NOT_FOUND', message: `Attachment ${attachmentId} was not found` });
    }
    const url = await this.files.createSignedUrl(attachment.storagePath, ATTACHMENT_URL_TTL_SECONDS);
    await runInTenantTransaction(this.tenantContext, () =>
      this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'REQUEST_ATTACHMENT_VIEWED',
        entityType: 'CitizenRequest',
        entityId: id,
        after: { requestNumber: attachment.request.requestNumber, attachmentId: attachment.id, type: attachment.type },
      }),
    );
    return { url, expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS };
  }

  private assertTakesAttachments(status: RequestStatus, count: number, open: readonly string[]): void {
    if (!open.includes(status)) {
      throw new ConflictError({
        code: 'REQUEST_ATTACHMENTS_CLOSED',
        message: 'This request no longer takes papers.',
        params: { status },
      });
    }
    if (count >= REQUEST_ATTACHMENTS_MAX) {
      throw new ValidationError({
        code: 'REQUEST_ATTACHMENT_LIMIT',
        message: 'This request carries as many papers as it may.',
        params: { max: REQUEST_ATTACHMENTS_MAX },
      });
    }
  }

  // ─────────────────────────────  Helpers  ─────────────────────────────

  /** Locks the request row for the rest of the transaction; a citizen scope reads only their own. */
  private async lock(
    tx: Prisma.TransactionClient,
    id: string,
    scope: Scope = {},
  ): Promise<{ id: string; requestNumber: string; status: RequestStatus; citizenPaymentId: string | null }> {
    const byCitizen = scope.citizenId ? Prisma.sql`AND "citizenId" = ${scope.citizenId}::uuid` : Prisma.empty;
    const rows = await tx.$queryRaw<
      Array<{ id: string; requestNumber: string; status: string; citizenPaymentId: string | null }>
    >`SELECT "id", "requestNumber", "status"::text AS "status", "citizenPaymentId"
      FROM ${this.S}citizen_requests WHERE "id" = ${id}::uuid ${byCitizen} FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundError({ code: 'REQUEST_NOT_FOUND', message: `Request ${id} was not found` });
    return { ...row, status: row.status as RequestStatus };
  }

  private expectStatus(status: RequestStatus, allowed: readonly RequestStatus[]): void {
    if (!allowed.includes(status)) {
      throw new ConflictError({
        code: 'REQUEST_STATE_CHANGED',
        message: 'The request is no longer where this step starts.',
        params: { status },
      });
    }
  }

  private actorEntry(actor: RequestActor): Pick<AuditEntryInput, 'actorId' | 'actorType' | 'actorRole'> {
    return actor.kind === 'STAFF'
      ? { actorId: actor.id, actorType: 'STAFF', actorRole: actor.role as never }
      : { actorId: actor.id, actorType: 'CITIZEN' };
  }

  private staffView(row: RequestRow, fee: number): CitizenRequestView {
    return {
      id: row.id,
      requestNumber: row.requestNumber,
      status: row.status as RequestStatus,
      channel: row.channel,
      requestType: row.requestType as RequestType,
      applicantCapacity: row.applicantCapacity,
      citizen: {
        id: row.citizen.id,
        name: citizenDisplayName(row.citizen),
        referenceNumber: row.citizen.referenceNumber,
        identityDocNumber: row.citizen.identityDocNumber,
      },
      property: propertyView(row),
      fee,
      bill: billView(row),
      purpose: row.purpose,
      statement: row.statement,
      rejectionReason: row.rejectionReason,
      clearance: (row.clearanceSnapshot as RequestClearanceSnapshot | null) ?? null,
      attachments: row.attachments.map(attachmentView),
      createdByName: row.createdBy ? citizenDisplayName(row.createdBy) : null,
      readyByName: row.readyBy ? citizenDisplayName(row.readyBy) : null,
      createdAt: row.createdAt.toISOString(),
      paidAt: row.paidAt?.toISOString() ?? null,
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      rejectedAt: row.rejectedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
    };
  }

  private citizenView(row: RequestRow, fees: Map<RequestType, number>): MyCitizenRequestView {
    const type = row.requestType as RequestType;
    return {
      id: row.id,
      requestNumber: row.requestNumber,
      status: row.status as RequestStatus,
      channel: row.channel,
      requestType: type,
      applicantCapacity: row.applicantCapacity,
      property: propertyView(row),
      fee: row.citizenPayment ? Number(row.citizenPayment.amount) : (fees.get(type) ?? 0),
      bill: billView(row),
      purpose: row.purpose,
      rejectionReason: row.rejectionReason,
      attachments: row.attachments.map(attachmentView),
      needsIdentityCopy:
        row.channel === 'ONLINE' &&
        row.status === 'AWAITING_PAYMENT' &&
        !row.attachments.some((attachment) => attachment.type === 'IDENTITY'),
      createdAt: row.createdAt.toISOString(),
      readyAt: row.readyAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      rejectedAt: row.rejectedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
    };
  }
}

// ─────────────────────────────  Pure helpers  ─────────────────────────────

/** The bill's title: the type's Arabic name, the same on every request of that type. */
function billTitle(type: RequestType): string {
  return `رسم ${getLabels('ar').requestType[type]}`;
}

/** Due a fixed span after the municipal day it is raised on. */
function dueDate(): Date {
  const due = new Date(`${municipalToday()}T00:00:00.000Z`);
  due.setUTCDate(due.getUTCDate() + BILL_DUE_DAYS);
  return due;
}

function billStatus(bill: { paymentStatus: string; dueDate: Date }): RequestBillView['paymentStatus'] {
  // OVERDUE is never stored; it is UNPAID past its due date, read the same way everywhere.
  if (bill.paymentStatus === 'UNPAID' && bill.dueDate.getTime() < Date.now()) return 'OVERDUE';
  return bill.paymentStatus as RequestBillView['paymentStatus'];
}

function billView(row: RequestRow): RequestBillView | null {
  const bill = row.citizenPayment;
  if (!bill) return null;
  return {
    citizenPaymentId: bill.id,
    invoiceNumber: bill.invoiceNumber,
    amount: Number(bill.amount),
    paidAmount: Number(bill.paidAmount),
    currency: bill.currency,
    paymentStatus: billStatus(bill),
    dueDate: bill.dueDate.toISOString(),
  };
}

function propertyView(row: RequestRow): RequestPropertyView | null {
  const card = row.propertyEntry;
  if (!card) return null;
  return {
    propertyEntryId: card.id,
    propertyNumber: card.propertyNumber,
    propertyType: card.propertyType,
    neighborhood: card.neighborhood,
    buildingName: card.buildingName,
    unit: row.buildingUnit
      ? { buildingUnitId: row.buildingUnit.id, unitCode: row.buildingUnit.unit?.unitCode ?? null, floor: row.buildingUnit.floor }
      : null,
  };
}

function attachmentView(attachment: RequestRow['attachments'][number]): RequestAttachmentView {
  return {
    id: attachment.id,
    type: attachment.type as RequestAttachmentType,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    createdAt: attachment.createdAt.toISOString(),
    uploadedByKind: attachment.uploadedBy.kind === 'CITIZEN' ? 'CITIZEN' : 'STAFF',
  };
}
