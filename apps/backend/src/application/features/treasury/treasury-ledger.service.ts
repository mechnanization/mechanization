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

  /** The go-live stamp and the municipality's rate, read in the caller's transaction. */
  async config(tx: Prisma.TransactionClient): Promise<TreasuryConfig> {
    const settings = await tx.systemSettings.findFirst({
      select: { treasuryGoLiveAt: true, exchangeRate: true },
    });
    return {
      goLiveAt: settings?.treasuryGoLiveAt ?? null,
      exchangeRate: settings?.exchangeRate ?? null,
    };
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
          exchangeRateAtPosting: context.exchangeRate ?? null,
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
      select: { id: true, accountId: true, currency: true, amount: true },
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
      select: { id: true, accountId: true, currency: true, amount: true },
      orderBy: { id: 'asc' },
    });

    if (originals.length > 0) {
      await this.post(
        tx,
        originals.map((entry) => ({
          accountId: entry.accountId,
          currency: entry.currency,
          amount: entry.amount.negated(),
          reversalOfId: entry.id,
        })),
        {
          source: 'CITIZEN_PAYMENT',
          sourceId: input.reversalTransactionId,
          actorId: input.actorId,
          occurredAt: input.occurredAt,
          exchangeRate: config.exchangeRate,
        },
      );
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
