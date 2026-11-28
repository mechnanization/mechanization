import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ARREARS_APPROVE_ROLES,
  citizenDisplayName,
  municipalToday,
  sameMoney,
  type ArrearsApprovalProblem,
  type ArrearsBatchPage,
  type ArrearsBatchReview,
  type ArrearsBatchTotalRow,
  type ArrearsBatchView,
  type ArrearsComponent,
  type ArrearsFeeType,
  type ArrearsLineFlags,
  type ArrearsLineVerdict,
  type ArrearsSettingsView,
  type ArrearsSingleLineInput,
  type ArrearsUnmatchedLine,
  type ArrearsUnmatchedPage,
  type DiscardArrearsBatchInput,
  type ArrearsCutoffInput,
  type LinkArrearsLineInput,
  type ReturnArrearsBatchInput,
  type SubmitArrearsBatchInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { ConflictError, ForbiddenError, NotFoundError } from '../../../domain/errors/domain-error';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { isUniqueViolation } from '../../../infrastructure/prisma/prisma-errors';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { APP_CONFIG } from '../../common/app.config';
import { AuditService } from '../audit/audit.service';
import { assertNotMergedAway } from '../citizens/merged-away';
import { raiseArrearsBills, type ArrearsBillLine } from '../fees/arrears-bill';
import { approvalProblems, type StoredArrearsLine } from './arrears-approval.plan';
import { arrearsLineKey, isPrescribed } from './arrears-import.plan';
import { ArrearsService } from './arrears.service';
import { StaffActor } from '../../common/actor';

type Db = Prisma.TransactionClient;

const cents = (amount: number) => Math.round(amount * 100);
const pounds = (sum: number) => sum / 100;
const staffName = (user: { firstName: string; lastName: string }) => `${user.firstName} ${user.lastName}`.trim();
const isApprover = (actor: StaffActor) => (ARREARS_APPROVE_ROLES as readonly string[]).includes(actor.role);

const BATCH_VIEW_INCLUDE = {
  preparedBy: { select: { firstName: true, lastName: true } },
  approvedBy: { select: { firstName: true, lastName: true } },
  _count: { select: { lines: true, citizens: true } },
} satisfies Prisma.ArrearsBatchInclude;

type BatchRow = Prisma.ArrearsBatchGetPayload<{ include: typeof BATCH_VIEW_INCLUDE }>;

/** A line row as the plan's pure rules and the bill builder read it. */
type LineRow = Prisma.ArrearsLineGetPayload<Record<string, never>>;

function stored(line: LineRow): StoredArrearsLine {
  return {
    id: line.id,
    citizenId: line.citizenId,
    propertyNumber: line.propertyNumber,
    unitCode: line.unitCode,
    year: line.year,
    feeType: line.feeType as ArrearsFeeType,
    feeTypeNote: line.feeTypeNote,
    component: line.component,
    amount: Number(line.amount),
    dueDate: line.dueDate ? line.dueDate.toISOString().slice(0, 10) : null,
    decision: line.decision,
  };
}

export const ARREARS_BATCH_SUBMITTED = 'ARREARS_BATCH_SUBMITTED';
export const ARREARS_BATCH_RETURNED = 'ARREARS_BATCH_RETURNED';
export const ARREARS_BATCH_DISCARDED = 'ARREARS_BATCH_DISCARDED';
export const ARREARS_BATCH_APPROVED = 'ARREARS_BATCH_APPROVED';
export const ARREARS_BILL_RAISED = 'ARREARS_BILL_RAISED';
export const ARREARS_LINE_ADDED = 'ARREARS_LINE_ADDED';
export const ARREARS_LINE_LINKED = 'ARREARS_LINE_LINKED';
export const ARREARS_CUTOFF_CHANGED = 'ARREARS_CUTOFF_CHANGED';

