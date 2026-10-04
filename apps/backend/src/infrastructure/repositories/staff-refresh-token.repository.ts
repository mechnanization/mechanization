import { Injectable } from '@nestjs/common';
import type { StaffRefreshToken } from '../../generated/tenant-client';
import {
  NewStaffRefreshToken,
  RetryResult,
  StaffRefreshTokenRepository,
  StaffRefreshTokenRow,
} from '../../domain/interfaces/staff-refresh-token-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';

/**
 * Bounds for the two exchange transactions.
 *
 * Each is a handful of single-row statements, so anything near these limits is
 * a stuck pool, not slow work. The ceiling sits well inside the 15 seconds the
 * portal waits for a refresh, so a stuck exchange fails here and rolls back
 * rather than completing after the client has already given up on it.
 */
const EXCHANGE_TRANSACTION = { maxWait: 5_000, timeout: 10_000 } as const;

/**
 * Thrown inside `retry` to leave the transaction with everything it wrote
 * undone. Private to this file: nothing outside can throw or catch it, so it
 * can never be mistaken for a real failure.
 */
class RetryRefused extends Error {
  constructor(readonly outcome: 'descendant-used' | 'blocked') {
    super(outcome);
  }
}

/**
 * Staff refresh tokens, over the request's tenant client.
 *
 * `rotate` and `retry` open their own transaction on the pooled client rather
 * than joining `runInTenantTransaction`: `retry` refuses by throwing out of its
 * transaction so the retry allowance it spent and the siblings it superseded
 * are rolled back, and inside someone else's transaction that throw would undo
 * nothing. Nothing on the refresh path runs inside one.
 *
 * ## Why the compare-and-sets are enough at READ COMMITTED
 *
 * Every exchange starts with a conditional update of the row it exchanges, and
 * an update takes that row's lock. Two requests presenting one token therefore
 * queue on the row; the second re-evaluates its `WHERE` against the committed
 * result of the first and matches nothing. The one cross-row case — a retry
 * superseding a child while that child is being rotated — resolves the same
 * way on the child's lock, whichever side reaches it first, and step 4 of
 * `retry` re-reads the children to catch the rotation that won.
 *
 * Exchanges take row locks parent before child, so two of them cannot
 * deadlock each other. `revokeFamily` sweeps the family in one statement in
 * whatever order the index yields, so it can in principle meet a `retry`
 * holding the parent and waiting on a child; Postgres then aborts one side
 * with a deadlock error. That surfaces as a 5xx, which the portal treats as a
 * connection problem and tries again — never as a wrong answer.
 */
@Injectable()
export class PrismaStaffRefreshTokenRepository implements StaffRefreshTokenRepository {
  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  async create(input: NewStaffRefreshToken): Promise<StaffRefreshTokenRow> {
    return toRow(await this.db.staffRefreshToken.create({ data: toData(input) }));
  }

  async findById(id: string): Promise<StaffRefreshTokenRow | null> {
    const row = await this.db.staffRefreshToken.findUnique({ where: { id } });
    return row ? toRow(row) : null;
  }

  async findByHash(tokenHash: string): Promise<StaffRefreshTokenRow | null> {
    const row = await this.db.staffRefreshToken.findUnique({ where: { tokenHash } });
    return row ? toRow(row) : null;
  }

  async rotate(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
  ): Promise<StaffRefreshTokenRow | null> {
    return this.db.$transaction(async (tx) => {
      const { count } = await tx.staffRefreshToken.updateMany({
        where: {
          id: parentId,
          usedAt: null,
          supersededAt: null,
          revokedAt: null,
          expiresAt: { gt: at },
        },
        data: { usedAt: at },
      });

      // Lost the race, or the row stopped being exchangeable. The service
      // re-reads it and decides which.
      if (count !== 1) return null;

      return toRow(await tx.staffRefreshToken.create({ data: toData(child) }));
    }, EXCHANGE_TRANSACTION);
  }

  async retry(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
    maxRetries: number,
  ): Promise<RetryResult> {
    try {
      return await this.db.$transaction(async (tx) => {
        // (1) Claims one retry and takes the parent's row lock, which every
        // other retry or rotation of this parent now queues behind.
        const claimed = await tx.staffRefreshToken.updateMany({
          where: {
            id: parentId,
            revokedAt: null,
            usedAt: { not: null },
            retryCount: { lt: maxRetries },
          },
          data: { retryCount: { increment: 1 } },
        });
        if (claimed.count !== 1) throw new RetryRefused('blocked');

        // (2) A used child means the chain went on without this caller.
        const usedChild = { parentId, usedAt: { not: null } };
        if (await tx.staffRefreshToken.findFirst({ where: usedChild, select: { id: true } })) {
          throw new RetryRefused('descendant-used');
        }

        // (3) The children nobody used are the answers that never arrived.
        // Superseding them keeps them presentable — as a retry of this parent —
        // without ever being exchangeable in their own right.
        await tx.staffRefreshToken.updateMany({
          where: { parentId, usedAt: null, supersededAt: null, revokedAt: null },
          data: { supersededAt: at },
        });

        // (4) A child whose rotation held its row lock before (3) reached it
        // was skipped there, and shows up here as used.
        if (await tx.staffRefreshToken.findFirst({ where: usedChild, select: { id: true } })) {
          throw new RetryRefused('descendant-used');
        }

        // (5)
        const created = await tx.staffRefreshToken.create({ data: toData(child) });
        return { kind: 'minted' as const, child: toRow(created) };
      }, EXCHANGE_TRANSACTION);
    } catch (error) {
      if (error instanceof RetryRefused) return { kind: error.outcome };
      throw error;
    }
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    const { count } = await this.db.staffRefreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: at },
    });
    return count;
  }

  async deleteExpired(before: Date): Promise<number> {
    // Every row of a family carries the same `expiresAt`, so this removes
    // families whole — never a root while its children remain.
    const { count } = await this.db.staffRefreshToken.deleteMany({
      where: { expiresAt: { lt: before } },
    });
    return count;
  }
}

function toData(input: NewStaffRefreshToken) {
  return {
    ...(input.id ? { id: input.id } : {}),
    userId: input.userId,
    familyId: input.familyId,
    parentId: input.parentId,
    tokenHash: input.tokenHash,
    tokenVersion: input.tokenVersion,
    persistent: input.persistent,
    expiresAt: input.expiresAt,
  };
}

function toRow(row: StaffRefreshToken): StaffRefreshTokenRow {
  return {
    id: row.id,
    userId: row.userId,
    familyId: row.familyId,
    parentId: row.parentId,
    tokenHash: row.tokenHash,
    tokenVersion: row.tokenVersion,
    persistent: row.persistent,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    usedAt: row.usedAt,
    supersededAt: row.supersededAt,
    retryCount: row.retryCount,
    revokedAt: row.revokedAt,
  };
}
