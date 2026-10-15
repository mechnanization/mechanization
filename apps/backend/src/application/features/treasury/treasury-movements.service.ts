import { Injectable } from '@nestjs/common';
import {
  MUNICIPAL_TIME_ZONE,
  type ExpenseVoucherView,
  type IncomeVoucherView,
  type ListTreasuryMovementsQuery,
  type TreasuryMovement,
  type TreasuryMovementDirection,
  type TreasuryMovementTotal,
  type TreasuryMovementsResult,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { likePattern } from '../../common/search-terms';
import { ExpensesService } from './expenses.service';
import { incomePeriod } from './income.plan';
import { IncomeService } from './income.service';

/** The filters, without the page: what every figure of the register is read under. */
type MovementFilters = Omit<ListTreasuryMovementsQuery, 'page' | 'pageSize'>;

/** How one read narrows the two tables beyond the clerk's filters. */
interface Narrowing {
  /**
   * False reads the cancelled vouchers too. The page and the currency sums pass
   * `!includeVoid`: the sums read the cancelled ones for `total` and keep them
   * out of the amounts with `FILTER (WHERE "voidedAt" IS NULL)`, so that FILTER
   * is load-bearing. The day totals pass true.
   */
  excludeVoid: boolean;
  /** Only vouchers within these instants (the page's days, for their totals). */
  within?: { gte: Date; lt: Date };
  /** Each table's newest `top` only: enough for a page at this offset, and no more. */
  top?: number;
}

interface PageRow {
  direction: TreasuryMovementDirection;
  id: string;
  day: string;
}

interface CurrencySumRow {
  currency: string;
  matched: number;
  counted: number;
  amountIn: Prisma.Decimal;
  amountOut: Prisma.Decimal;
}

interface DaySumRow {
  day: string;
  currency: string;
  amountIn: Prisma.Decimal;
  amountOut: Prisma.Decimal;
}

/**
 * «الإيرادات والنفقات» — the income vouchers and the expense vouchers in one
 * register, newest first. Read only. Contract: `treasury-movements.schema.ts`;
 * design: docs/finance.md §4.6.
 *
 * ## One snapshot
 *
 * The page, the count and sums, the day totals and the lines are read in one
 * REPEATABLE READ transaction, as `TreasuryService.statement` reads its page.
 * Read apart, a voucher cancelled between the page and its line was listed as
 * cancelled when cancelled vouchers were not asked for — which neither register
 * can do, since each filters and builds its lines in one `findMany` — and the
 * figures could disagree with the lines beside them.
 *
 * ## Two tables, one order
 *
 * The page is chosen in SQL, over a `UNION ALL` of the two tables under the same
 * filters, ordered by `occurredAt`, then `createdAt`, then `id`, all descending:
 * a back-dated voucher sits at a nominal midday (`documentOccurredAt`), so two
 * on one day can share the instant, and only the id makes the order one that a
 * second request repeats — a voucher on two pages, or on none, otherwise. Each
 * table contributes only its newest `offset + pageSize`, which is all the page
 * can draw on.
 *
 * ## The lines are the registers' own
 *
 * The page's ids are then read through `IncomeService.viewsByIds` and
 * `ExpensesService.viewsByIds`, so each line is exactly the voucher its own
 * register returns: the select and the view live there, once.
 *
 * ## The figures are the books', not the page's
 *
 * `total` counts every voucher the filters match, cancelled ones included when
 * asked for. `totals` and each day's totals are summed over the whole filtered
 * set with cancelled vouchers left out, as both registers do: a day that runs
 * over two pages reads whole on both.
 *
 * ## Days are Beirut's
 *
 * `from` and `to` are read as the income register reads them (`incomePeriod`:
 * Beirut midnights, the upper bound the next day's). A voucher's day is its
 * `occurredAt` on Beirut's calendar, by the same `AT TIME ZONE` the 0082 trigger
 * judges a write by (`occurredAt` is a `timestamptz`, so one conversion is
 * right).
 */
@Injectable()
export class TreasuryMovementsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly income: IncomeService,
    private readonly expenses: ExpensesService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  async list(query: ListTreasuryMovementsQuery): Promise<TreasuryMovementsResult> {
    const { page: pageNumber, pageSize, ...filters } = query;
    const offset = (pageNumber - 1) * pageSize;

    // One snapshot for every read below (see the class comment); one after another, on the one connection.
    const { page, sums, days, incomeViews, expenseViews, daySums } = await this.db.$transaction(
      async (tx) => {
        const page = await tx.$queryRaw<PageRow[]>`
          SELECT m."direction", m."id", m."day"
            FROM (${this.vouchers(filters, { excludeVoid: !filters.includeVoid, top: offset + pageSize })}) m
           ORDER BY m."occurredAt" DESC, m."createdAt" DESC, m."id" DESC
           LIMIT ${pageSize} OFFSET ${offset}
        `;
        /*
          The count and the totals in one statement, so they agree with each other.
          A currency whose matching vouchers are all cancelled is counted in
          `total` but has no line in `totals`: it moved nothing.
        */
        const sums = await tx.$queryRaw<CurrencySumRow[]>`
          SELECT m."currency",
                 count(*)::int AS "matched",
                 (count(*) FILTER (WHERE m."voidedAt" IS NULL))::int AS "counted",
                 COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'IN' AND m."voidedAt" IS NULL), 0) AS "amountIn",
                 COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'OUT' AND m."voidedAt" IS NULL), 0) AS "amountOut"
            FROM (${this.vouchers(filters, { excludeVoid: !filters.includeVoid })}) m
           GROUP BY m."currency"
        `;

        // Newest first, each once. The page is already in that order; sorted anyway, so nothing rests on it.
        const days = [...new Set(page.map((row) => row.day))].sort((a, b) => b.localeCompare(a));
        const ids = (direction: TreasuryMovementDirection) =>
          page.filter((row) => row.direction === direction).map((row) => row.id);

        const incomeViews = await this.income.viewsByIds(tx, ids('IN'));
        const expenseViews = await this.expenses.viewsByIds(tx, ids('OUT'));
        const daySums = await this.dayTotals(tx, filters, days);
        return { page, sums, days, incomeViews, expenseViews, daySums };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return {
      movements: page.flatMap((row): TreasuryMovement[] => movementOf(row, incomeViews, expenseViews)),
      total: sums.reduce((sum, row) => sum + row.matched, 0),
      totals: sortedTotals(
        sums
          .filter((row) => row.counted > 0)
          .map((row) => ({
            currency: row.currency,
            amountIn: row.amountIn.toNumber(),
            amountOut: row.amountOut.toNumber(),
          })),
      ),
      days: days.map((day) => ({
        day,
        totals: sortedTotals(
          daySums
            .filter((row) => row.day === day)
            .map((row) => ({
              currency: row.currency,
              amountIn: row.amountIn.toNumber(),
              amountOut: row.amountOut.toNumber(),
            })),
        ),
      })),
    };
  }

  /**
   * Each of `days`' whole totals under the filters, cancelled vouchers left out,
   * whichever page their vouchers fall on. Bounded by the first day's Beirut
   * midnight and the one after the last, so the `occurredAt` indexes are used.
   */
  private async dayTotals(tx: Prisma.TransactionClient, filters: MovementFilters, days: string[]): Promise<DaySumRow[]> {
    if (days.length === 0) return [];
    const range = incomePeriod(days[days.length - 1], days[0]);
    return tx.$queryRaw<DaySumRow[]>`
      SELECT m."day", m."currency",
             COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'IN'), 0) AS "amountIn",
             COALESCE(SUM(m."amount") FILTER (WHERE m."direction" = 'OUT'), 0) AS "amountOut"
        FROM (${this.vouchers(filters, { excludeVoid: true, within: { gte: range.gte!, lt: range.lt! } })}) m
       WHERE m."day" = ANY(${days}::text[])
       GROUP BY m."day", m."currency"
    `;
  }

  /**
   * Both tables under the same filters, as one row set: direction, id, the
   * order's three keys, currency, amount, the void stamp and the Beirut day.
   * `direction` keeps one table out entirely; every other filter applies to
   * both, each through its own columns where they differ (the search).
   */
  private vouchers(filters: MovementFilters, narrowing: Narrowing): Prisma.Sql {
    const period = incomePeriod(filters.from, filters.to);
    const shared: Prisma.Sql[] = [];
    if (filters.accountId) shared.push(Prisma.sql`v."accountId" = ${filters.accountId}::uuid`);
    /*
      The schema refuses a category without a direction, so this narrows the one
      table being read. Applied as a plain column filter all the same: an income
      category's id is never an expense voucher's, so it can only narrow.
    */
    if (filters.categoryId) shared.push(Prisma.sql`v."categoryId" = ${filters.categoryId}::uuid`);
    if (filters.currency) shared.push(Prisma.sql`v."currency" = ${filters.currency}`);
    if (narrowing.excludeVoid) shared.push(Prisma.sql`v."voidedAt" IS NULL`);
    if (period.gte) shared.push(Prisma.sql`v."occurredAt" >= ${period.gte.toISOString()}::timestamptz`);
    if (period.lt) shared.push(Prisma.sql`v."occurredAt" < ${period.lt.toISOString()}::timestamptz`);
    if (narrowing.within) {
      shared.push(Prisma.sql`v."occurredAt" >= ${narrowing.within.gte.toISOString()}::timestamptz`);
      shared.push(Prisma.sql`v."occurredAt" < ${narrowing.within.lt.toISOString()}::timestamptz`);
    }

    /*
      `%`, `_` and `\` in what the clerk typed are literals (`likePattern`), and
      ILIKE is the case-insensitive contains each register's own search uses.
    */
    const pattern = filters.search ? likePattern(filters.search) : null;
    const where = (searched: Prisma.Sql | null): Prisma.Sql => {
      const conditions = searched ? [...shared, searched] : shared;
      return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
    };
    const top = narrowing.top
      ? Prisma.sql`ORDER BY v."occurredAt" DESC, v."createdAt" DESC, v."id" DESC LIMIT ${narrowing.top}`
      : Prisma.empty;
    const day = Prisma.sql`to_char(v."occurredAt" AT TIME ZONE ${MUNICIPAL_TIME_ZONE}::text, 'YYYY-MM-DD')`;

    const branches: Prisma.Sql[] = [];
    if (filters.direction !== 'OUT') {
      branches.push(Prisma.sql`
        (SELECT 'IN'::text AS "direction", v."id", v."occurredAt", v."createdAt", v."currency", v."amount",
                v."voidedAt", ${day} AS "day"
           FROM ${this.S}income_vouchers v
           ${where(
             pattern
               ? Prisma.sql`(v."voucherNumber" ILIKE ${pattern} OR v."payerName" ILIKE ${pattern}
                             OR v."description" ILIKE ${pattern} OR v."externalReference" ILIKE ${pattern})`
               : null,
           )}
           ${top})`);
    }
    if (filters.direction !== 'IN') {
      branches.push(Prisma.sql`
        (SELECT 'OUT'::text AS "direction", v."id", v."occurredAt", v."createdAt", v."currency", v."amount",
                v."voidedAt", ${day} AS "day"
           FROM ${this.S}expense_vouchers v
           ${where(
             pattern
               ? Prisma.sql`(v."voucherNumber" ILIKE ${pattern} OR v."payee" ILIKE ${pattern}
                             OR v."description" ILIKE ${pattern} OR v."invoiceNumber" ILIKE ${pattern})`
               : null,
           )}
           ${top})`);
    }
    return Prisma.join(branches, ' UNION ALL ');
  }
}

/** A page row and its voucher, or nothing when the voucher cannot be read (never deleted: 0083). */
function movementOf(
  row: PageRow,
  incomeViews: Map<string, IncomeVoucherView>,
  expenseViews: Map<string, ExpenseVoucherView>,
): TreasuryMovement[] {
  if (row.direction === 'IN') {
    const voucher = incomeViews.get(row.id);
    return voucher ? [{ direction: 'IN', day: row.day, voucher }] : [];
  }
  const voucher = expenseViews.get(row.id);
  return voucher ? [{ direction: 'OUT', day: row.day, voucher }] : [];
}

/** By currency, as both registers sort theirs. */
function sortedTotals(totals: TreasuryMovementTotal[]): TreasuryMovementTotal[] {
  return totals.sort((a, b) => a.currency.localeCompare(b.currency));
}