/**
 * Old debts, «متأخرات سنوات سابقة» — a batch's life after the import (task 5;
 * docs/old-debts-plan.md §4.4–§4.7): submitted with the pages' total, returned,
 * discarded or approved, which raises the bills; a single line found later, which
 * goes through the same draft and the same approval; and a «للمطابقة» line linked
 * to a file. The export and the import's checks are `ArrearsService`.
 *
 * Every act is one `runInTenantTransaction` behind the batch's row lock, with a
 * Tier 1 audit row inside it. Rows name no person: ids, counts and sums.
 */
@Injectable()
export class ArrearsBatchService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly auditTrail: AuditService,
    private readonly arrears: ArrearsService,
    private readonly events: EventEmitter2,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  private viewOf(row: BatchRow): ArrearsBatchView {
    return {
      id: row.id,
      status: row.status,
      scope: (row.scope as ArrearsBatchView['scope']) ?? null,
      preparedBy: { id: row.preparedById, name: staffName(row.preparedBy) },
      submittedAt: row.submittedAt?.toISOString() ?? null,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      approvedBy: row.approvedBy && row.approvedById ? { id: row.approvedById, name: staffName(row.approvedBy) } : null,
      discardedAt: row.discardedAt?.toISOString() ?? null,
      returnNote: row.returnNote,
      controlTotal: row.controlTotal === null ? null : Number(row.controlTotal),
      sourceNote: row.sourceNote,
      citizenCount: row._count.citizens,
      lineCount: row._count.lines,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async viewById(tx: Db, id: string): Promise<ArrearsBatchView> {
    const row = await tx.arrearsBatch.findUnique({ where: { id }, include: BATCH_VIEW_INCLUDE });
    if (!row) throw batchNotFound();
    return this.viewOf(row);
  }

  /** The batch row, locked, with what every act asks of it. */
  private async lockBatch(tx: Db, id: string): Promise<{ status: string; preparedById: string }> {
    const rows = await tx.$queryRaw<Array<{ status: string; preparedById: string }>>`
      SELECT status::text AS status, "preparedById"::text AS "preparedById"
        FROM ${this.S}arrears_batches WHERE id = ${id}::uuid FOR UPDATE`;
    if (!rows[0]) throw batchNotFound();
    return rows[0];
  }

  private async linesLock(tx: Db): Promise<void> {
    // The lock every writer of live lines takes (`ArrearsService.importLines`).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:arrears-lines`}))`;
  }

  // ─────────────────────────────  reads  ─────────────────────────────

  /** A page of the batches, newest first, and how many there are (PAG-06). */
  async list(page: { limit: number; offset: number }): Promise<ArrearsBatchPage> {
    const [rows, total] = await Promise.all([
      this.db.arrearsBatch.findMany({
        // `id` breaks a `createdAt` tie, so a page boundary never repeats or skips a batch.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: page.limit,
        skip: page.offset,
        include: BATCH_VIEW_INCLUDE,
      }),
      this.db.arrearsBatch.count(),
    ]);
    return { items: rows.map((row) => this.viewOf(row)), total };
  }

  /**
   * A batch as the manager reviews it: what it holds by year and fee type, the
   * lines whose handling someone decided — a unit read destroyed or not habitable,
   * an archived file, a person not yet on the register, a drop that is not
   * prescription — the pages' total beside the file's, and what approval raises.
   */
  async review(batchId: string): Promise<ArrearsBatchReview> {
    const batch = await this.viewById(this.db as Db, batchId);
    const rows = await this.db.arrearsLine.findMany({
      where: { batchId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      include: { citizen: { select: { firstName: true, middleName: true, lastName: true, residence: true } } },
    });

    const verdicts: ArrearsLineVerdict[] = rows.map((line, index) => {
      const flags = (line.flags ?? {}) as ArrearsLineFlags;
      return {
        row: index + 1,
        rowKey: line.rowKey,
        name: line.citizen ? citizenDisplayName(line.citizen) : line.sourceName,
        propertyNumber: line.propertyNumber,
        unitCode: line.unitCode,
        year: line.year,
        feeType: line.feeType as ArrearsFeeType,
        component: line.component,
        amount: Number(line.amount),
        status: line.decision === 'DROP' ? 'DROP' : line.citizenId === null ? 'UNMATCHED' : 'KEEP',
        issues: [],
        dropReason: line.dropReason,
        flags,
      };
    });

    const figure = (keep: (verdict: ArrearsLineVerdict) => boolean) => {
      const chosen = verdicts.filter(keep);
      return { count: chosen.length, amount: pounds(chosen.reduce((sum, verdict) => sum + cents(verdict.amount ?? 0), 0)) };
    };
    const kept = figure((verdict) => verdict.status === 'KEEP');
    const dropped = figure((verdict) => verdict.status === 'DROP');
    const unmatched = figure((verdict) => verdict.status === 'UNMATCHED');

    const grouped = new Map<string, { year: number; feeType: ArrearsFeeType; component: ArrearsComponent; count: number; cents: number }>();
    for (const verdict of verdicts) {
      if (verdict.status === 'DROP' || verdict.year === null || !verdict.feeType || !verdict.component) continue;
      const key = `${verdict.year}|${verdict.feeType}|${verdict.component}`;
      const row = grouped.get(key) ?? { year: verdict.year, feeType: verdict.feeType, component: verdict.component, count: 0, cents: 0 };
      row.count += 1;
      row.cents += cents(verdict.amount ?? 0);
      grouped.set(key, row);
    }
    const byYearAndFee: ArrearsBatchTotalRow[] = [...grouped.values()]
      .sort((a, b) => a.year - b.year || a.feeType.localeCompare(b.feeType) || a.component.localeCompare(b.component))
      .map((row) => ({ year: row.year, feeType: row.feeType, component: row.component, count: row.count, amount: pounds(row.cents) }));

    return {
      batch,
      totals: {
        kept,
        dropped,
        prescribed: figure((verdict) => verdict.status === 'DROP' && verdict.flags.prescribed === true),
        unmatched,
        refused: { count: 0 },
        fileTotal: pounds(cents(kept.amount) + cents(dropped.amount) + cents(unmatched.amount)),
        controlTotal: batch.controlTotal,
      },
      byYearAndFee,
      flagged: verdicts.filter(
        (verdict) =>
          verdict.status === 'UNMATCHED' ||
          verdict.flags.war !== undefined ||
          verdict.flags.archived === true ||
          verdict.flags.unitNotHeld === true ||
          (verdict.status === 'DROP' && verdict.flags.prescribed !== true),
      ),
      bills: {
        count: kept.count,
        amount: kept.amount,
        citizens: new Set(rows.filter((line) => line.decision === 'KEEP' && line.citizenId).map((line) => line.citizenId)).size,
      },
    };
  }

  /** A page of the lines of approved batches whose person is not on the register yet, and how many wait (PAG-06). */
  async unmatched(page: { limit: number; offset: number }): Promise<ArrearsUnmatchedPage> {
    const where: Prisma.ArrearsLineWhereInput = { citizenId: null, decision: 'KEEP', discardedAt: null, batch: { status: 'APPROVED' } };
    const [rows, total] = await Promise.all([
      this.db.arrearsLine.findMany({
        where,
        orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: page.limit,
        skip: page.offset,
      }),
      this.db.arrearsLine.count({ where }),
    ]);
    return {
      total,
      items: rows.map((line) => ({
        id: line.id,
        batchId: line.batchId,
        sourceName: line.sourceName ?? '',
        propertyNumber: line.propertyNumber,
        unitCode: line.unitCode,
        year: line.year,
        feeType: line.feeType as ArrearsFeeType,
        component: line.component,
        amount: Number(line.amount),
      })),
    };
  }

  // ─────────────────────────────  submit, return, discard  ─────────────────────────────

  /**
   * «إرسال للاعتماد»: a DRAFT with lines whose sum — kept, dropped and unmatched
   * alike, since the pages hold all of them — is the total the accountant added up
   * by hand. Whoever prepared the batch, or the manager, sends it.
   */
  async submit(batchId: string, input: SubmitArrearsBatchInput, actor: StaffActor): Promise<ArrearsBatchView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const batch = await this.lockBatch(tx, batchId);
      if (batch.status !== 'DRAFT') {
        throw new ConflictError({ code: 'ARREARS_BATCH_NOT_DRAFT', message: 'Only a draft batch is submitted', params: { status: batch.status } });
      }
      this.assertYours(batch.preparedById, actor);

      const lines = await tx.arrearsLine.findMany({ where: { batchId }, select: { amount: true } });
      if (lines.length === 0) {
        throw new ConflictError({ code: 'ARREARS_BATCH_EMPTY', message: 'A batch with no line is not submitted' });
      }
      const linesTotal = pounds(lines.reduce((sum, line) => sum + cents(Number(line.amount)), 0));
      if (!sameMoney(input.controlTotal, linesTotal)) {
        throw new ConflictError({
          code: 'ARREARS_CONTROL_TOTAL_MISMATCH',
          message: 'The pages’ total is not the total of the batch’s lines',
          params: { controlTotal: input.controlTotal, linesTotal },
        });
      }

      await tx.arrearsBatch.update({
        where: { id: batchId },
        data: {
          status: 'SUBMITTED',
          submittedAt: new Date(),
          submittedById: actor.id,
          controlTotal: new Prisma.Decimal(input.controlTotal),
          ...(input.sourceNote ? { sourceNote: input.sourceNote } : {}),
        },
      });
      await this.audit(actor, ARREARS_BATCH_SUBMITTED, batchId, { lines: lines.length, total: linesTotal });
      return this.viewById(tx, batchId);
    });
  }

  /** The manager sends a submitted batch back to the preparer as a draft, with what to fix. */
  async returnBatch(batchId: string, input: ReturnArrearsBatchInput, actor: StaffActor): Promise<ArrearsBatchView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const batch = await this.lockBatch(tx, batchId);
      if (batch.status !== 'SUBMITTED') throw notSubmitted(batch.status);
      await tx.arrearsBatch.update({
        where: { id: batchId },
        // A draft has not been submitted: the stamps go (CHECK `arrears_batches_submitted_status`).
        data: { status: 'DRAFT', returnNote: input.note.trim(), submittedAt: null, submittedById: null },
      });
      await this.audit(actor, ARREARS_BATCH_RETURNED, batchId, {});
      return this.viewById(tx, batchId);
    });
  }

  /**
   * A draft is discarded by whoever prepared it, or the manager; a submitted batch
   * by the manager alone. Its lines leave the one-live-line index, so its citizens
   * can be exported again. The reason is kept on the audit row.
   */
  async discard(batchId: string, input: DiscardArrearsBatchInput, actor: StaffActor): Promise<ArrearsBatchView> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const batch = await this.lockBatch(tx, batchId);
      if (batch.status === 'DRAFT') this.assertYours(batch.preparedById, actor);
      else if (batch.status === 'SUBMITTED') {
        if (!isApprover(actor)) {
          throw new ForbiddenError({ code: 'ARREARS_BATCH_NOT_YOURS', message: 'Only the manager discards a submitted batch' });
        }
      } else {
        throw new ConflictError({ code: 'ARREARS_BATCH_NOT_DRAFT', message: 'This batch can no longer be discarded', params: { status: batch.status } });
      }
      await this.linesLock(tx);
      await tx.arrearsBatch.update({
        where: { id: batchId },
        data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: actor.id },
      });
      await this.audit(actor, ARREARS_BATCH_DISCARDED, batchId, { from: batch.status, reason: input.reason.trim() });
      return this.viewById(tx, batchId);
    });
  }

  private assertYours(preparedById: string, actor: StaffActor): void {
    if (preparedById.toLowerCase() === actor.id.toLowerCase() || isApprover(actor)) return;
    throw new ForbiddenError({ code: 'ARREARS_BATCH_NOT_YOURS', message: 'Only whoever prepared this batch, or the manager, may act on it' });
  }

  // ─────────────────────────────  approve  ─────────────────────────────

  /**
   * Approval raises the bills (§4.5, §7), in one transaction behind the batch's
   * lock: the checks that change with time are asked again (`approvalProblems`),
   * the batch is marked APPROVED and so locked, and one «ARR-» bill is raised for
   * each kept line that has a citizen. A «للمطابقة» line waits for its link. A
   * second approval finds the batch no longer SUBMITTED and is refused, so the
   * bills of a retry are never raised twice; the bill's \`arrearsLineId\` is unique
   * too, whatever the code does.
   *
   * Whoever prepared the batch approving it is held to
   * \`APP_CONFIG.arrears.approverMustDifferFromPreparer\`: open-decisions §23.3 has
   * not decided it, so it is off, and this is the one place that turns it on.
   */
  async approve(batchId: string, actor: StaffActor): Promise<ArrearsBatchView> {
    const { view, raised } = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const batch = await this.lockBatch(tx, batchId);
      if (batch.status !== 'SUBMITTED') throw notSubmitted(batch.status);
      if (APP_CONFIG.arrears.approverMustDifferFromPreparer && batch.preparedById.toLowerCase() === actor.id.toLowerCase()) {
        throw new ConflictError({
          code: 'ARREARS_APPROVER_IS_PREPARER',
          message: 'Whoever prepared a batch does not approve it',
        });
      }
      await this.linesLock(tx);

      const rows = await tx.arrearsLine.findMany({ where: { batchId }, orderBy: [{ year: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] });
      const settings = await tx.systemSettings.findFirst({ select: { arrearsCutoffYear: true } });
      const citizenIds = [...new Set(rows.map((line) => line.citizenId).filter((id): id is string => id !== null))];
      const merged = await tx.citizenMerge.findMany({ where: { absorbedId: { in: citizenIds }, undoneAt: null }, select: { absorbedId: true } });
      const lines = rows.map(stored);
      const problems: ArrearsApprovalProblem[] = approvalProblems(lines, {
        today: municipalToday(),
        cutoffYear: settings?.arrearsCutoffYear ?? null,
        mergedAway: new Set(merged.map((row) => row.absorbedId)),
      });
      if (problems.length > 0) {
        throw new ConflictError({
          code: 'ARREARS_APPROVAL_CHECKS_FAILED',
          message: 'Some lines no longer pass the checks; return the batch to its preparer',
          params: { count: problems.length },
          details: { problems },
        });
      }

      await tx.arrearsBatch.update({ where: { id: batchId }, data: { status: 'APPROVED', approvedAt: new Date(), approvedById: actor.id } });

      const toBill = lines.filter((line): line is StoredArrearsLine & { citizenId: string } => line.decision === 'KEEP' && line.citizenId !== null);
      const bills = await raiseArrearsBills(tx, this.S, toBill as ArrearsBillLine[], actor.id);
      const waiting = lines.filter((line) => line.decision === 'KEEP' && line.citizenId === null);

      await this.auditTrail.recordManyInTransaction(
        bills.map((bill) => ({
          actorId: actor.id,
          actorType: 'STAFF' as const,
          actorRole: actor.role,
          action: ARREARS_BILL_RAISED,
          entityType: 'Payment',
          entityId: bill.id,
          after: { citizenId: bill.citizenId, invoiceNumber: bill.invoiceNumber, amount: bill.amount, arrearsLineId: bill.arrearsLineId, batchId },
        })),
      );
      await this.audit(actor, ARREARS_BATCH_APPROVED, batchId, {
        bills: bills.length,
        total: pounds(bills.reduce((sum, bill) => sum + cents(bill.amount), 0)),
        citizens: new Set(bills.map((bill) => bill.citizenId)).size,
        waitingForMatch: waiting.length,
        dropped: lines.filter((line) => line.decision === 'DROP').length,
      });
      return { view: await this.viewById(tx, batchId), raised: bills.length };
    });
    // The caches that count what is owed, once the bills are committed.
    if (raised > 0) this.events.emit('arrears.bills.raised', { tenantSlug: this.tenantContext.tenantSlug, batchId });
    return view;
  }

  // ─────────────────────────────  a single line  ─────────────────────────────

  /**
   * One debt found after the batches: a batch of one line through the same checks
   * as an import, submitted at once with its own amount as the pages' total (there
   * are no pages), so it still waits for the manager's approval. A retry of the
   * press is answered with the batch the first press made; the same key with
   * another line is refused.
   */
  async addSingleLine(input: ArrearsSingleLineInput, actor: StaffActor): Promise<ArrearsBatchView> {
    const key = input.clientRequestId.toLowerCase();
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${this.tenantContext.schemaName}:arrears-line:${key}`}))`;
      const earlier = await tx.arrearsBatch.findUnique({ where: { clientRequestId: key }, select: { id: true, lines: true } });
      if (earlier) {
        const [line] = earlier.lines;
        const same =
          earlier.lines.length === 1 &&
          line !== undefined &&
          (line.citizenId ?? null) === (input.citizenId?.toLowerCase() ?? null) &&
          line.year === input.year &&
          line.feeType === input.feeType &&
          line.component === input.component &&
          cents(Number(line.amount)) === cents(input.amount);
        if (!same) {
          throw new ConflictError({
            code: 'ARREARS_LINE_REQUEST_REUSED',
            message: 'This request key already recorded another line',
            params: { batchId: earlier.id },
          });
        }
        return this.viewById(tx, earlier.id);
      }

      await this.linesLock(tx);
      const plan = await this.arrears.planSingleLine(tx, input);
      const verdict = plan.verdicts[0];
      if (!verdict || verdict.status === 'REFUSED') {
        throw new ConflictError({
          code: 'ARREARS_LINE_REFUSED',
          message: 'The line does not pass the checks',
          details: { issues: verdict?.issues ?? [] },
        });
      }
      if (verdict.flags.prescribed) {
        throw new ConflictError({ code: 'ARREARS_LINE_PRESCRIBED', message: 'A debt this old is prescribed and is not entered' });
      }
      // A single line is written on a file someone chose: not an archived one (see `link`).
      if (verdict.flags.archived) {
        throw new ConflictError({ code: 'FEE_CITIZEN_ARCHIVED', message: 'An archived file is not chosen for a single debt or a link' });
      }
      const planned = plan.lines[0]!;

      const batch = await tx.arrearsBatch.create({
        data: { preparedById: actor.id, clientRequestId: key, sourceNote: input.note ?? null },
        select: { id: true },
      });
      await this.arrears.insertPlannedLines(tx, batch.id, [planned]);
      await tx.arrearsBatch.update({
        where: { id: batch.id },
        data: { status: 'SUBMITTED', submittedAt: new Date(), submittedById: actor.id, controlTotal: new Prisma.Decimal(input.amount) },
      });
      await this.audit(actor, ARREARS_LINE_ADDED, batch.id, {
        year: input.year,
        feeType: input.feeType,
        component: input.component,
        amount: input.amount,
        onFile: input.citizenId !== undefined,
      });
      return this.viewById(tx, batch.id);
    });
  }

  // ─────────────────────────────  link  ─────────────────────────────

  /**
   * A «للمطابقة» line of an approved batch linked to a citizen file, and its bill
   * raised then: the batch is already approved, so this is the approval of that
   * one line. Never matched by name. The line is stamped (who, when) with the link;
   * a debt that has become prescribed since, a duplicate of the file's live line, or
   * a file folded into another is refused.
   */
  async link(lineId: string, input: LinkArrearsLineInput, actor: StaffActor): Promise<ArrearsUnmatchedLine> {
    const { line, billId } = await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT l.id::text AS id FROM ${this.S}arrears_lines l WHERE l.id = ${lineId}::uuid FOR UPDATE`;
      if (!locked[0]) throw new NotFoundError({ code: 'ARREARS_LINE_NOT_FOUND', message: 'No old-debts line has this id' });
      await this.linesLock(tx);

      const row = await tx.arrearsLine.findUnique({ where: { id: lineId }, include: { batch: { select: { status: true } } } });
      if (!row) throw new NotFoundError({ code: 'ARREARS_LINE_NOT_FOUND', message: 'No old-debts line has this id' });
      if (row.citizenId !== null || row.decision !== 'KEEP' || row.discardedAt !== null || row.batch.status !== 'APPROVED') {
        throw new ConflictError({ code: 'ARREARS_LINE_NOT_WAITING', message: 'This line is not waiting for a file' });
      }
      const citizen = await tx.user.findFirst({ where: { id: input.citizenId, kind: 'CITIZEN' }, select: { id: true, isActive: true } });
      if (!citizen) throw new NotFoundError({ code: 'CITIZEN_NOT_FOUND', message: `Citizen ${input.citizenId} was not found` });
      // An archived file is not chosen here (the owner's decision of 2026-11-21): a debt reaches one only
      // through an approved batch (decision 12), where its citizen was exported, and restoring the file comes first.
      if (!citizen.isActive) {
        throw new ConflictError({ code: 'FEE_CITIZEN_ARCHIVED', message: 'An archived file is not chosen for a single debt or a link' });
      }
      await assertNotMergedAway(tx, citizen.id);

      const cutoff = (await tx.systemSettings.findFirst({ select: { arrearsCutoffYear: true } }))?.arrearsCutoffYear ?? null;
      if (cutoff === null || row.year >= cutoff) {
        throw new ConflictError({
          code: cutoff === null ? 'ARREARS_CUTOFF_NOT_SET' : 'ARREARS_YEAR_NOT_BEFORE_CUTOFF',
          message: 'The line is no longer before the cutoff year',
          params: cutoff === null ? { year: row.year } : { year: row.year, cutoffYear: cutoff },
        });
      }
      if (isPrescribed(row.year, municipalToday())) {
        throw new ConflictError({ code: 'ARREARS_LINE_PRESCRIBED', message: 'A debt this old is prescribed and is no longer billed' });
      }
      const live = await tx.arrearsLine.findMany({
        where: { citizenId: citizen.id, decision: 'KEEP', discardedAt: null, id: { not: lineId } },
        select: { citizenId: true, propertyNumber: true, unitCode: true, year: true, feeType: true, component: true },
      });
      const mine = arrearsLineKey({ ...row, citizenId: citizen.id });
      if (live.some((other) => arrearsLineKey({ ...other, citizenId: citizen.id }) === mine)) {
        throw new ConflictError({ code: 'ARREARS_LINE_DUPLICATE', message: 'This file already holds this debt' });
      }

      try {
        await tx.arrearsLine.update({
          where: { id: lineId },
          data: { citizenId: citizen.id, linkedAt: new Date(), linkedById: actor.id },
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError({ code: 'ARREARS_LINE_DUPLICATE', message: 'This file already holds this debt' });
        }
        throw error;
      }
      const linked = { ...stored({ ...row, citizenId: citizen.id }), citizenId: citizen.id };
      const [bill] = await raiseArrearsBills(tx, this.S, [linked], actor.id);
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role,
        action: ARREARS_LINE_LINKED,
        entityType: 'ArrearsLine',
        entityId: lineId,
        after: { batchId: row.batchId, citizenId: citizen.id, billId: bill!.id, invoiceNumber: bill!.invoiceNumber, amount: bill!.amount },
      });
      return { line: row, billId: bill!.id };
    });
    this.events.emit('arrears.bills.raised', { tenantSlug: this.tenantContext.tenantSlug, batchId: line.batchId, billId });
    return {
      id: line.id,
      batchId: line.batchId,
      sourceName: line.sourceName ?? '',
      propertyNumber: line.propertyNumber,
      unitCode: line.unitCode,
      year: line.year,
      feeType: line.feeType as ArrearsFeeType,
      component: line.component,
      amount: Number(line.amount),
    };
  }

  // ─────────────────────────────  settings  ─────────────────────────────

  /** The cutoff year, and the old books' totals as the table holds them (read only, §23.4). */
  async settings(): Promise<ArrearsSettingsView> {
    const [settings, totals] = await Promise.all([
      this.db.systemSettings.findFirst({ select: { arrearsCutoffYear: true } }),
      this.db.arrearsControlTotal.findMany({ orderBy: { year: 'asc' }, select: { year: true, amount: true } }),
    ]);
    return {
      arrearsCutoffYear: settings?.arrearsCutoffYear ?? null,
      controlTotals: totals.map((row) => ({ year: row.year, amount: Number(row.amount) })),
    };
  }

  /**
   * Sets the year before which a debt is old (decision 5). It is set once and then fixed:
   * once any batch has been approved, a different year is refused (`ARREARS_CUTOFF_LOCKED`),
   * since moving it would let one year be old debt in an approved batch and billed by a notice
   * (task 6). The same year is accepted. Before the first approval it moves freely, and `null`
   * clears it, and every import is refused again. Under the lock every writer of live lines
   * takes, so an approval cannot slip in between the check and the write.
   */
  async setCutoff(input: ArrearsCutoffInput, actor: StaffActor): Promise<ArrearsSettingsView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Db;
      await this.linesLock(tx);
      const before = (await tx.systemSettings.findFirst({ select: { arrearsCutoffYear: true } }))?.arrearsCutoffYear ?? null;
      if (input.arrearsCutoffYear !== before && (await tx.arrearsBatch.count({ where: { status: 'APPROVED' } })) > 0) {
        throw new ConflictError({
          code: 'ARREARS_CUTOFF_LOCKED',
          message: 'A batch has been approved, so the cutoff year is fixed',
          params: before === null ? {} : { cutoffYear: before },
        });
      }
      await tx.systemSettings.upsert({
        where: { singleton: true },
        create: { singleton: true, arrearsCutoffYear: input.arrearsCutoffYear },
        update: { arrearsCutoffYear: input.arrearsCutoffYear },
      });
      await this.auditTrail.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role,
        action: ARREARS_CUTOFF_CHANGED,
        entityType: 'SystemSettings',
        entityId: 'singleton',
        before: { arrearsCutoffYear: before },
        after: { arrearsCutoffYear: input.arrearsCutoffYear },
      });
    });
    return this.settings();
  }

  private async audit(actor: StaffActor, action: string, batchId: string, after: Record<string, unknown>): Promise<void> {
    await this.auditTrail.recordInTransaction({
      actorId: actor.id,
      actorType: 'STAFF',
      actorRole: actor.role,
      action,
      entityType: 'ArrearsBatch',
      entityId: batchId,
      after: { batchId, ...after },
    });
  }
}

function batchNotFound(): NotFoundError {
  return new NotFoundError({ code: 'ARREARS_BATCH_NOT_FOUND', message: 'No old-debts batch has this id' });
}

function notSubmitted(status: string): ConflictError {
  return new ConflictError({
    code: 'ARREARS_BATCH_NOT_SUBMITTED',
    message: 'Only a submitted batch is approved or returned',
    params: { status },
  });
}
