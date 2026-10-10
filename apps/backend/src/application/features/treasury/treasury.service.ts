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
    const [settings, accounts, sums] = await Promise.all([
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
    };
  }

  /**
   * One wallet's movements, oldest first, each with the balance after it.
   *
   * `from` and `to` are instants; the opening balance is everything before
   * `from`. A page longer than `limit` is cut and flagged, never silently
   * shortened.
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

    const before = range.from
      ? await this.db.treasuryEntry.aggregate({
          where: { accountId, occurredAt: { lt: range.from } },
          _sum: { amount: true },
        })
      : null;
    const opening = before?._sum.amount ?? new Prisma.Decimal(0);

    const rows = await this.db.treasuryEntry.findMany({
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
      orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
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

    const truncated = rows.length > limit;
    const page = truncated ? rows.slice(0, limit) : rows;

    const total = await this.db.treasuryEntry.aggregate({ where: { accountId }, _sum: { amount: true } });

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
    return runInTenantTransaction(this.tenantContext, async () => {
      const tx = this.db as Prisma.TransactionClient;

      /*
        The singleton may not exist yet on a municipality that never opened
        الإعدادات. INSERT … ON CONFLICT DO NOTHING rather than upsert: two
        administrators pressing the button together would both find no row and
        both insert, and the loser's unique violation would abort its
        transaction with a raw database error instead of «مفعّلة مسبقاً».
      */
      await tx.$executeRaw`
        INSERT INTO ${this.S}system_settings ("id", "singleton", "updatedAt")
        VALUES (gen_random_uuid(), true, now())
        ON CONFLICT ("singleton") DO NOTHING
      `;
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
