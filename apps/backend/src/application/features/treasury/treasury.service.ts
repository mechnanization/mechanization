import { Injectable } from '@nestjs/common';
import type {
  ActivateTreasuryInput,
  ActivateTreasuryResult,
  TreasuryAccountView,
  TreasuryOverview,
  TreasuryStatement,
  TreasuryStatementEntry,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { TreasuryLedgerService } from './treasury-ledger.service';

/** The order a screen lists wallets in: the safe first, then Whish, then the rest. */
const TYPE_ORDER: Record<string, number> = {
  CASH_SAFE: 0,
  WHISH_ACCOUNT: 1,
  BANK_ACCOUNT: 2,
  PETTY_CASH: 3,
  COLLECTOR_CUSTODY: 4,
};

/** Hard ceiling on one statement page: a statement is read, not exported. */
const STATEMENT_MAX_LIMIT = 500;
const STATEMENT_DEFAULT_LIMIT = 200;

@Injectable()
export class TreasuryService {
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

  /** Every wallet with its balance, the go-live state, and the rate a screen converts with. */
  async overview(): Promise<TreasuryOverview> {
    const [settings, accounts, sums, pendingExpenseRequests, vouchersAwaitingOrder] = await Promise.all([
      this.db.systemSettings.findFirst({
        select: {
          treasuryGoLiveAt: true,
          baseCurrency: true,
          secondaryCurrency: true,
          exchangeRate: true,
          exchangeRateUpdatedAt: true,
        },
      }),
      this.db.treasuryAccount.findMany({
        select: {
          id: true,
          name: true,
          type: true,
          currency: true,
          isPrimary: true,
          active: true,
          owner: { select: { firstName: true, lastName: true } },
        },
      }),
      this.db.treasuryEntry.groupBy({ by: ['accountId'], _sum: { amount: true } }),
      // What waits on the manager's payment order (decree 5595/1982 art. 28, 35).
      this.db.expenseRequest.count({ where: { decision: null } }),
      this.db.expenseVoucher.count({ where: { orderedAt: null, voidedAt: null } }),
    ]);

    const balances = new Map(sums.map((row) => [row.accountId, row._sum.amount?.toNumber() ?? 0]));
    const views = accounts.map((account) => this.view(account, balances.get(account.id) ?? 0));

    const heldByCollectors = new Map<string, number>();
    for (const account of views) {
      if (account.type !== 'COLLECTOR_CUSTODY') continue;
      heldByCollectors.set(account.currency, (heldByCollectors.get(account.currency) ?? 0) + account.balance);
    }

    return {
      active: !!settings?.treasuryGoLiveAt,
      goLiveAt: settings?.treasuryGoLiveAt?.toISOString() ?? null,
      accounts: views
        .filter((account) => account.type !== 'COLLECTOR_CUSTODY')
        .sort(
          (a, b) =>
            (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) ||
            a.currency.localeCompare(b.currency) ||
            a.name.localeCompare(b.name),
        ),
      rate: {
        baseCurrency: settings?.baseCurrency ?? 'LBP',
        secondaryCurrency: settings?.secondaryCurrency ?? null,
        exchangeRate: settings?.exchangeRate?.toNumber() ?? null,
        exchangeRateUpdatedAt: settings?.exchangeRateUpdatedAt?.toISOString() ?? null,
      },
      heldByCollectors: [...heldByCollectors.entries()]
        .map(([currency, amount]) => ({ currency, amount }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      pendingExpenseRequests,
      vouchersAwaitingOrder,
    };
  }

  /**
   * One wallet's movements, listed oldest first, each with the balance after it.
   *
   * `from` and `to` are instants. When the range holds more than `limit`
   * movements the page keeps the latest `limit` of them and says so; the
   * opening balance is then the balance before the first one shown.
   */
  async statement(
    accountId: string,
    range: { from?: Date; to?: Date; limit?: number },
  ): Promise<TreasuryStatement> {
    const account = await this.db.treasuryAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        name: true,
        type: true,
        currency: true,
        isPrimary: true,
        active: true,
        owner: { select: { firstName: true, lastName: true } },
      },
    });
    if (!account) {
      throw new NotFoundError({
        code: 'TREASURY_ACCOUNT_NOT_FOUND',
        message: `Treasury account ${accountId} was not found`,
      });
    }

    const limit = Math.min(Math.max(range.limit ?? STATEMENT_DEFAULT_LIMIT, 1), STATEMENT_MAX_LIMIT);

    /*
      One snapshot for the page and the sums the opening balance is worked back
      from. Read separately, a movement committed between them was in the sum but
      not on the page, and every running balance on the statement was off by it.
    */
    const { rows, total, atEnd } = await this.db.$transaction(
      async (tx) => {
        const rows = await tx.treasuryEntry.findMany({
          where: {
            accountId,
            ...(range.from || range.to
              ? {
                  occurredAt: {
                    ...(range.from ? { gte: range.from } : {}),
                    ...(range.to ? { lte: range.to } : {}),
                  },
                }
              : {}),
          },
          /*
            Newest first, then turned back round. Past `limit` the page keeps the
            latest movements — today's receipts and payments — not the wallet's
            first ones: a safe that every citizen payment credits passes two hundred
            entries in weeks, and its statement then never reached the present.
          */
          orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          select: {
            id: true,
            amount: true,
            currency: true,
            source: true,
            sourceId: true,
            reversalOfId: true,
            exchangeRateAtPosting: true,
            note: true,
            occurredAt: true,
            actor: { select: { firstName: true, lastName: true } },
            reversedBy: { select: { id: true } },
          },
        });
        const total = await tx.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } });

        /*
          The balance before the page's first row: the balance at the end of the
          range, less the page's own movements. With no `to` that end is today and
          the last row's balance is the wallet's balance; with a `to` it is that
          day's close — which is what makes a one-day range the day's cash register
          (docs/finance.md §7).
        */
        const atEnd = range.to
          ? ((
              await tx.treasuryEntry.aggregate({
                where: { accountId, occurredAt: { lte: range.to } },
                _sum: { amount: true },
              })
            )._sum.amount ?? new Prisma.Decimal(0))
          : (total._sum.amount ?? new Prisma.Decimal(0));
        return { rows, total, atEnd };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const truncated = rows.length > limit;
    const page = (truncated ? rows.slice(0, limit) : rows).reverse();

    const opening = page.reduce((sum, row) => sum.minus(row.amount), atEnd);

    let running = opening;
    const entries: TreasuryStatementEntry[] = page.map((row) => {
      running = running.plus(row.amount);
      return {
        id: row.id,
        amount: row.amount.toNumber(),
        currency: row.currency,
        source: row.source as TreasuryStatementEntry['source'],
        sourceId: row.sourceId,
        isReversal: row.reversalOfId !== null,
        reversed: row.reversedBy !== null,
        exchangeRateAtPosting: row.exchangeRateAtPosting?.toNumber() ?? null,
        actorName: row.actor ? `${row.actor.firstName} ${row.actor.lastName}` : null,
        note: row.note,
        occurredAt: row.occurredAt.toISOString(),
        balanceAfter: running.toNumber(),
      };
    });

    return {
      account: this.view(account, total._sum.amount?.toNumber() ?? 0),
      openingBalance: opening.toNumber(),
      entries,
      truncated,
    };
  }

  /**
   * «تفعيل الخزينة» — posts the counted opening balance of every wallet and
   * stamps the go-live moment, once, in one transaction.
   *
   * The settings row is locked first, so two administrators pressing the button
   * together cannot both succeed: the second finds the stamp set. Every active
   * wallet must be named, so the treasury never goes live with one still
   * unknown. A wallet counted at zero is a real count and writes no entry (an
   * entry of zero is not an entry).
   */
  async activate(
    input: ActivateTreasuryInput,
    actor: { id: string; role: string },
  ): Promise<ActivateTreasuryResult> {
    /*
      The singleton may not exist yet on a municipality that never opened
      الإعدادات, and it must be COMMITTED before the stamp is written. A payment
      reads the stamp `FOR SHARE` so that it waits for activation to commit — but
      a row activation inserted in its own transaction is invisible to it, so it
      would not wait, would read NULL, and the cash it took after the stamp would
      credit no wallet (reproduced). Hence its own statement, on the pooled
      client, before the transaction opens.

      INSERT … ON CONFLICT DO NOTHING rather than upsert: two administrators
      pressing the button together would both find no row and both insert, and
      the loser's unique violation would surface as a raw database error.
    */
    await this.db.$executeRaw`
      INSERT INTO ${this.S}system_settings ("id", "singleton", "updatedAt")
      VALUES (gen_random_uuid(), true, now())
      ON CONFLICT ("singleton") DO NOTHING
    `;

    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      const locked = await tx.$queryRaw<Array<{ id: string; treasuryGoLiveAt: Date | null }>>`
        SELECT "id", "treasuryGoLiveAt"
          FROM ${this.S}system_settings
         WHERE "singleton" = true
         FOR UPDATE
      `;
      const settings = locked[0];
      if (!settings) {
        throw new NotFoundError({
          code: 'TREASURY_NOT_ACTIVE',
          message: 'The settings row could not be read.',
        });
      }
      if (settings.treasuryGoLiveAt) {
        throw new ConflictError({
          code: 'TREASURY_ALREADY_ACTIVE',
          message: 'The treasury is already active.',
        });
      }

      // A custody account is created by a collection, and never has an opening balance.
      const accounts = await tx.treasuryAccount.findMany({
        where: { active: true, type: { not: 'COLLECTOR_CUSTODY' } },
        select: { id: true, currency: true },
      });
      const named = new Set(input.balances.map((b) => b.accountId));
      const expected = new Set(accounts.map((a) => a.id));
      const complete =
        named.size === expected.size && [...expected].every((id) => named.has(id));
      if (!complete) {
        throw new ConflictError({
          code: 'TREASURY_OPENING_BALANCES_INCOMPLETE',
          message: 'The opening balances must name every active account, and only those.',
          details: { expected: expected.size, given: named.size },
        });
      }

      const goLiveAt = new Date();
      const currencyOf = new Map(accounts.map((a) => [a.id, a.currency]));
      const config = await this.ledger.config(tx);
      const drafts = input.balances
        .filter((b) => b.amount > 0)
        .map((b) => ({
          accountId: b.accountId,
          currency: currencyOf.get(b.accountId)!,
          amount: new Prisma.Decimal(b.amount),
        }));

      await this.ledger.post(tx, drafts, {
        source: 'OPENING_BALANCE',
        sourceId: null,
        actorId: actor.id,
        occurredAt: goLiveAt,
        exchangeRate: config.exchangeRate,
        note: input.note ?? null,
      });

      await tx.systemSettings.update({
        where: { singleton: true },
        data: { treasuryGoLiveAt: goLiveAt },
      });

      // Tier 1: the audit row commits with the opening balances, or neither does.
      await this.audit.recordInTransaction({
        actorId: actor.id,
        actorType: 'STAFF',
        actorRole: actor.role as never,
        action: 'TREASURY_ACTIVATED',
        entityType: 'Treasury',
        entityId: settings.id,
        after: {
          goLiveAt: goLiveAt.toISOString(),
          accounts: input.balances.length,
          entriesPosted: drafts.length,
          balances: input.balances.map((b) => ({
            accountId: b.accountId,
            currency: currencyOf.get(b.accountId),
            amount: b.amount,
          })),
        },
      });

      return { goLiveAt: goLiveAt.toISOString(), entriesPosted: drafts.length };
    });
  }

  private view(
    account: {
      id: string;
      name: string;
      type: string;
      currency: string;
      isPrimary: boolean;
      active: boolean;
      owner: { firstName: string; lastName: string } | null;
    },
    balance: number,
  ): TreasuryAccountView {
    return {
      id: account.id,
      name: account.name,
      type: account.type as TreasuryAccountView['type'],
      currency: account.currency,
      isPrimary: account.isPrimary,
      active: account.active,
      ownerName: account.owner ? `${account.owner.firstName} ${account.owner.lastName}` : null,
      balance,
    };
  }
}
