import { Inject, Injectable } from '@nestjs/common';
import type { FeeAssessment, FeeAssessmentLine, FeeBasis, FeeBearer } from '@mechanization/shared-schemas';
import { AuditLogEntry } from '../../../domain/entities/audit-log-entry.entity';
import { AUDIT_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import type { AuditRepository, AuditRow } from '../../../domain/interfaces/audit-repository.interface';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { withConnectionRetry } from '../../../infrastructure/prisma/with-connection-retry';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { asRecordHistory } from '../audit/audit.service';
import { toAuditViews, type AuditView } from '../audit/audit-view';
import {
  affectsBill,
  figureKey,
  FILE_ACTIONS,
  linesDiff,
  traceChanges,
  UNIT_ACTIONS,
  type BillFigure,
  type ChangeKind,
} from './bill-corrections';
import { assessCitizen, FeesService, flatCategoryCharge, type CitizenHoldings } from './fees.service';

/** Owed and not yet settled. PENDING_REVIEW is money claimed, not money received. */
const OPEN_STATUSES = ['UNPAID', 'OVERDUE', 'PENDING_REVIEW'] as const;

/** How many ids one audit read binds at a time. */
const AUDIT_BATCH_SIZE = 500;

export const BILL_BASIS_REVIEWED = 'BILL_BASIS_REVIEWED';

export interface CorrectionAffectedBill {
  paymentId: string;
  citizenId: string;
  citizenName: string;
  title: string;
  periodKey: string;
  dueDate: string;
  /** UNPAID past its due date reads OVERDUE, as on the ledger. */
  status: string;
  raisedAt: string;
  amount: number;
  paidAmount: number;
  currency: string;
  /** How the bill was worked out when it was raised. Null for a flat charge. */
  billed: FeeAssessment | null;
  /** What it would be if it were raised today. */
  now: BillFigure;
  /** Today's figure minus the bill's. Null when today's cannot be worked out. */
  difference: number | null;
  /** Units the bill charged for that today's figure does not, and the reverse. */
  lines: { removed: FeeAssessmentLine[]; added: FeeAssessmentLine[] } | null;
  /** What was recorded since the bill was raised, oldest first. */
  changes: Array<{ kind: ChangeKind; effectiveOn: string | null; entry: AuditView }>;
  /** The latest review, if any. */
  review: {
    at: string;
    by: string | null;
    note: string;
    /** The review saw today's figure. A later correction reopens the bill. */
    current: boolean;
  } | null;
}

export interface CorrectionAffectedList {
  items: CorrectionAffectedBill[];
  total: number;
  /** Over the whole list, not the page. */
  totals: { billedTooMuch: number; billedTooLittle: number; unassessable: number; reviewed: number };
}

interface OpenBill {
  id: string;
  citizenId: string;
  title: string;
  amount: unknown;
  paidAmount: unknown;
  currency: string;
  dueDate: Date;
  periodKey: string;
  paymentStatus: string;
  createdAt: Date;
  assessment: unknown;
  feeNotice: {
    amount: unknown;
    basis: string;
    bearer: string;
    targetType: string;
    targetCategory: string | null;
  } | null;
}

/**
 * «فواتير تأثّرت بتصحيحات» — open bills whose basis a correction changed.
 *
 * The user's decision of 2026-09-27: a correction never changes a bill. It is
 * flagged for an accountant, who decides. This is the list, and the one thing
 * it writes: that an accountant looked at a bill, at a figure, and what they
 * decided (`BILL_BASIS_REVIEWED`). See `bill-corrections.ts` for which bills
 * are on it.
 *
 * Today's figure is worked out exactly as a billing run would (`holdingsOf`,
 * `assessCitizen`), so a bill that differs here would differ on the next run.
 */
@Injectable()
export class CorrectionBillsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly fees: FeesService,
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  async list(query: { includeReviewed: boolean; limit: number; offset: number }): Promise<CorrectionAffectedList> {
    const now = new Date();
    const bills = await this.openBills();
    const { figures, holdings } = await this.figuresFor(bills);

    const differing = bills.filter((bill) => {
      const figure = figures.get(bill.id);
      return figure !== undefined && !(figure.kind === 'ASSESSED' && figure.amount === Number(bill.amount));
    });
    if (differing.length === 0) {
      return { items: [], total: 0, totals: { billedTooMuch: 0, billedTooLittle: 0, unassessable: 0, reviewed: 0 } };
    }

    // A flat charge's figure needed no holdings; tracing its changes does.
    const unread = [...new Set(differing.map((bill) => bill.citizenId))].filter((id) => !holdings.has(id));
    for (const [id, holding] of await this.holdings(unread)) holdings.set(id, holding);
    const rows = await this.changesSince(differing, holdings);

    const affected = differing.flatMap((bill) => {
      const holding = holdings.get(bill.citizenId);
      const since = (rows.get(bill.citizenId) ?? []).filter((row) => row.createdAt > bill.createdAt);
      const changes = traceChanges(since, {
        citizenId: bill.citizenId,
        unitCodes: new Set(holding?.unitCodes ?? []),
      });
      return affectsBill(changes, bill.createdAt) ? [{ bill, changes }] : [];
    });

    const reviews = await this.latestReviews(affected.map(({ bill }) => bill.id));
    const listed = affected
      .map(({ bill, changes }) => {
        const figure = figures.get(bill.id)!;
        const review = reviews.get(bill.id) ?? null;
        return { bill, changes, figure, review, current: review?.figure === figureKey(figure) };
      })
      .filter((entry) => query.includeReviewed || !entry.current);

    const differenceOf = (bill: OpenBill, figure: BillFigure) =>
      figure.kind === 'ASSESSED' ? figure.amount - Number(bill.amount)
        : figure.kind === 'NOT_TARGETED' ? -Number(bill.amount)
          : null;
    const totals = { billedTooMuch: 0, billedTooLittle: 0, unassessable: 0, reviewed: 0 };
    for (const { bill, figure, current } of listed) {
      const difference = differenceOf(bill, figure);
      if (difference === null) totals.unassessable += 1;
      else if (difference < 0) totals.billedTooMuch += -difference;
      else totals.billedTooLittle += difference;
      if (current) totals.reviewed += 1;
    }

    // Oldest debt first, as the verification queue reads.
    listed.sort((a, b) => a.bill.dueDate.getTime() - b.bill.dueDate.getTime() || a.bill.id.localeCompare(b.bill.id));
    const page = listed.slice(query.offset, query.offset + query.limit);

    const views = new Map(
      (await toAuditViews(this.db, [...new Map(page.flatMap(({ changes }) => changes.map((c) => [c.row.id, c.row]))).values()]))
        .map((view) => [view.id, asRecordHistory(view)]),
    );
    const reviewers = await this.names(page.flatMap(({ review }) => (review?.actorId ? [review.actorId] : [])));

    return {
      total: listed.length,
      totals,
      items: page.map(({ bill, changes, figure, review, current }) => {
        const billed = (bill.assessment as FeeAssessment | null) ?? null;
        return {
          paymentId: bill.id,
          citizenId: bill.citizenId,
          citizenName: holdings.get(bill.citizenId)?.name ?? '',
          title: bill.title,
          periodKey: bill.periodKey,
          dueDate: bill.dueDate.toISOString(),
          status: bill.paymentStatus === 'UNPAID' && bill.dueDate < now ? 'OVERDUE' : bill.paymentStatus,
          raisedAt: bill.createdAt.toISOString(),
          amount: Number(bill.amount),
          paidAmount: Number(bill.paidAmount),
          currency: bill.currency,
          billed,
          now: figure,
          difference: differenceOf(bill, figure),
          lines:
            billed && figure.kind === 'ASSESSED' && figure.assessment
              ? linesDiff(billed.lines ?? [], figure.assessment.lines)
              : null,
          changes: changes.map((change) => ({
            kind: change.kind,
            effectiveOn: change.effectiveOn ? change.effectiveOn.toISOString() : null,
            entry: views.get(change.row.id)!,
          })),
          review: review
            ? {
                at: review.at.toISOString(),
                by: review.actorId ? (reviewers.get(review.actorId) ?? null) : null,
                note: review.note,
                current,
              }
            : null,
        };
      }),
    };
  }

  /**
   * An accountant has looked at this bill, at today's figure, and decided.
   *
   * `figure` is what their screen showed. If a correction has moved it since,
   * the review is refused: they would be signing off a number they never saw.
   * Written straight to the trail rather than through the event listener, so a
   * failed write fails the request instead of vanishing into a log line.
   */
  async review(
    paymentId: string,
    input: { note: string; figure: string },
    actor: { id: string; role: string },
  ): Promise<{ reviewedAt: string }> {
    const bill = (await this.openBills(paymentId))[0];
    if (!bill) {
      const exists = await this.db.citizenPayment.count({ where: { id: paymentId } });
      if (!exists) throw new NotFoundError({
        code: 'INVOICE_NOT_FOUND',
        message: `Invoice ${paymentId} was not found`,
      });
      throw new ConflictError({
        code: 'INVOICE_NOT_OPEN',
        message: 'This invoice is no longer due: it was paid, or the register no longer charges it.',
        details: { code: 'NOT_OPEN' },
      });
    }
    const figure = (await this.figuresFor([bill])).figures.get(bill.id);
    if (!figure) {
      throw new ConflictError({
        code: 'INVOICE_NOT_CHARGED',
        message: 'The register does not charge this invoice.',
        details: { code: 'NOT_OPEN' },
      });
    }
    if (figureKey(figure) !== input.figure) {
      throw new ConflictError({
        code: 'INVOICE_FIGURE_CHANGED',
        message: 'The charged amount changed since you opened the list. Refresh it and check the new figure.',
        details: {
          code: 'FIGURE_CHANGED',
          figure: figureKey(figure),
        },
      });
    }

    const reviewedAt = new Date();
    await this.audit.append(
      AuditLogEntry.create({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: BILL_BASIS_REVIEWED,
        entityType: 'Payment',
        entityId: bill.id,
        before: { amount: Number(bill.amount), periodKey: bill.periodKey },
        after: {
          citizenId: bill.citizenId,
          figure: figureKey(figure),
          ...(figure.kind === 'ASSESSED' ? { amountNow: figure.amount } : {}),
          note: input.note,
        },
      }),
    );
    return { reviewedAt: reviewedAt.toISOString() };
  }

  /** Open bills whose amount depends on the register. One, when `id` is given. */
  private async openBills(id?: string): Promise<OpenBill[]> {
    return withConnectionRetry(() =>
      this.db.citizenPayment.findMany({
        where: {
          ...(id ? { id } : {}),
          paymentStatus: { in: [...OPEN_STATUSES] as never },
          /*
            A flat charge to everyone, or to one person, is the same whatever
            the register says. A flat charge to a category is not: whether the
            citizen is on it turns on what they hold.
          */
          feeNotice: { is: { OR: [{ basis: { not: 'FLAT' } }, { targetType: 'BUILDING_CATEGORY' }] } },
        },
        select: {
          id: true,
          citizenId: true,
          title: true,
          amount: true,
          paidAmount: true,
          currency: true,
          dueDate: true,
          periodKey: true,
          paymentStatus: true,
          createdAt: true,
          assessment: true,
          feeNotice: {
            select: { amount: true, basis: true, bearer: true, targetType: true, targetCategory: true },
          },
        },
      }),
    ) as Promise<OpenBill[]>;
  }

  private async holdings(citizenIds: readonly string[]): Promise<Map<string, CitizenHoldings>> {
    const byCitizen = new Map<string, CitizenHoldings>();
    for await (const batch of this.fees.holdingsOf(citizenIds)) {
      for (const holding of batch) byCitizen.set(holding.citizenId, holding);
    }
    return byCitizen;
  }

  /** Each bill's figure if it were raised today, by payment id — and the holdings read for it. */
  private async figuresFor(
    bills: readonly OpenBill[],
  ): Promise<{ figures: Map<string, BillFigure>; holdings: Map<string, CitizenHoldings> }> {
    const rated = bills.filter((bill) => bill.feeNotice && bill.feeNotice.basis !== 'FLAT');
    const flat = bills.filter((bill) => bill.feeNotice && bill.feeNotice.basis === 'FLAT');
    const figures = new Map<string, BillFigure>();

    /*
      A FLAT bill aimed at a category reads the register too since 0077: a
      holder whose every unit of the category became exempt or uninhabitable
      owes nothing for it (`flatCategoryCharge`).
    */
    const flatByCategory = flat.filter((bill) => bill.feeNotice!.targetCategory);
    const holdings = await this.holdings([
      ...new Set([...rated, ...flatByCategory].map((bill) => bill.citizenId)),
    ]);
    for (const bill of rated) {
      const holding = holdings.get(bill.citizenId);
      if (!holding) continue;
      const notice = bill.feeNotice!;
      const outcome = assessCitizen(holding.entries, {
        amount: Number(notice.amount),
        basis: notice.basis as FeeBasis,
        targetCategory: notice.targetCategory ?? undefined,
        bearer: notice.bearer as FeeBearer,
      });
      figures.set(
        bill.id,
        outcome.kind === 'assessed'
          ? { kind: 'ASSESSED', amount: outcome.amount, assessment: outcome.assessment }
          : { kind: 'UNASSESSABLE', reason: outcome.reason },
      );
    }

    const categories = [...new Set(flat.map((bill) => bill.feeNotice!.targetCategory).filter((c): c is string => !!c))];
    const holders = new Map<string, Set<string>>();
    for (const category of categories) holders.set(category, await this.fees.categoryHolders(category));
    for (const bill of flat) {
      const notice = bill.feeNotice!;
      if (!notice.targetCategory) continue;
      if (!holders.get(notice.targetCategory)?.has(bill.citizenId)) {
        figures.set(bill.id, { kind: 'NOT_TARGETED' });
        continue;
      }
      const holding = holdings.get(bill.citizenId);
      const charge = holding
        ? flatCategoryCharge(holding.entries, {
            amount: Math.round(Number(notice.amount)),
            targetCategory: notice.targetCategory,
          })
        : { amount: Math.round(Number(notice.amount)), assessment: null };
      figures.set(bill.id, { kind: 'ASSESSED', amount: charge.amount, assessment: charge.assessment });
    }
    return { figures, holdings };
  }

  /**
   * The trail since the oldest of these bills: each citizen's own file, and the
   * buildings they hold in. `traceChanges` decides which building rows are theirs.
   */
  private async changesSince(
    bills: readonly OpenBill[],
    holdings: Map<string, CitizenHoldings>,
  ): Promise<Map<string, AuditRow[]>> {
    const since = new Date(Math.min(...bills.map((bill) => bill.createdAt.getTime())));
    const citizenIds = [...new Set(bills.map((bill) => bill.citizenId))];
    const buildingIds = [...new Set(citizenIds.flatMap((id) => holdings.get(id)?.buildingIds ?? []))];

    const read = async (entityType: string, ids: readonly string[], actions: readonly string[]) => {
      const rows: AuditRow[] = [];
      for (let offset = 0; offset < ids.length; offset += AUDIT_BATCH_SIZE) {
        rows.push(
          ...((await this.db.auditLogEntry.findMany({
            where: {
              entityType,
              entityId: { in: ids.slice(offset, offset + AUDIT_BATCH_SIZE) },
              action: { in: [...actions] },
              createdAt: { gt: since },
            },
            orderBy: { createdAt: 'asc' },
          })) as AuditRow[]),
        );
      }
      return rows;
    };
    const fileRows = await read('User', citizenIds, FILE_ACTIONS);
    const buildingRows = await read('Building', buildingIds, UNIT_ACTIONS);

    const byBuilding = new Map<string, AuditRow[]>();
    for (const row of buildingRows) {
      const list = byBuilding.get(row.entityId ?? '') ?? [];
      list.push(row);
      byBuilding.set(row.entityId ?? '', list);
    }
    const byCitizen = new Map<string, AuditRow[]>();
    for (const citizenId of citizenIds) {
      const own = fileRows.filter((row) => row.entityId === citizenId);
      const nearby = (holdings.get(citizenId)?.buildingIds ?? []).flatMap((id) => byBuilding.get(id) ?? []);
      byCitizen.set(
        citizenId,
        [...own, ...nearby].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
      );
    }
    return byCitizen;
  }

  private async latestReviews(
    paymentIds: readonly string[],
  ): Promise<Map<string, { at: Date; actorId: string | null; note: string; figure: string }>> {
    const latest = new Map<string, { at: Date; actorId: string | null; note: string; figure: string }>();
    for (let offset = 0; offset < paymentIds.length; offset += AUDIT_BATCH_SIZE) {
      const rows = await this.db.auditLogEntry.findMany({
        where: {
          entityType: 'Payment',
          action: BILL_BASIS_REVIEWED,
          entityId: { in: paymentIds.slice(offset, offset + AUDIT_BATCH_SIZE) },
        },
        orderBy: { createdAt: 'desc' },
        select: { entityId: true, actorId: true, createdAt: true, after: true },
      });
      for (const row of rows) {
        if (!row.entityId || latest.has(row.entityId)) continue;
        const after = (row.after ?? {}) as Record<string, unknown>;
        latest.set(row.entityId, {
          at: row.createdAt,
          actorId: row.actorId,
          note: typeof after.note === 'string' ? after.note : '',
          figure: typeof after.figure === 'string' ? after.figure : '',
        });
      }
    }
    return latest;
  }

  private async names(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: { id: true, firstName: true, lastName: true },
    });
    return new Map(rows.map((row) => [row.id, [row.firstName, row.lastName].filter(Boolean).join(' ')]));
  }
}
