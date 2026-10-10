import { Injectable } from '@nestjs/common';
import {
  MUNICIPAL_TIME_ZONE,
  municipalToday,
  REOPEN_REASON_MIN,
  type CloseDayInput,
  type CloseDayResult,
  type CountedWalletView,
  type DayClosureVerdict,
  type ReopenDayInput,
  type TreasuryAccountType,
  type TreasuryDayClosureView,
  type TreasuryDayState,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, ValidationError, type DomainError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import {
  addDays,
  closedThrough,
  planClosure,
  planReopen,
  type ClosureRecord,
} from './day-closing.plan';
import { municipalDayStart } from './income.plan';
import { dateColumn, isoDay, TreasuryLedgerService } from './treasury-ledger.service';

/** Where the books stand before any one day is looked at. */
export interface BookState {
  goLiveOn: string | null;
  closures: ClosureRecord[];
  closedThrough: string | null;
  /** Days with an entry on a counted wallet, from the first open day through today. */
  activeDays: string[];
}

/** One recorded count, with the books' figure it was taken against. */
export interface CountRow {
  accountId: string;
  expectedAmount: Prisma.Decimal;
  countedAmount: Prisma.Decimal;
  difference: Prisma.Decimal;
  varianceReason: string | null;
  countedAt: Date;
  countedBy: { firstName: string; lastName: string };
}

/** What the rules need about one day, and what the count sheet draws. */
export interface DayFacts {
  businessDate: string;
  /** The wallets this day's close requires a count of. */
  required: CountedWalletView[];
  /** Required, plus any wallet counted that day that no longer is (deactivated since). */
  wallets: CountedWalletView[];
  /** Each wallet's books at the end of the day, as they stand now. */
  expectedNow: Map<string, Prisma.Decimal>;
  counts: Map<string, CountRow>;
  verdict: DayClosureVerdict;
}

/** The order a sheet lists wallets in: the safe first, as on the treasury page. */
const TYPE_ORDER: Record<string, number> = {
  CASH_SAFE: 0,
  WHISH_ACCOUNT: 1,
  BANK_ACCOUNT: 2,
  PETTY_CASH: 3,
};

const WALLET_SELECT = {
  id: true,
  name: true,
  type: true,
  currency: true,
  isPrimary: true,
  active: true,
} satisfies Prisma.TreasuryAccountSelect;

const CLOSURE_SELECT = {
  businessDate: true,
  status: true,
  autoClosed: true,
  closedAt: true,
  reopenedAt: true,
  reopenReason: true,
  closedBy: { select: { firstName: true, lastName: true } },
  reopenedBy: { select: { firstName: true, lastName: true } },
} satisfies Prisma.TreasuryDayClosureSelect;

type ClosureRow = Prisma.TreasuryDayClosureGetPayload<{ select: typeof CLOSURE_SELECT }>;

const HISTORY_DEFAULT_LIMIT = 60;

/**
 * «إقفال اليومية» — closing a municipal day, and reopening it.
 *
 * The rules are `day-closing.plan.ts`; this reads what they need, under the
 * locks that keep the answer true until the commit, and writes the result.
 *
 * ## Why closing locks the ledger table
 *
 * A close judges the day's counts against the books, then forbids anything new
 * in the day. Between those two moments a back-dated voucher or a collector's
 * round could land in the day — its own check having run before the closure
 * existed — and the day would close on counts that no longer match it. So the
 * close takes `SHARE` on `treasury_entries`: it waits for every transaction
 * already writing an entry to finish, and holds new ones until it commits.
 * After that, the 0082 trigger refuses anything dated in the closed day. Reads
 * are not blocked, and the wait is the length of one close: milliseconds.
 *
 * Counting, closing and reopening also take the day book's advisory lock
 * (`TreasuryLedgerService.lockDayBook`), so a recount cannot change a count
 * while a close is judging it, and two closes cannot both sweep the same days.
 */
@Injectable()
export class DayClosureService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledger: TreasuryLedgerService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────────  reads  ─────────────────────────────────

  /** Go-live, every closure, and the days with movement since the last close. */
  async bookState(tx: Prisma.TransactionClient, today: string): Promise<BookState> {
    const config = await this.ledger.config(tx);
    const goLiveOn = config.goLiveAt ? municipalToday(config.goLiveAt) : null;
    const rows = await tx.treasuryDayClosure.findMany({ select: { businessDate: true, status: true } });
    const closures = rows.map((row) => ({ businessDate: isoDay(row.businessDate), status: row.status }));
    const through = closedThrough(closures);

    let activeDays: string[] = [];
    if (goLiveOn !== null) {
      const from = through === null ? goLiveOn : addDays(through, 1);
      if (from <= today) activeDays = await this.activeDays(tx, from, today);
    }
    return { goLiveOn, closures, closedThrough: through, activeDays };
  }

  /** The wallets, the books and the counts of one day, and whether it may close. */
  async dayFacts(
    tx: Prisma.TransactionClient,
    book: BookState,
    businessDate: string,
    today: string,
  ): Promise<DayFacts> {
    const dayEnd = municipalDayStart(addDays(businessDate, 1));

    const countRows = await tx.treasuryCount.findMany({
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
    });
    const counts = new Map<string, CountRow>(countRows.map((row) => [row.accountId, row]));

    const requiredRows = await this.countedWallets(tx, dayEnd);
    const requiredIds = new Set(requiredRows.map((row) => row.id));
    const extraIds = [...counts.keys()].filter((id) => !requiredIds.has(id));
    const extraRows = extraIds.length
      ? await tx.treasuryAccount.findMany({ where: { id: { in: extraIds } }, select: WALLET_SELECT })
      : [];

    const required = sortWallets(requiredRows.map(walletView));
    const wallets = sortWallets([...requiredRows, ...extraRows].map(walletView));
    const expectedNow = await this.ledger.balancesBefore(
      tx,
      wallets.map((wallet) => wallet.id),
      dayEnd,
    );

    const verdict = planClosure({
      businessDate,
      today,
      goLiveOn: book.goLiveOn,
      closures: book.closures,
      activeDays: book.activeDays,
      requiredAccountIds: required.map((wallet) => wallet.id),
      counts: countRows.map((row) => ({ accountId: row.accountId, expectedAmount: row.expectedAmount.toNumber() })),
      expectedNow: new Map([...expectedNow].map(([id, amount]) => [id, amount.toNumber()])),
    });

    return { businessDate, required, wallets, expectedNow, counts, verdict };
  }

  /**
   * The wallets a day's close counts: every active wallet but a collector's
   * custody (§7.1) that belonged to the day — opened by its end, or holding an
   * entry dated before it. The second half matters because a wallet's
   * `createdAt` is not when it first held money: a bank account opened today
   * can take a voucher back-dated to yesterday, and then yesterday's books
   * include it.
   */
  countedWallets(tx: Prisma.TransactionClient, dayEnd: Date) {
    return tx.treasuryAccount.findMany({
      where: {
        type: { not: 'COLLECTOR_CUSTODY' },
        active: true,
        OR: [{ createdAt: { lt: dayEnd } }, { entries: { some: { occurredAt: { lt: dayEnd } } } }],
      },
      select: WALLET_SELECT,
    });
  }

  /** One day's lock state. A day with no closure row is open. */
  async dayState(tx: Prisma.TransactionClient, businessDate: string): Promise<TreasuryDayState> {
    const row = await tx.treasuryDayClosure.findUnique({
      where: { businessDate: dateColumn(businessDate) },
      select: CLOSURE_SELECT,
    });
    return row ? stateView(row) : openDay(businessDate);
  }

  /** The closed and reopened days, latest first. */
  async history(limit = HISTORY_DEFAULT_LIMIT): Promise<TreasuryDayClosureView[]> {
    const rows = await this.db.treasuryDayClosure.findMany({
      orderBy: { businessDate: 'desc' },
      take: Math.min(Math.max(limit, 1), 366),
      select: CLOSURE_SELECT,
    });
    return rows.map(stateView);
  }

  // ────────────────────────────────  writes  ─────────────────────────────────

  /**
   * «أقفل اليومية» — closes the day, and with it every quiet day since the last
   * close. The closure, the swept days, the counts' links and the Tier 1 audit
   * rows commit together or not at all.
   */
  async close(input: CloseDayInput, actor: { id: string; role: string }): Promise<CloseDayResult> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      await this.ledger.lockDayBook(tx);
      // See the class comment: nothing lands in the day while it is judged.
      await tx.$executeRaw`LOCK TABLE ${this.S}treasury_entries IN SHARE MODE`;

      const today = municipalToday();
      const book = await this.bookState(tx, today);
      const facts = await this.dayFacts(tx, book, input.businessDate, today);
      if (!facts.verdict.ok) throw closureRefusal(facts.verdict, input.businessDate);

      const closedAt = new Date();

      for (const day of facts.verdict.sweeps) {
        await tx.treasuryDayClosure.create({
          data: {
            businessDate: dateColumn(day),
            status: 'CLOSED',
            autoClosed: true,
            closedAt,
            closedById: actor.id,
          },
          select: { id: true },
        });
        await this.audit.recordInTransaction({
          actorId: actor.id,
          actorType: 'STAFF',
          actorRole: actor.role as never,
          action: 'TREASURY_DAY_AUTO_CLOSED',
          entityType: 'TreasuryDay',
          entityId: day,
          after: { businessDate: day, closedWith: input.businessDate },
        });
      }

      /*
        A reopened day keeps its row and turns CLOSED again; the reopening's
        who and why leave the row (the CHECK requires it) and stay in the
        audit log, which is where the day's history is read from.
      */
      const existing = await tx.treasuryDayClosure.findUnique({
        where: { businessDate: dateColumn(input.businessDate) },
        select: { id: true },
      });
      const closure = existing
        ? await tx.treasuryDayClosure.update({
            where: { id: existing.id },
            data: {
              status: 'CLOSED',
              autoClosed: false,
              closedAt,
              closedById: actor.id,
              reopenedAt: null,
              reopenedById: null,
              reopenReason: null,
            },
            select: { id: true },
          })
        : await tx.treasuryDayClosure.create({
            data: {
              businessDate: dateColumn(input.businessDate),
              status: 'CLOSED',
              closedAt,
              closedById: actor.id,
            },
            select: { id: true },
          });

      // The one write the trigger lets through on a closed day's counts.
      await tx.treasuryCount.updateMany({
        where: { businessDate: dateColumn(input.businessDate), closureId: null },
        data: { closureId: closure.id },
      });

      // Tier 1: the figures the day was signed off on, by wallet id — no names.
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TREASURY_DAY_CLOSED',
        entityType: 'TreasuryDay',
        entityId: input.businessDate,
        after: {
          businessDate: input.businessDate,
          reclosed: existing !== null,
          swept: facts.verdict.sweeps,
          counts: facts.required.map((wallet) => {
            const count = facts.counts.get(wallet.id)!;
            return {
              accountId: wallet.id,
              currency: wallet.currency,
              expected: count.expectedAmount.toNumber(),
              counted: count.countedAmount.toNumber(),
              difference: count.difference.toNumber(),
            };
          }),
        },
      });

      return {
        businessDate: input.businessDate,
        closedAt: closedAt.toISOString(),
        sweptDays: facts.verdict.sweeps,
      };
    });
  }

  /**
   * «أعد فتح اليومية» — the manager opens the latest closed day again.
   *
   * Only the latest: reopening an older one would leave a closed day after an
   * open one, and every rule that reads "on or before the latest closed day"
   * would stop meaning anything. The counts stay; they can be recounted, and
   * the day must be closed again before any later day can be.
   */
  async reopen(input: ReopenDayInput, actor: { id: string; role: string }): Promise<TreasuryDayState> {
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      await this.ledger.lockDayBook(tx);

      const rows = await tx.treasuryDayClosure.findMany({ select: { id: true, businessDate: true, status: true } });
      const closures = rows.map((row) => ({ businessDate: isoDay(row.businessDate), status: row.status }));
      const reason = input.reason.trim();
      const verdict = planReopen({ businessDate: input.businessDate, closures, reason });
      if (!verdict.ok) throw reopenRefusal(verdict, input.businessDate);

      const closure = rows.find((row) => isoDay(row.businessDate) === input.businessDate)!;
      await tx.treasuryDayClosure.update({
        where: { id: closure.id },
        data: { status: 'REOPENED', reopenedAt: new Date(), reopenedById: actor.id, reopenReason: reason },
        select: { id: true },
      });

      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TREASURY_DAY_REOPENED',
        entityType: 'TreasuryDay',
        entityId: input.businessDate,
        after: { businessDate: input.businessDate, reason },
      });

      return this.dayState(tx, input.businessDate);
    });
  }

  // ───────────────────────────────  internals  ───────────────────────────────

  /**
   * The days, `from` to `to` inclusive, on which a counted wallet moved.
   *
   * Bounded by Beirut midnights so the `occurredAt` index is used, then each
   * entry is put on its Beirut day — the same `AT TIME ZONE` the 0082 trigger
   * judges a write by. `occurredAt` is a `timestamptz`, so one conversion is
   * right here (unlike `payment_transactions`, whose column holds bare UTC).
   */
  private async activeDays(tx: Prisma.TransactionClient, from: string, to: string): Promise<string[]> {
    const start = municipalDayStart(from).toISOString();
    const end = municipalDayStart(addDays(to, 1)).toISOString();
    const rows = await tx.$queryRaw<Array<{ day: string }>>`
      SELECT DISTINCT to_char(e."occurredAt" AT TIME ZONE ${MUNICIPAL_TIME_ZONE}::text, 'YYYY-MM-DD') AS day
        FROM ${this.S}treasury_entries e
        JOIN ${this.S}treasury_accounts a ON a."id" = e."accountId"
       WHERE a."type" <> 'COLLECTOR_CUSTODY'
         AND e."occurredAt" >= ${start}::timestamptz
         AND e."occurredAt" < ${end}::timestamptz
       ORDER BY day
    `;
    return rows.map((row) => row.day);
  }
}

