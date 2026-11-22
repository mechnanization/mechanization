import { Injectable } from '@nestjs/common';
import type {
  ArrearsBatchSheet,
  ArrearsComponent,
  ArrearsFeeType,
  ArrearsReport,
  ArrearsSheetDroppedLine,
} from '@mechanization/shared-schemas';
import { ConflictError } from '../../../domain/errors/domain-error';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ArrearsBatchService } from './arrears-batch.service';
import {
  assembleArrearsReport,
  batchSheetCode,
  type RawCollectionRow,
  type RawReportRow,
  type RawYearRow,
} from './arrears-report.plan';

const staffName = (user: { firstName: string; lastName: string }) => `${user.firstName} ${user.lastName}`.trim();

/**
 * «تقرير المتأخرات» and a batch's sheet (task 11; docs/old-debts-plan.md §8). Reads
 * only: nothing here writes, locks or audits, and nothing names a citizen — the
 * report is sums, the sheet is sums and the lines a batch dropped by رقم العقار.
 *
 * Every figure comes from the rows the approval wrote: a bill is the line's
 * (`citizen_payments.arrearsLineId`), so "billed", "collected", "cancelled",
 * "written off" and "owed" are read off the bill, as every other total in the
 * system reads a bill, and cannot disagree with the counter.
 */
