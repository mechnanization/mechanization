import { Injectable } from '@nestjs/common';
import {
  MUNICIPAL_TIME_ZONE,
  municipalDayStart,
  municipalToday,
  type PaymentMethod,
  type TreasuryEntrySource,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { closedTreasuryDay } from '../../../infrastructure/prisma/check-violation';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { closedDayFor } from './day-closing.plan';
import {
  creditsWallets,
  planPaymentLegs,
  planCreditRefund,
  type PaymentMovement,
  type WalletLeg,
  type WalletTarget,
} from './treasury.plan';

/** One signed movement on one wallet, as a caller describes it. */
export interface EntryDraft {
  accountId: string;
  /** Must be the account's own currency; the database refuses anything else. */
  currency: string;
  /** Positive in, negative out. */
  amount: Prisma.Decimal;
  /** The entry this one reverses, when it is an opposing entry. */
  reversalOfId?: string;
  /**
   * The rate to stamp, when it is not the posting's own. An opposing entry
   * carries its original's, so the pair nets to zero in a report that values
   * each entry at its own rate (docs/finance.md §3.6).
   */
  exchangeRate?: Prisma.Decimal | null;
}

export interface PostContext {
  source: TreasuryEntrySource;
  sourceId: string | null;
  actorId: string | null;
  occurredAt: Date;
  note?: string | null;
  /** The municipality's rate when posted; read once by the caller. */
  exchangeRate?: Prisma.Decimal | null;
}

export interface TreasuryConfig {
  goLiveAt: Date | null;
  exchangeRate: Prisma.Decimal | null;
  /**
   * «سقف الدفع العاجل» per currency (0083, docs/finance.md §5.1, decision D6):
   * the most an accountant's urgent voucher may pay before the manager's
   * order. NULL is no ceiling; a currency with no column has none.
   */
  urgentExpenseCeiling: { LBP: Prisma.Decimal | null; USD: Prisma.Decimal | null };
  /**
   * «سقف صرف الرواتب» per currency (0091, the owner's decision of 2026-10-12):
   * the most an accountant may pay one staff member as a month's salary on the
   * art. 35 path. NULL is no ceiling.
   */
  salaryUrgentCeiling: { LBP: Prisma.Decimal | null; USD: Prisma.Decimal | null };
  /**
   * The municipality's two currencies and how far a counter rate may stray from
   * the official one (0084's exchange rule), read with the rate itself so a
   * payment judges its notes by one consistent row (finance audit B8, A2).
   */
  baseCurrency: string;
  secondaryCurrency: string | null;
  exchangeRateTolerancePercent: Prisma.Decimal | null;
}

/**
 * Writes the treasury ledger, always inside a transaction its caller owns.
 *
 * Nothing here opens a transaction: the payment ledger's own one carries the
 * wallet entries, so a payment and the money it moved commit together or not at
 * all. Every method takes that transaction client explicitly rather than
 * reading the request scope — the caller (`PaymentLedgerService`) already
 * holds it, and an entry written through any other client would commit
 * separately.
 *
 * ## The three guarantees
 *
 * 1. **No wallet goes below zero**, now or at the close of any day. A CHECK
 *    cannot see the sum of other rows, so the account rows are locked (`FOR
 *    UPDATE`, in id order, so two simultaneous postings over the same pair of
 *    wallets cannot deadlock) and the balance is read behind the lock — and,
 *    for a movement dated on an earlier day, every close from that day on
 *    (`assertCanPay`).
 * 2. **Entries are never edited.** The database refuses UPDATE and DELETE; a
 *    correction is an opposing entry (`reversalOfId`).
 * 3. **A closed day takes nothing** (docs/finance.md §7.3). Every entry is
 *    written by `post`, which refuses one dated on or before the latest closed
 *    day with `CLOSED_DAY_MUTATION_BLOCKED` — the payment, the voucher or the
 *    transfer behind it rolls back with it. The 0082 trigger holds the same
 *    rule underneath.
 */
@Injectable()
export class TreasuryLedgerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────  closed days  ─────────────────────────────

  /** The latest CLOSED business day, `YYYY-MM-DD`, or null when none is. */
  async closedThrough(tx: Prisma.TransactionClient): Promise<string | null> {
    const latest = await tx.treasuryDayClosure.aggregate({
      where: { status: 'CLOSED' },
      _max: { businessDate: true },
    });
    return latest._max.businessDate ? isoDay(latest._max.businessDate) : null;
  }

  /**
   * Refuses a movement dated on a closed day, naming the day.
   *
   * Called by `post` for every entry, by `PaymentLedgerService.recordIn` before
   * it writes anything, so a backdated round into a closed day is turned away
   * before a receipt number is drawn, and by `PaymentSettlementService` before
   * a settlement of several bills draws its «BRC-» number.
   */
  async assertDayOpen(tx: Prisma.TransactionClient, occurredAt: Date): Promise<void> {
    const day = closedDayFor(occurredAt, await this.closedThrough(tx));
    if (day !== null) throw closedDayRefusal(day);
  }

  /**
   * The same refusal for a citizen payment, asked before the payment row is
   * written — and only of a payment that will reach a wallet. One dated before
   * go-live never touches the books a closure locks (`creditsWallets`), so the
   * closure has nothing to say about it.
   */
  async assertPaymentDayOpen(tx: Prisma.TransactionClient, occurredAt: Date): Promise<void> {
    const config = await this.config(tx);
    if (!creditsWallets(config.goLiveAt, occurredAt)) return;
    await this.assertDayOpen(tx, occurredAt);
  }

  /**
   * Serialises everything that reads or changes a day's lock — counting,
   * closing, reopening — within one municipality. The key names the schema, so
   * two municipalities never wait on each other (docs/database.md).
   */
  async lockDayBook(tx: Prisma.TransactionClient): Promise<void> {
    const key = `${this.tenantContext.schemaName}:treasury-day-book`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /** Each account's balance from the entries before `before` — a day's end is the next day's start. */
  async balancesBefore(
    tx: Prisma.TransactionClient,
    accountIds: readonly string[],
    before: Date,
  ): Promise<Map<string, Prisma.Decimal>> {
    const balances = new Map<string, Prisma.Decimal>(accountIds.map((id) => [id, new Prisma.Decimal(0)]));
    if (accountIds.length === 0) return balances;
    const sums = await tx.treasuryEntry.groupBy({
      by: ['accountId'],
      where: { accountId: { in: [...accountIds] }, occurredAt: { lt: before } },
      _sum: { amount: true },
    });
    for (const row of sums) balances.set(row.accountId, row._sum.amount ?? new Prisma.Decimal(0));
    return balances;
  }

  /**
   * The go-live stamp, the municipality's rate and the urgent-payment ceilings,
   * read in the caller's transaction.
   *
   * `FOR SHARE`, not a plain read: activation holds this row `FOR UPDATE` from
   * the moment it stamps `treasuryGoLiveAt` until it commits, and a plain read
   * in that window sees NULL — a payment taken after the stamp would then credit
   * no wallet, and nothing would ever correct it. The share lock makes the reader
   * wait for the commit and then see the stamp. Readers do not block each other.
   * The same lock keeps a ceiling the manager is changing from being read half
   * way: an expense waits for the settings save and then judges by the new one.
   *
   * Called before `lockAccounts`: the settings row, then the wallets, is the
   * one order every caller takes them in.
   */
  async config(tx: Prisma.TransactionClient): Promise<TreasuryConfig> {
    const rows = await tx.$queryRaw<
      Array<{
        treasuryGoLiveAt: Date | null;
        exchangeRate: Prisma.Decimal | null;
        urgentExpenseCeilingLbp: Prisma.Decimal | null;
        urgentExpenseCeilingUsd: Prisma.Decimal | null;
        salaryUrgentCeilingLbp: Prisma.Decimal | null;
        salaryUrgentCeilingUsd: Prisma.Decimal | null;
        baseCurrency: string;
        secondaryCurrency: string | null;
        exchangeRateTolerancePercent: Prisma.Decimal | null;
      }>
    >`
      SELECT "treasuryGoLiveAt", "exchangeRate", "urgentExpenseCeilingLbp", "urgentExpenseCeilingUsd",
             "salaryUrgentCeilingLbp", "salaryUrgentCeilingUsd", "baseCurrency", "secondaryCurrency",
             "exchangeRateTolerancePercent"
        FROM ${this.S}system_settings
       LIMIT 1
         FOR SHARE
    `;
    return {
      goLiveAt: rows[0]?.treasuryGoLiveAt ?? null,
      exchangeRate: rows[0]?.exchangeRate ?? null,
      urgentExpenseCeiling: {
        LBP: rows[0]?.urgentExpenseCeilingLbp ?? null,
        USD: rows[0]?.urgentExpenseCeilingUsd ?? null,
      },
      salaryUrgentCeiling: {
        LBP: rows[0]?.salaryUrgentCeilingLbp ?? null,
        USD: rows[0]?.salaryUrgentCeilingUsd ?? null,
      },
      baseCurrency: rows[0]?.baseCurrency ?? 'LBP',
      secondaryCurrency: rows[0]?.secondaryCurrency ?? null,
      exchangeRateTolerancePercent: rows[0]?.exchangeRateTolerancePercent ?? null,
    };
  }

  /**
   * Locks wallet rows, in id order, before the caller writes anything that
   * references them.
   *
   * Inserting a voucher or a transfer checks its foreign key to
   * `treasury_accounts`, and that check takes `FOR KEY SHARE` on the wallet. If
   * `post` only asked for `FOR UPDATE` afterwards, an expense and a handover on
   * the same safe would each hold the weak lock and wait for the other to let
   * go — a deadlock, reproduced 17 times in 25 simultaneous rounds. Taking the
   * strong lock first, in the same id order as `post`, is what keeps guarantee 1
   * deadlock-free across callers. `post` re-locking rows this transaction
   * already holds costs nothing.
   *
   * An act that posts more than once — a transfer and the voucher for its fee
   * — calls this first with every wallet it will touch: two `post`s, each
   * locking in order, can still meet in the opposite order between them.
   * Returns the wallets that exist; `post` reads their names from it.
   */
  async lockAccounts(
    tx: Prisma.TransactionClient,
    accountIds: readonly string[],
  ): Promise<Array<{ id: string; name: string; currency: string }>> {
    const ids = [...new Set(accountIds)].sort();
    if (ids.length === 0) return [];
    return tx.$queryRaw<Array<{ id: string; name: string; currency: string }>>`
      SELECT "id", "name", "currency"
        FROM ${this.S}treasury_accounts
       WHERE "id" = ANY(${ids}::uuid[])
       ORDER BY "id"
       FOR UPDATE
    `;
  }

  /**
   * Locks, in one call and so in id order, every wallet that a set of citizen
   * payments recorded in this transaction will post to — before the first of
   * them posts.
   *
   * For an act that records several payments in one transaction (a settlement
   * of several bills, docs/finance.md §3.7). Each payment's `post` locks only
   * its own wallets, so bill by bill the act took them in the order the bills
   * fell due: a ليرة bill's safe, then a dollar bill's. An exchange between
   * the same two safes takes both in id order, and when the bills' order was
   * the reverse of the ids, each held the wallet the other was waiting for — a
   * deadlock. Taking them all here, in the one order every writer uses, closes
   * that. The wallets are the ones `creditPayment` would resolve for the same
   * movements (`planPaymentLegs`): a collector's custody is created now rather
   * than at his first bill, and a missing primary account is refused now with
   * the code `creditPayment` would have refused it with.
   *
   * Lock order: the settings row (`config`, FOR SHARE), then the wallets. The
   * caller must already hold the RECEIPT counter, which a single payment takes
   * before its wallets (`PaymentLedgerService.append`); taking the wallets
   * first would wait on a counter payment that is waiting on them. Nothing to
   * lock when the payments credit no wallet (`creditsWallets`).
   */
  async lockPaymentWallets(
    tx: Prisma.TransactionClient,
    movements: readonly PaymentMovement[],
    occurredAt: Date,
  ): Promise<void> {
    const config = await this.config(tx);
    if (!creditsWallets(config.goLiveAt, occurredAt)) return;
    const ids: string[] = [];
    for (const movement of movements) {
      for (const leg of planPaymentLegs(movement).legs) ids.push((await this.resolve(tx, leg.target)).id);
    }
    await this.lockAccounts(tx, ids);
  }

  /** The sum of an account's entries. Read behind the account lock when a decision hangs on it. */
  async balanceOf(tx: Prisma.TransactionClient, accountId: string): Promise<Prisma.Decimal> {
    const total = await tx.treasuryEntry.aggregate({
      where: { accountId },
      _sum: { amount: true },
    });
    return total._sum.amount ?? new Prisma.Decimal(0);
  }

  /**
   * Refuses taking `amount` out of a wallet at `occurredAt` when the wallet
   * cannot cover it — now, or at the close of the day the movement is dated on
   * or of any day since. Read behind the wallet's lock (`lockAccounts`); `post`
   * asks it of every outflow, and a caller that judges one before posting
   * (a transfer, for amount + fee) asks it too, so both answer alike.
   *
   * The balance now is the whole test for a movement dated today: its day has
   * not closed, and nothing is dated after now. It is not the test for one
   * dated on an earlier day. That entry lands on the earlier day and on every
   * close after it, and a day's close is what is counted, closed and signed
   * (docs/finance.md §7); the balance now says nothing about them. An expense
   * dated three days ago from a bank account opened and funded today passed on
   * today's balance, and that day then closed at −4,000,000 ل.ل, its count
   * forced to a surplus that never existed, on the signed register (review of
   * 2026-10-11). Days, not instants: a back-dated document's hour is nominal
   * (midday UTC, `documentOccurredAt`), so money that reached the wallet later
   * that same day still covers it.
   *
   * Two refusals, so each names a figure the clerk can find:
   * `TREASURY_INSUFFICIENT_FUNDS` with the balance now, as always, and
   * `TREASURY_INSUFFICIENT_FUNDS_ON_DAY` with the first day whose close falls
   * short, and that close. A movement dated on a closed day is refused as such
   * (`CLOSED_DAY_MUTATION_BLOCKED`) before its day's closes are judged: nothing
   * is recorded there whatever the wallet held, so a shortfall on it is not
   * the answer to give.
   */
  async assertCanPay(
    tx: Prisma.TransactionClient,
    account: { id: string; name: string; currency: string },
    amount: Prisma.Decimal,
    occurredAt: Date,
  ): Promise<void> {
    const balance = await this.balanceOf(tx, account.id);
    if (balance.lessThan(amount)) {
      throw new ConflictError({
        code: 'TREASURY_INSUFFICIENT_FUNDS',
        message: `Account ${account.id} does not hold enough: ${balance.toString()} available, ${amount.toString()} needed.`,
        params: {
          account: account.name,
          available: balance.toNumber(),
          required: amount.toNumber(),
          currency: account.currency,
        },
      });
    }
    if (municipalToday(occurredAt) < municipalToday()) await this.assertDayOpen(tx, occurredAt);
    const short = await this.firstShortClose(tx, account.id, occurredAt, amount);
    if (short) {
      throw new ConflictError({
        code: 'TREASURY_INSUFFICIENT_FUNDS_ON_DAY',
        message: `Account ${account.id} closed ${short.day} on ${short.close.toString()}, less than the ${amount.toString()} a movement dated ${municipalToday(occurredAt)} takes out.`,
        params: {
          account: account.name,
          date: short.day,
          available: short.close.toNumber(),
          required: amount.toNumber(),
          currency: account.currency,
        },
      });
    }
  }

  /**
   * The first municipal day, from the one `occurredAt` falls on, whose close is
   * less than `amount` — with that close — or null when every close covers it.
   * A day with no entry closes where the day before it did, so only the dated
   * day and the days with entries are read; the last of them is today, whose
   * close so far is the balance now. Nothing to read for a movement dated today.
   *
   * Grouped by the Beirut day the 0082 trigger judges an entry by
   * (`occurredAt AT TIME ZONE`, a `timestamptz`), from that day's Beirut midnight.
   */
  async firstShortClose(
    tx: Prisma.TransactionClient,
    accountId: string,
    occurredAt: Date,
    amount: Prisma.Decimal,
  ): Promise<{ day: string; close: Prisma.Decimal } | null> {
    const dated = municipalToday(occurredAt);
    if (dated >= municipalToday()) return null;

    const start = municipalDayStart(dated);
    const before = await tx.treasuryEntry.aggregate({
      where: { accountId, occurredAt: { lt: start } },
      _sum: { amount: true },
    });
    const days = await tx.$queryRaw<Array<{ day: string; total: Prisma.Decimal }>>`
      SELECT to_char("occurredAt" AT TIME ZONE ${MUNICIPAL_TIME_ZONE}::text, 'YYYY-MM-DD') AS day,
             SUM("amount") AS total
        FROM ${this.S}treasury_entries
       WHERE "accountId" = ${accountId}::uuid
         AND "occurredAt" >= ${start.toISOString()}::timestamptz
       GROUP BY 1
       ORDER BY 1
    `;

    let close = before._sum.amount ?? new Prisma.Decimal(0);
    // The dated day itself, when nothing else moved on it: it closes on the balance it opened with.
    if (days[0]?.day !== dated && close.lessThan(amount)) return { day: dated, close };
    for (const row of days) {
      close = close.plus(row.total);
      if (close.lessThan(amount)) return { day: row.day, close };
    }
    return null;
  }

  /**
   * Posts the entries of one act, atomically with the caller's transaction.
   *
   * Refuses the whole act, writing nothing, when any wallet would end below
   * zero — now, or at the close of any day from the one the act is dated on
   * (`assertCanPay`). Several entries on one wallet are netted before the
   * check: a $20 note in and $5 of change out is a net +$15, and judged as such.
   */
  async post(
    tx: Prisma.TransactionClient,
    drafts: EntryDraft[],
    context: PostContext,
  ): Promise<void> {
    if (drafts.length === 0) return;

    // Every entry of one act shares its day, so one check covers them all.
    await this.assertDayOpen(tx, context.occurredAt);

    const net = new Map<string, Prisma.Decimal>();
    for (const draft of drafts) {
      net.set(draft.accountId, (net.get(draft.accountId) ?? new Prisma.Decimal(0)).plus(draft.amount));
    }
    const ids = [...net.keys()].sort();
    const locked = await this.lockAccounts(tx, ids);
    const byId = new Map(locked.map((row) => [row.id, row]));

    for (const id of ids) {
      const account = byId.get(id);
      if (!account) {
        throw new NotFoundError({
          code: 'TREASURY_ACCOUNT_NOT_FOUND',
          message: 'A treasury account named by this movement does not exist.',
        });
      }
      const change = net.get(id)!;
      if (change.isNegative()) await this.assertCanPay(tx, account, change.abs(), context.occurredAt);
    }

    for (const draft of drafts) {
      try {
        await tx.treasuryEntry.create({
          data: {
            accountId: draft.accountId,
            currency: draft.currency,
            amount: draft.amount,
            exchangeRateAtPosting:
              draft.exchangeRate !== undefined ? draft.exchangeRate : (context.exchangeRate ?? null),
            source: context.source as never,
            sourceId: context.sourceId,
            reversalOfId: draft.reversalOfId ?? null,
            actorId: context.actorId,
            note: context.note ?? null,
            occurredAt: context.occurredAt,
          },
          select: { id: true },
        });
      } catch (error) {
        /*
          The day was closed between the check above and this insert, and the
          0082 trigger refused it. Same refusal, same words; the transaction is
          already aborted, and rethrowing rolls the whole act back.
        */
        const day = closedTreasuryDay(error);
        if (day !== null) throw closedDayRefusal(day);
        throw error;
      }
    }
  }

  /**
   * Opposes every entry one act produced, leaving both on the record.
   *
   * The opposing entries carry the same `source` and `sourceId` as the ones
   * they undo, so "what did this voucher move" answers with the whole story —
   * the payment and its cancellation — rather than with a row that has to be
   * joined to something else to make sense.
   *
   * Posting them goes through `post`, so a reversal that would take a wallet
   * below zero is refused like any other outflow: the money a voided voucher
   * paid out has to be back in the wallet before the void can stand.
   */
  async reverseEntriesOf(
    tx: Prisma.TransactionClient,
    input: {
      source: TreasuryEntrySource;
      sourceId: string;
      actorId: string | null;
      occurredAt: Date;
      note?: string | null;
    },
  ): Promise<number> {
    const originals = await tx.treasuryEntry.findMany({
      where: { source: input.source as never, sourceId: input.sourceId, reversalOfId: null },
      select: { id: true, accountId: true, currency: true, amount: true, exchangeRateAtPosting: true },
      orderBy: { id: 'asc' },
    });
    if (originals.length === 0) return 0;

    const config = await this.config(tx);
    await this.post(
      tx,
      originals.map((entry) => ({
        accountId: entry.accountId,
        currency: entry.currency,
        amount: entry.amount.negated(),
        reversalOfId: entry.id,
        exchangeRate: entry.exchangeRateAtPosting,
      })),
      {
        source: input.source,
        sourceId: input.sourceId,
        actorId: input.actorId,
        occurredAt: input.occurredAt,
        exchangeRate: config.exchangeRate,
        note: input.note ?? null,
      },
    );
    return originals.length;
  }

  // ─────────────────────────  citizen payments  ─────────────────────────

  /**
   * Credits the wallets for a payment just recorded — only once the treasury is
   * live, and only for a payment taken at or after the go-live moment.
   *
   * `paymentTransactionId` is the new `payment_transactions` row; the entries
   * carry it as `sourceId`, which is how a later reversal finds them.
   */
  async creditPayment(
    tx: Prisma.TransactionClient,
    input: PaymentMovement & {
      paymentTransactionId: string;
      occurredAt: Date;
      actorId: string | null;
    },
  ): Promise<void> {
    const config = await this.config(tx);
    if (!creditsWallets(config.goLiveAt, input.occurredAt)) return;

    const { legs, collectorUnknown } = planPaymentLegs(input);
    const drafts = await this.draftsFor(tx, legs);
    await this.post(tx, drafts, {
      source: 'CITIZEN_PAYMENT',
      sourceId: input.paymentTransactionId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      exchangeRate: config.exchangeRate,
      note: collectorUnknown ? 'جابٍ غير محدد: سُجّلت في الصندوق الرئيسي' : null,
    });
  }

  /**
   * Takes the wallet entries of a reversed payment back out.
   *
   * - The original left entries: each is opposed exactly, to the same wallet —
   *   the notes it took in go back, and the change it handed out comes back.
   * - Except the bill of a cash settlement that carried the set's notes and
   *   change (the pivot, docs/finance.md §3.7): those paid every bill of the set,
   *   and its change, recycled, paid the older ones, so the citizen never held
   *   what opposing them would take back. That bill is refunded its own credit,
   *   in its currency, from the safe (`planCreditRefund`), as its reversal
   *   receipt says.
   * - It left none because it was taken before go-live: cash still leaves the
   *   drawer today, so a refund entry is written from the wallet of the
   *   original method (`planCreditRefund`).
   * - The treasury is not active: nothing to do.
   *
   * In every case the wallet balance is checked first: a refund the drawer
   * cannot cover is refused until money is moved in.
   */
  async reversePayment(
    tx: Prisma.TransactionClient,
    input: {
      originalTransactionId: string;
      reversalTransactionId: string;
      method: PaymentMethod;
      invoiceCurrency: string;
      /** The original credit, positive. */
      amount: number;
      occurredAt: Date;
      actorId: string | null;
    },
  ): Promise<void> {
    const config = await this.config(tx);
    if (!config.goLiveAt) return;

    const originals = await tx.treasuryEntry.findMany({
      where: { source: 'CITIZEN_PAYMENT', sourceId: input.originalTransactionId, reversalOfId: null },
      select: { id: true, accountId: true, currency: true, amount: true, exchangeRateAtPosting: true },
      orderBy: { id: 'asc' },
    });

    const original = await tx.paymentTransaction.findUnique({
      where: { id: input.originalTransactionId },
      select: { occurredAt: true, settlementId: true, tenderedLocal: true },
    });

    if (originals.length > 0) {
      /*
        A settlement's rows are plain sums of their bills, except the one that
        carried the notes (`planBulkSettlement`, the only row of a set with a
        tender): $20 for a 900,000 and a 100,000 ل.ل bill is +$20 and −1,690,000
        ل.ل on the newer bill's row, for 790,000 handed back. Opposed, its
        reversal took the $20 back and put 1,690,000 into the safe — money the
        citizen never had — while its receipt said 100,000 refunded, and the
        older bill was left paid in ليرة that never came in.
      */
      if (original?.settlementId && original.tenderedLocal !== null) {
        const refund = planCreditRefund({
          method: input.method,
          invoiceCurrency: input.invoiceCurrency,
          amount: input.amount,
        });
        await this.post(tx, await this.draftsFor(tx, refund), {
          source: 'CITIZEN_PAYMENT',
          sourceId: input.reversalTransactionId,
          actorId: input.actorId,
          occurredAt: input.occurredAt,
          exchangeRate: config.exchangeRate,
          note: 'استرداد فاتورة من تسديد مجمّع: تُردّ قيمتها بعملتها من الصندوق',
        });
        return;
      }
      const { drafts, fromSafe } = await this.refundDrafts(tx, originals);
      await this.post(tx, drafts, {
        source: 'CITIZEN_PAYMENT',
        sourceId: input.reversalTransactionId,
        actorId: input.actorId,
        occurredAt: input.occurredAt,
        exchangeRate: config.exchangeRate,
        note: fromSafe ? 'استرداد من الصندوق: كان الجابي قد سلّم المبلغ' : null,
      });
      return;
    }

    if (!original || original.occurredAt.getTime() >= config.goLiveAt.getTime()) return;

    const legs = planCreditRefund({
      method: input.method,
      invoiceCurrency: input.invoiceCurrency,
      amount: input.amount,
    });
    await this.post(tx, await this.draftsFor(tx, legs), {
      source: 'CITIZEN_PAYMENT',
      sourceId: input.reversalTransactionId,
      actorId: input.actorId,
      occurredAt: input.occurredAt,
      exchangeRate: config.exchangeRate,
      note: 'استرداد دفعة سابقة لتفعيل الخزينة',
    });
  }

  // ─────────────────────────────  internals  ─────────────────────────────

  /**
   * The wallets a reversed payment's money comes back out of (docs/finance.md
   * §3.4, decision of 2026-10-09).
   *
   * Normally the ones it went into, opposed entry by entry. The exception is a
   * collector's payment whose cash he has since handed in: the custody wallet no
   * longer holds it — the safe does — so opposing the custody entry would be
   * refused for want of funds, and the refund could never be made. Then the
   * refund leaves the safe of the same currency, which is where municipal
   * practice takes any refund from: a collector may pay nothing out (decree
   * 5595/1982 art. 93), and refunds go through the treasury, never out of
   * collections. Decided for the whole payment, never leg by leg, so a tender's
   * note and its change come back through the same place.
   *
   * Each opposing entry still names the entry it reverses (`reversalOfId`) and
   * carries that entry's own rate.
   */
  private async refundDrafts(
    tx: Prisma.TransactionClient,
    originals: Array<{
      id: string;
      accountId: string;
      currency: string;
      amount: Prisma.Decimal;
      exchangeRateAtPosting: Prisma.Decimal | null;
    }>,
  ): Promise<{ drafts: EntryDraft[]; fromSafe: boolean }> {
    const opposed = (entry: (typeof originals)[number], accountId = entry.accountId): EntryDraft => ({
      accountId,
      currency: entry.currency,
      amount: entry.amount.negated(),
      reversalOfId: entry.id,
      exchangeRate: entry.exchangeRateAtPosting,
    });

    const accounts = await tx.treasuryAccount.findMany({
      where: { id: { in: [...new Set(originals.map((entry) => entry.accountId))] } },
      select: { id: true, type: true },
    });
    const custodyIds = accounts.filter((account) => account.type === 'COLLECTOR_CUSTODY').map((a) => a.id);
    if (custodyIds.length === 0) return { drafts: originals.map((entry) => opposed(entry)), fromSafe: false };

    /*
      The custody wallets and the safes a refund might fall back on, locked
      together and in id order before any balance is read — the order `post`
      and every other caller lock in, so this cannot deadlock against a handover
      moving money between the same two wallets.
    */
    const currencies = [
      ...new Set(originals.filter((entry) => custodyIds.includes(entry.accountId)).map((e) => e.currency)),
    ];
    const safes = await tx.treasuryAccount.findMany({
      where: { type: 'CASH_SAFE', isPrimary: true, active: true, currency: { in: currencies } },
      select: { id: true },
    });
    await this.lockAccounts(tx, [...custodyIds, ...safes.map((safe) => safe.id)]);
    let covered = true;
    for (const custodyId of custodyIds) {
      const broughtIn = originals
        .filter((entry) => entry.accountId === custodyId)
        .reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0));
      if (broughtIn.isPositive() && (await this.balanceOf(tx, custodyId)).lessThan(broughtIn)) covered = false;
    }
    if (covered) return { drafts: originals.map((entry) => opposed(entry)), fromSafe: false };

    const drafts: EntryDraft[] = [];
    for (const entry of originals) {
      if (!custodyIds.includes(entry.accountId)) {
        drafts.push(opposed(entry));
        continue;
      }
      const safe = await this.resolve(tx, { kind: 'PRIMARY', type: 'CASH_SAFE', currency: entry.currency });
      drafts.push(opposed(entry, safe.id));
    }
    return { drafts, fromSafe: true };
  }

  private async draftsFor(tx: Prisma.TransactionClient, legs: WalletLeg[]): Promise<EntryDraft[]> {
    const drafts: EntryDraft[] = [];
    for (const leg of legs) {
      const account = await this.resolve(tx, leg.target);
      drafts.push({
        accountId: account.id,
        currency: account.currency,
        amount: new Prisma.Decimal(leg.amount),
      });
    }
    return drafts;
  }

  /** The wallet a target names. A missing primary account refuses; a missing custody account is created. */
  private async resolve(
    tx: Prisma.TransactionClient,
    target: WalletTarget,
  ): Promise<{ id: string; currency: string }> {
    if (target.kind === 'PRIMARY') {
      const account = await tx.treasuryAccount.findFirst({
        where: { type: target.type, currency: target.currency, isPrimary: true, active: true },
        select: { id: true, currency: true },
      });
      if (!account) {
        throw new ConflictError({
          code: 'TREASURY_ACCOUNT_MISSING',
          message: `No active primary ${target.type} account in ${target.currency}.`,
          params: { currency: target.currency },
        });
      }
      return account;
    }

    const existing = await this.findCustody(tx, target.ownerId, target.currency);
    if (existing) return existing;

    // `kind` in the WHERE, as on every read of `users`: only staff hold cash.
    const owner = await tx.user.findFirst({
      where: { id: target.ownerId, kind: 'STAFF' },
      select: { firstName: true, lastName: true },
    });
    if (!owner) {
      throw new NotFoundError({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
        message: 'The collector holding this cash was not found.',
      });
    }
    const name = `عهدة ${owner.firstName} ${owner.lastName} — ${target.currency}`;

    /*
      INSERT … ON CONFLICT DO NOTHING rather than create-then-catch: a unique
      violation aborts the whole Postgres transaction, and this one is carrying
      a payment. Two first collections racing each other both reach here, one
      inserts, the other's insert does nothing, and both then read the row.
    */
    await tx.$executeRaw`
      INSERT INTO ${this.S}treasury_accounts ("id", "name", "type", "currency", "ownerId")
      VALUES (gen_random_uuid(), ${name},
              CAST('COLLECTOR_CUSTODY' AS ${this.S}"TreasuryAccountType"),
              ${target.currency}, ${target.ownerId}::uuid)
      ON CONFLICT DO NOTHING
    `;
    const created = await this.findCustody(tx, target.ownerId, target.currency);
    if (!created) {
      throw new NotFoundError({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
        message: 'The collector custody account could not be created.',
      });
    }
    return created;
  }

  private findCustody(tx: Prisma.TransactionClient, ownerId: string, currency: string) {
    return tx.treasuryAccount.findFirst({
      where: { type: 'COLLECTOR_CUSTODY', ownerId, currency },
      select: { id: true, currency: true },
    });
  }
}

/** A `DATE` column as Prisma reads it — midnight UTC of the day — back to `YYYY-MM-DD`. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` as the midnight-UTC `Date` Prisma writes into a `DATE` column. */
export function dateColumn(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

/**
 * «اليوم مقفل» — the one refusal for anything dated on a closed day, from the
 * application's check and from the trigger's alike. A CONFLICT: the request is
 * well formed, the books' state refuses it.
 */
function closedDayRefusal(day: string): ConflictError {
  return new ConflictError({
    code: 'CLOSED_DAY_MUTATION_BLOCKED',
    message: `The treasury day ${day} is closed; nothing may be recorded on or before it.`,
    params: { date: day },
  });
}
