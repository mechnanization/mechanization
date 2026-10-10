import { Injectable } from '@nestjs/common';
import type {
  DailyCashReport,
  DailyCashReportCustody,
  DailyCashReportTotal,
  DailyCashReportWallet,
  TreasuryAccountType,
  TreasuryDayEvent,
  TreasuryEntrySource,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { addDays, isCountedWallet, summariseDay } from './day-closing.plan';
import { countView } from './daily-count.service';
import { compareWallets, DayClosureService } from './day-closure.service';
import { municipalDayStart } from './income.plan';
import { dateColumn, TreasuryLedgerService } from './treasury-ledger.service';

const DAY_ACTIONS = new Set<TreasuryDayEvent['action']>([
  'TREASURY_COUNT_RECORDED',
  'TREASURY_DAY_CLOSED',
  'TREASURY_DAY_AUTO_CLOSED',
  'TREASURY_DAY_REOPENED',
]);

/**
 * «تقرير الصندوق اليومي» — one municipal day on one sheet of paper.
 *
 * Per wallet: what it held when the day began, what came in and what went out
 * (gross, by where it came from), what it should have held at the end, what was
 * counted, and the difference with its reason. Beside it, and never inside the
 * count, the cash collectors were still carrying (§3.5, §7.4). Then the day's
 * history — counted, closed, reopened — read from the audit log, which is the
 * only place a reopening's reason survives once the day is closed again.
 *
 * Read-only, and readable on any day since go-live, closed or not: a report on
 * an open day is a draft of the one that will be signed.
 */
@Injectable()
export class DailyCashReportService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledger: TreasuryLedgerService,
    private readonly closures: DayClosureService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  async daily(businessDate: string, viewerId: string): Promise<DailyCashReport> {
    const tx = this.db as Prisma.TransactionClient;
    const start = municipalDayStart(businessDate);
    const end = municipalDayStart(addDays(businessDate, 1));

    // Custody included. A wallet belongs to the day if it existed by its end or held money before
    // it: a collector's custody is created by his first round, which may be entered days late.
    const accounts = await tx.treasuryAccount.findMany({
      where: { OR: [{ createdAt: { lt: end } }, { entries: { some: { occurredAt: { lt: end } } } }] },
      select: {
        id: true,
        name: true,
        type: true,
        currency: true,
        isPrimary: true,
        active: true,
        ownerId: true,
        owner: { select: { firstName: true, lastName: true } },
      },
    });
    const ids = accounts.map((account) => account.id);

    const [openings, entries, countRows, day, timeline, viewer] = await Promise.all([
      this.ledger.balancesBefore(tx, ids, start),
      tx.treasuryEntry.findMany({
        where: { accountId: { in: ids }, occurredAt: { gte: start, lt: end } },
        select: { accountId: true, amount: true, source: true },
      }),
      tx.treasuryCount.findMany({
        where: { businessDate: dateColumn(businessDate) },
        select: {
          accountId: true,
          expectedAmount: true,
          countedAmount: true,
          difference: true,
          varianceReason: true,
          countedAt: true,
          countedBy: { select: { firstName: true, lastName: true } },
        },
      }),
      this.closures.dayState(tx, businessDate),
      this.timeline(tx, businessDate),
      // `kind` in the WHERE, as on every read of `users`.
      tx.user.findFirst({ where: { id: viewerId, kind: 'STAFF' }, select: { firstName: true, lastName: true } }),
    ]);

    const moved = summariseDay(
      entries.map((entry) => ({
        accountId: entry.accountId,
        amount: entry.amount.toNumber(),
        source: entry.source as TreasuryEntrySource,
      })),
    );
    const counts = new Map(countRows.map((row) => [row.accountId, row]));

    const wallets: DailyCashReportWallet[] = [];
    const custody: DailyCashReportCustody[] = [];
    for (const account of accounts) {
      const opening = openings.get(account.id) ?? new Prisma.Decimal(0);
      const day = moved.get(account.id);
      const receipts = day?.receipts ?? 0;
      const payments = day?.payments ?? 0;
      const closing = opening.plus(receipts).minus(payments);

      if (!isCountedWallet(account.type)) {
        if (closing.isZero() && !day) continue;
        custody.push({
          collectorId: account.ownerId,
          collectorName: account.owner ? `${account.owner.firstName} ${account.owner.lastName}` : null,
          currency: account.currency,
          receipts,
          payments,
          heldAtClose: closing.toNumber(),
        });
        continue;
      }

      const count = counts.get(account.id);
      // A wallet closed down long ago, empty and untouched, is not a line on today's report.
      if (!account.active && opening.isZero() && !day && !count) continue;
      wallets.push({
        account: {
          id: account.id,
          name: account.name,
          type: account.type as TreasuryAccountType,
          currency: account.currency,
          isPrimary: account.isPrimary,
          active: account.active,
        },
        openingBalance: opening.toNumber(),
        receipts,
        payments,
        closingBalance: closing.toNumber(),
        movements: day?.movements ?? 0,
        bySource: day?.bySource ?? [],
        count: count ? countView(count, closing) : null,
      });
    }

    const sorted = [...wallets].sort((a, b) => compareWallets(a.account, b.account));

    return {
      day,
      generatedAt: new Date().toISOString(),
      generatedByName: viewer ? `${viewer.firstName} ${viewer.lastName}` : null,
      wallets: sorted,
      totals: totalsOf(sorted),
      custody: custody.sort(
        (a, b) => (a.collectorName ?? '').localeCompare(b.collectorName ?? '') || a.currency.localeCompare(b.currency),
      ),
      custodyTotals: custodyTotalsOf(custody),
      timeline,
    };
  }

  /** What happened to the day, oldest first, from the Tier 1 rows its writers file under it. */
  private async timeline(tx: Prisma.TransactionClient, businessDate: string): Promise<TreasuryDayEvent[]> {
    const rows = await tx.auditLogEntry.findMany({
      where: { entityType: 'TreasuryDay', entityId: businessDate },
      orderBy: { createdAt: 'asc' },
      select: { action: true, createdAt: true, actorId: true, after: true },
    });
    const actorIds = [...new Set(rows.map((row) => row.actorId).filter((id): id is string => id !== null))];
    const actors = actorIds.length
      ? await tx.user.findMany({
          where: { id: { in: actorIds }, kind: 'STAFF' },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const names = new Map(actors.map((actor) => [actor.id, `${actor.firstName} ${actor.lastName}`]));

    return rows
      .filter((row) => DAY_ACTIONS.has(row.action as TreasuryDayEvent['action']))
      .map((row) => {
        const after = (row.after ?? {}) as { reason?: unknown; counts?: unknown };
        return {
          action: row.action as TreasuryDayEvent['action'],
          at: row.createdAt.toISOString(),
          actorName: row.actorId ? (names.get(row.actorId) ?? null) : null,
          reason: row.action === 'TREASURY_DAY_REOPENED' && typeof after.reason === 'string' ? after.reason : null,
          accounts:
            row.action === 'TREASURY_COUNT_RECORDED' && Array.isArray(after.counts) ? after.counts.length : null,
        };
      });
  }
}

/** Each currency's columns added up, in cents. The count totals only once every wallet in it is counted. */
function totalsOf(wallets: DailyCashReportWallet[]): DailyCashReportTotal[] {
  const byCurrency = new Map<string, DailyCashReportWallet[]>();
  for (const wallet of wallets) {
    const list = byCurrency.get(wallet.account.currency) ?? [];
    list.push(wallet);
    byCurrency.set(wallet.account.currency, list);
  }
  const sum = (values: number[]): number => values.reduce((total, value) => total + Math.round(value * 100), 0) / 100;

  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, list]) => {
      const allCounted = list.every((wallet) => wallet.count !== null);
      return {
        currency,
        openingBalance: sum(list.map((wallet) => wallet.openingBalance)),
        receipts: sum(list.map((wallet) => wallet.receipts)),
        payments: sum(list.map((wallet) => wallet.payments)),
        closingBalance: sum(list.map((wallet) => wallet.closingBalance)),
        counted: allCounted ? sum(list.map((wallet) => wallet.count!.countedAmount)) : null,
        difference: allCounted ? sum(list.map((wallet) => wallet.count!.difference)) : null,
      };
    });
}

function custodyTotalsOf(custody: DailyCashReportCustody[]): Array<{ currency: string; heldAtClose: number }> {
  const cents = new Map<string, number>();
  for (const row of custody) {
    cents.set(row.currency, (cents.get(row.currency) ?? 0) + Math.round(row.heldAtClose * 100));
  }
  return [...cents.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, total]) => ({ currency, heldAtClose: total / 100 }));
}