@Injectable()
export class ArrearsReportService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly batches: ArrearsBatchService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  /**
   * By year × fee type, the kept lines of the approved batches: billed, collected
   * since go-live, cancelled, written off and still owed; against the old books'
   * total of each year; the citizens checked over all citizens; and what was
   * collected on old debts, apart from every other bill, by year (Beirut's calendar).
   */
  async report(): Promise<ArrearsReport> {
    const [rows, years, coverage, collections, settings, controlTotals, approved] = await Promise.all([
      this.db.$queryRaw<RawReportRow[]>`
        SELECT l."year"::int AS "year",
               l."feeType" AS "feeType",
               count(p."id")::int AS "billedCount",
               COALESCE(sum(p."amount"), 0)::text AS "billed",
               COALESCE(sum(CASE WHEN p."paymentStatus"::text <> 'CANCELLED' THEN p."paidAmount" ELSE 0 END), 0)::text AS "collected",
               COALESCE(sum(CASE WHEN p."paymentStatus"::text = 'CANCELLED' THEN p."amount" ELSE 0 END), 0)::text AS "cancelled",
               COALESCE(sum(CASE WHEN p."paymentStatus"::text = 'WRITTEN_OFF' THEN COALESCE(p."writeOffAmount", 0) ELSE 0 END), 0)::text AS "writtenOff",
               COALESCE(sum(CASE WHEN p."paymentStatus"::text NOT IN ('CANCELLED', 'WRITTEN_OFF') THEN p."amount" - p."paidAmount" ELSE 0 END), 0)::text AS "owed",
               (count(*) FILTER (WHERE p."id" IS NULL))::int AS "waitingCount",
               COALESCE(sum(CASE WHEN p."id" IS NULL THEN l."amount" ELSE 0 END), 0)::text AS "waiting"
          FROM ${this.S}arrears_lines l
          JOIN ${this.S}arrears_batches b ON b."id" = l."batchId" AND b."status"::text = 'APPROVED'
          LEFT JOIN ${this.S}citizen_payments p ON p."arrearsLineId" = l."id"
         WHERE l."decision"::text = 'KEEP' AND l."discardedAt" IS NULL
         GROUP BY l."year", l."feeType"`,
      this.db.$queryRaw<RawYearRow[]>`
        SELECT l."year"::int AS "year",
               COALESCE(sum(l."amount"), 0)::text AS "imported",
               COALESCE(sum(CASE WHEN l."decision"::text = 'DROP' AND l."flags"->>'prescribed' = 'true' THEN l."amount" ELSE 0 END), 0)::text AS "prescribed",
               COALESCE(sum(CASE WHEN l."decision"::text = 'DROP' AND COALESCE(l."flags"->>'prescribed', '') <> 'true' THEN l."amount" ELSE 0 END), 0)::text AS "dropped"
          FROM ${this.S}arrears_lines l
          JOIN ${this.S}arrears_batches b ON b."id" = l."batchId" AND b."status"::text = 'APPROVED'
         WHERE l."discardedAt" IS NULL
         GROUP BY l."year"`,
      this.db.$queryRaw<Array<{ checked: number; total: number }>>`
        SELECT (SELECT count(DISTINCT bc."citizenId")
                  FROM ${this.S}arrears_batch_citizens bc
                  JOIN ${this.S}arrears_batches b ON b."id" = bc."batchId" AND b."status"::text = 'APPROVED'
                  JOIN ${this.S}users u ON u."id" = bc."citizenId" AND u."kind"::text = 'CITIZEN'
                 WHERE NOT EXISTS (SELECT 1 FROM ${this.S}citizen_merges m WHERE m."absorbedId" = u."id" AND m."undoneAt" IS NULL))::int AS "checked",
               (SELECT count(*)
                  FROM ${this.S}users u
                 WHERE u."kind"::text = 'CITIZEN'
                   AND NOT EXISTS (SELECT 1 FROM ${this.S}citizen_merges m WHERE m."absorbedId" = u."id" AND m."undoneAt" IS NULL))::int AS "total"`,
      // `amount` is signed: a reversal is a negative row, so the sum is net.
      this.db.$queryRaw<RawCollectionRow[]>`
        SELECT EXTRACT(YEAR FROM (t."occurredAt" AT TIME ZONE 'Asia/Beirut'))::int AS "year",
               p."currency" AS "currency",
               COALESCE(sum(CASE WHEN p."arrearsLineId" IS NOT NULL THEN t."amount" ELSE 0 END), 0)::text AS "arrears",
               COALESCE(sum(CASE WHEN p."arrearsLineId" IS NULL THEN t."amount" ELSE 0 END), 0)::text AS "other"
          FROM ${this.S}payment_transactions t
          JOIN ${this.S}citizen_payments p ON p."id" = t."paymentId"
         GROUP BY 1, 2`,
      this.db.systemSettings.findFirst({ select: { arrearsCutoffYear: true } }),
      this.db.arrearsControlTotal.findMany({ orderBy: { year: 'asc' }, select: { year: true, amount: true } }),
      this.db.arrearsBatch.findMany({
        where: { status: 'APPROVED' },
        orderBy: [{ approvedAt: 'desc' }, { id: 'asc' }],
        take: 200,
        select: {
          id: true,
          approvedAt: true,
          preparedBy: { select: { firstName: true, lastName: true } },
          approvedBy: { select: { firstName: true, lastName: true } },
          _count: { select: { lines: true, citizens: true } },
        },
      }),
    ]);

    return assembleArrearsReport({
      cutoffYear: settings?.arrearsCutoffYear ?? null,
      rows,
      years,
      controlTotals: controlTotals.map((total) => ({ year: total.year, amount: Number(total.amount) })),
      coverage: { checked: coverage[0]?.checked ?? 0, total: coverage[0]?.total ?? 0 },
      collections,
      batches: approved.map((batch) => ({
        id: batch.id,
        code: batchSheetCode(batch.id),
        approvedAt: batch.approvedAt?.toISOString() ?? null,
        approvedBy: batch.approvedBy ? staffName(batch.approvedBy) : null,
        preparedBy: staffName(batch.preparedBy),
        lineCount: batch._count.lines,
        citizenCount: batch._count.citizens,
      })),
    });
  }

  /**
   * The page the head of the municipality signs for an approved batch: who
   * prepared and approved it and when, its totals by year and fee, and the lines
   * it dropped with their reasons. A draft, a submitted or a discarded batch has
   * no sheet (`ARREARS_BATCH_NOT_APPROVED`).
   */
  async sheet(batchId: string): Promise<ArrearsBatchSheet> {
    // Throws `ARREARS_BATCH_NOT_FOUND`. Of the review only the batch and its sums are kept: never `flagged`, which names people.
    const review = await this.batches.review(batchId);
    if (review.batch.status !== 'APPROVED') {
      throw new ConflictError({
        code: 'ARREARS_BATCH_NOT_APPROVED',
        message: 'Only an approved batch has a sheet',
        params: { status: review.batch.status },
      });
    }

    const [submittedBy, dropped] = await Promise.all([
      this.db.arrearsBatch.findUnique({
        where: { id: batchId },
        select: { submittedById: true, submittedBy: { select: { firstName: true, lastName: true } } },
      }),
      this.db.arrearsLine.findMany({
        where: { batchId, decision: 'DROP' },
        orderBy: [{ year: 'asc' }, { propertyNumber: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: {
          year: true,
          feeType: true,
          component: true,
          propertyNumber: true,
          unitCode: true,
          amount: true,
          dropReason: true,
          flags: true,
        },
      }),
    ]);

    const droppedLines: ArrearsSheetDroppedLine[] = dropped.map((line) => ({
      year: line.year,
      feeType: line.feeType as ArrearsFeeType,
      component: line.component as ArrearsComponent,
      propertyNumber: line.propertyNumber,
      unitCode: line.unitCode,
      amount: Number(line.amount),
      reason: line.dropReason ?? '',
      prescribed: ((line.flags ?? {}) as { prescribed?: boolean }).prescribed === true,
    }));

    return {
      code: batchSheetCode(batchId),
      batch: review.batch,
      submittedBy:
        submittedBy?.submittedById && submittedBy.submittedBy
          ? { id: submittedBy.submittedById, name: staffName(submittedBy.submittedBy) }
          : null,
      totals: review.totals,
      byYearAndFee: review.byYearAndFee,
      dropped: droppedLines,
    };
  }
}