function walletView(row: {
  id: string;
  name: string;
  type: string;
  currency: string;
  isPrimary: boolean;
  active: boolean;
}): CountedWalletView {
  return {
    id: row.id,
    name: row.name,
    type: row.type as TreasuryAccountType,
    currency: row.currency,
    isPrimary: row.isPrimary,
    active: row.active,
  };
}

/** The safe first, then Whish, the bank and petty cash; within a type by currency, then name. */
export function compareWallets(
  a: { type: string; currency: string; name: string },
  b: { type: string; currency: string; name: string },
): number {
  return (
    (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
    a.currency.localeCompare(b.currency) ||
    a.name.localeCompare(b.name)
  );
}

function sortWallets<T extends { type: string; currency: string; name: string }>(wallets: T[]): T[] {
  return [...wallets].sort(compareWallets);
}

function personName(person: { firstName: string; lastName: string } | null): string | null {
  return person ? `${person.firstName} ${person.lastName}` : null;
}

function stateView(row: ClosureRow): TreasuryDayState {
  return {
    businessDate: isoDay(row.businessDate),
    status: row.status,
    autoClosed: row.autoClosed,
    closedAt: row.closedAt.toISOString(),
    closedByName: personName(row.closedBy),
    reopenedAt: row.reopenedAt?.toISOString() ?? null,
    reopenedByName: personName(row.reopenedBy),
    reopenReason: row.reopenReason,
  };
}

function openDay(businessDate: string): TreasuryDayState {
  return {
    businessDate,
    status: 'OPEN',
    autoClosed: false,
    closedAt: null,
    closedByName: null,
    reopenedAt: null,
    reopenedByName: null,
    reopenReason: null,
  };
}

/** The refusal for a closure the plan turned down, with the figures the message names. */
export function closureRefusal(
  verdict: Extract<DayClosureVerdict, { ok: false }>,
  businessDate: string,
): DomainError {
  switch (verdict.code) {
    case 'TREASURY_NOT_ACTIVE':
      return new ConflictError({ code: verdict.code, message: 'The treasury is not active, so no day can close.' });
    case 'DAY_BEFORE_GO_LIVE':
      return new ValidationError({
        code: verdict.code,
        message: `The treasury went live on ${verdict.day}; ${businessDate} is before it.`,
        params: { date: verdict.day! },
      });
    case 'DAY_NOT_OVER':
      return new ConflictError({
        code: verdict.code,
        message: `${businessDate} has not ended yet; only a past day can close.`,
        params: { date: businessDate },
      });
    case 'DAY_ALREADY_CLOSED':
      return new ConflictError({
        code: verdict.code,
        message: `${businessDate} is already closed.`,
        params: { date: businessDate },
      });
    case 'CLOSURE_OUT_OF_CHRONOLOGICAL_ORDER':
      return new ConflictError({
        code: verdict.code,
        message: `${verdict.day} was reopened and must be closed again first.`,
        params: { date: verdict.day! },
      });
    case 'UNRESOLVED_ACTIVE_DAYS_EXIST':
      return new ConflictError({
        code: verdict.code,
        message: `${verdict.days} earlier day(s) with movement are still open, from ${verdict.day}.`,
        params: { date: verdict.day!, count: verdict.days! },
      });
    case 'COUNT_MISSING_FOR_ACTIVE_ACCOUNTS':
      return new ConflictError({
        code: verdict.code,
        message: `${verdict.accounts} wallet(s) have not been counted for ${businessDate}.`,
        params: { count: verdict.accounts! },
      });
    case 'COUNT_EXPECTED_CHANGED':
      return new ConflictError({
        code: verdict.code,
        message: `The books of ${verdict.accounts} wallet(s) moved after they were counted.`,
        params: { count: verdict.accounts! },
      });
  }
}

function reopenRefusal(
  verdict: Exclude<ReturnType<typeof planReopen>, { ok: true }>,
  businessDate: string,
): DomainError {
  switch (verdict.code) {
    case 'REOPEN_REASON_REQUIRED':
      return new ValidationError({
        code: verdict.code,
        message: 'Reopening a closed day needs a written reason.',
        params: { min: REOPEN_REASON_MIN },
      });
    case 'DAY_NOT_CLOSED':
      return new ConflictError({
        code: verdict.code,
        message: `${businessDate} is not closed.`,
        params: { date: businessDate },
      });
    case 'ONLY_LATEST_CLOSED_DAY_CAN_BE_REOPENED':
      return new ConflictError({
        code: verdict.code,
        message: `Only the latest closed day (${verdict.latest}) can be reopened.`,
        params: { date: verdict.latest },
      });
  }
}
