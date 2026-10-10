import { Injectable } from '@nestjs/common';
import {
  municipalToday,
  sameMoney,
  type DailyCountLineView,
  type DailyCountSheet,
  type DailyCountView,
  type RecordDailyCountInput,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { closedTreasuryDay } from '../../../infrastructure/prisma/check-violation';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { addDays, nextDayToClose, planCountDate, planCountLine } from './day-closing.plan';
import { DayClosureService, type CountRow } from './day-closure.service';
import { municipalDayStart } from './income.plan';
import { dateColumn, TreasuryLedgerService } from './treasury-ledger.service';

/**
 * «جرد الصندوق» — what each wallet held at the end of a municipal day, beside
 * what the books say it should have held.
 *
 * ## The books' figure is the server's
 *
 * The expected balance is the wallet's entries summed to the end of the day,
 * computed here when the count is recorded and stored beside it. The screen
 * sends the figure it showed only so the server can tell when it has moved:
 * a back-dated voucher entered while the accountant was counting changes the
 * difference, and a reason written for the old difference is refused
 * (`COUNT_EXPECTED_CHANGED`) rather than filed against the new one.
 *
 * ## A difference changes nothing
 *
 * Nothing here writes a ledger entry. A shortage is recorded with its reason
 * and printed on the day's report; bringing the wallet into line is the
 * manager's separate act (docs/finance.md §7.2).
 */
@Injectable()
export class DailyCountService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly ledger: TreasuryLedgerService,
    private readonly closures: DayClosureService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  /**
   * The count sheet for one day — or, with no day asked for, for the day that
   * needs closing next (`nextDayToClose`).
   */
  async sheet(date?: string): Promise<DailyCountSheet> {
    const tx = this.db as Prisma.TransactionClient;
    const today = municipalToday();
    const book = await this.closures.bookState(tx, today);
    const next = nextDayToClose({
      goLiveOn: book.goLiveOn,
      today,
      closures: book.closures,
      activeDays: book.activeDays,
    });
    const businessDate = date ?? next ?? today;

    const [facts, day] = await Promise.all([
      this.closures.dayFacts(tx, book, businessDate, today),
      this.closures.dayState(tx, businessDate),
    ]);

    const lines: DailyCountLineView[] = facts.wallets.map((wallet) => {
      const expected = facts.expectedNow.get(wallet.id) ?? new Prisma.Decimal(0);
      const count = facts.counts.get(wallet.id);
      return {
        account: wallet,
        expectedAmount: expected.toNumber(),
        count: count ? countView(count, expected) : null,
      };
    });

    return {
      day,
      today,
      goLiveOn: book.goLiveOn,
      closedThrough: book.closedThrough,
      nextDayToClose: next,
      lines,
      closure: facts.verdict,
      reopenable: day.status === 'CLOSED' && businessDate === book.closedThrough,
    };
  }

  /**
   * «سجّل الجرد» — one or more wallets counted for one day, in one transaction.
   *
   * A wallet counted again replaces its count, until the day closes; from then
   * on the 0082 trigger refuses any change. The whole request is judged before
   * anything is written, so a refusal on the third wallet leaves the first two
   * as they were.
   */
  async record(input: RecordDailyCountInput, actor: { id: string; role: string }): Promise<DailyCountSheet> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;
      await this.ledger.lockDayBook(tx);

      const today = municipalToday();
      const config = await this.ledger.config(tx);
      const verdict = planCountDate({
        businessDate: input.businessDate,
        today,
        goLiveOn: config.goLiveAt ? municipalToday(config.goLiveAt) : null,
        closedThrough: await this.ledger.closedThrough(tx),
      });
      if (!verdict.ok) {
        switch (verdict.code) {
          case 'TREASURY_NOT_ACTIVE':
            throw new ConflictError({ code: verdict.code, message: 'The treasury is not active, so there is nothing to count.' });
          case 'COUNT_DATE_IN_FUTURE':
            throw new ValidationError({ code: verdict.code, message: `${input.businessDate} has not come yet.` });
          case 'DAY_BEFORE_GO_LIVE':
            throw new ValidationError({
              code: verdict.code,
              message: `The treasury went live on ${verdict.goLiveOn}.`,
              params: { date: verdict.goLiveOn },
            });
          case 'DAY_ALREADY_CLOSED':
            throw new ConflictError({
              code: verdict.code,
              message: `${input.businessDate} is closed; its counts can no longer change.`,
              params: { date: input.businessDate },
            });
        }
      }

      const dayEnd = municipalDayStart(addDays(input.businessDate, 1));
      const ids = input.counts.map((line) => line.accountId);
      // Only a wallet this day's close counts: never custody, nor one that had no part in the day.
      const accounts = await this.closures.countedWallets(tx, dayEnd);
      const byId = new Map(accounts.map((account) => [account.id, account]));
      for (const line of input.counts) {
        if (!byId.has(line.accountId)) {
          throw new NotFoundError({
            code: 'TREASURY_ACCOUNT_NOT_FOUND',
            message: `Treasury account ${line.accountId} is not counted on ${input.businessDate}.`,
          });
        }
      }

      const expected = await this.ledger.balancesBefore(tx, ids, dayEnd);

      // Judge every line before writing any of them.
      const stale = input.counts.filter(
        (line) => !sameMoney(line.expectedAmount, expected.get(line.accountId)!.toNumber()),
      );
      if (stale.length > 0) {
        throw new ConflictError({
          code: 'COUNT_EXPECTED_CHANGED',
          message: `The books of ${stale.length} wallet(s) moved since the sheet was loaded.`,
          params: { count: stale.length },
          details: {
            accounts: stale.map((line) => ({
              accountId: line.accountId,
              expectedAmount: expected.get(line.accountId)!.toNumber(),
            })),
          },
        });
      }
      const judged = input.counts.map((line) => {
        const actual = expected.get(line.accountId)!;
        const verdict = planCountLine({
          shownExpected: line.expectedAmount,
          actualExpected: actual.toNumber(),
          counted: line.countedAmount,
          reason: line.varianceReason,
        });
        if (!verdict.ok) {
          throw new ValidationError({
            code: 'COUNT_VARIANCE_REASON_REQUIRED',
            message: 'A count that differs from the books must say why.',
            params: { account: byId.get(line.accountId)!.name },
            details: { accountId: line.accountId },
          });
        }
        const counted = new Prisma.Decimal(line.countedAmount);
        return {
          line,
          account: byId.get(line.accountId)!,
          expectedAmount: actual,
          countedAmount: counted,
          // In Decimal, so the CHECK «difference = counted − expected» holds to the cent.
          difference: counted.minus(actual),
          reason: verdict.reason,
        };
      });

      const countedAt = new Date();
      const businessDate = dateColumn(input.businessDate);
      try {
        for (const row of judged) {
          const values = {
            currency: row.account.currency,
            expectedAmount: row.expectedAmount,
            countedAmount: row.countedAmount,
            difference: row.difference,
            varianceReason: row.reason,
            countedById: actor.id,
            countedAt,
          };
          await tx.treasuryCount.upsert({
            where: { accountId_businessDate: { accountId: row.account.id, businessDate } },
            create: { accountId: row.account.id, businessDate, ...values },
            update: values,
            select: { id: true },
          });
        }
      } catch (error) {
        // Closed under us is impossible behind the day-book lock; mapped all the same.
        const day = closedTreasuryDay(error);
        if (day !== null) {
          throw new ConflictError({
            code: 'DAY_ALREADY_CLOSED',
            message: `${day} is closed; its counts can no longer change.`,
            params: { date: day },
          });
        }
        throw error;
      }

      // Tier 1, filed under the day so its history reads from one place.
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TREASURY_COUNT_RECORDED',
        entityType: 'TreasuryDay',
        entityId: input.businessDate,
        after: {
          businessDate: input.businessDate,
          counts: judged.map((row) => ({
            accountId: row.account.id,
            currency: row.account.currency,
            expected: row.expectedAmount.toNumber(),
            counted: row.countedAmount.toNumber(),
            difference: row.difference.toNumber(),
            reason: row.reason,
          })),
        },
      });
    });

    return this.sheet(input.businessDate);
  }
}

/** A recorded count as a screen reads it, judged against the books as they stand now. */
export function countView(count: CountRow, expectedNow: Prisma.Decimal): DailyCountView {
  return {
    expectedAmount: count.expectedAmount.toNumber(),
    countedAmount: count.countedAmount.toNumber(),
    difference: count.difference.toNumber(),
    varianceReason: count.varianceReason,
    countedByName: `${count.countedBy.firstName} ${count.countedBy.lastName}`,
    countedAt: count.countedAt.toISOString(),
    stale: !count.expectedAmount.equals(expectedNow),
  };
}
