import { Injectable } from '@nestjs/common';
import type { PaymentMethod, TreasuryEntrySource } from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import {
  creditsWallets,
  planPaymentLegs,
  planPreGoLiveRefund,
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
 * ## The two guarantees
 *
 * 1. **No wallet goes below zero.** A CHECK cannot see the sum of other rows,
 *    so the account rows are locked (`FOR UPDATE`, in id order, so two
 *    simultaneous postings over the same pair of wallets cannot deadlock) and
 *    the balance is read behind the lock.
 * 2. **Entries are never edited.** The database refuses UPDATE and DELETE; a
 *    correction is an opposing entry (`reversalOfId`).
 */
@Injectable()
export class TreasuryLedgerService {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
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
      }>
    >`
      SELECT "treasuryGoLiveAt", "exchangeRate", "urgentExpenseCeilingLbp", "urgentExpenseCeilingUsd"
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
   */
  async lockAccounts(tx: Prisma.TransactionClient, accountIds: string[]): Promise<void> {
    const ids = [...new Set(accountIds)].sort();
    if (ids.length === 0) return;
    await tx.$queryRaw`
      SELECT "id"
        FROM ${this.S}treasury_accounts
       WHERE "id" = ANY(${ids}::uuid[])
       ORDER BY "id"
       FOR UPDATE
    `;
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
   * Posts the entries of one act, atomically with the caller's transaction.
   *
   * Refuses the whole act, writing nothing, when any wallet would end below
   * zero. Several entries on one wallet are netted before the check: a $20
   * note in and $5 of change out is a net +$15, and judged as such.
   */
  async post(
    tx: Prisma.TransactionClient,
    drafts: EntryDraft[],
    context: PostContext,
  ): Promise<void> {
    if (drafts.length === 0) return;

    const net = new Map<string, Prisma.Decimal>();
    for (const draft of drafts) {
      net.set(draft.accountId, (net.get(draft.accountId) ?? new Prisma.Decimal(0)).plus(draft.amount));
    }
    const ids = [...net.keys()].sort();

    /*
      Locked in id order. Two transfers over the same pair of wallets, opposite
      ways round, would otherwise each hold one row and wait for the other.
    */
    const locked = await tx.$queryRaw<Array<{ id: string; name: string; currency: string }>>`
      SELECT "id", "name", "currency"
        FROM ${this.S}treasury_accounts
       WHERE "id" = ANY(${ids}::uuid[])
       ORDER BY "id"
       FOR UPDATE
    `;
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
      if (change.isNegative()) {
        const balance = await this.balanceOf(tx, id);
        if (balance.plus(change).isNegative()) {
          throw new ConflictError({
            code: 'TREASURY_INSUFFICIENT_FUNDS',
            message: `Account ${id} does not hold enough: ${balance.toString()} available, ${change.abs().toString()} needed.`,
            params: {
              account: account.name,
              available: balance.toNumber(),
              required: change.abs().toNumber(),
              currency: account.currency,
            },
          });
        }
      }
    }

    for (const draft of drafts) {
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
   * - The original left entries: each is opposed exactly, to the same wallet.
   * - It left none because it was taken before go-live: cash still leaves the
   *   drawer today, so a refund entry is written from the wallet of the
   *   original method (`planPreGoLiveRefund`).
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

    if (originals.length > 0) {
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

    const original = await tx.paymentTransaction.findUnique({
      where: { id: input.originalTransactionId },
      select: { occurredAt: true },
    });
    if (!original || original.occurredAt.getTime() >= config.goLiveAt.getTime()) return;

    const legs = planPreGoLiveRefund({
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
