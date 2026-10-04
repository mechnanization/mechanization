/**
 * One row of `staff_refresh_tokens`: one opaque refresh token a staff session
 * has been handed. The token itself is never stored — `tokenHash` is a keyed
 * hash of it (see `StaffRefreshTokenService`).
 *
 * A **family** is one sign-in. Its first row is the root (`id = familyId`,
 * `parentId = null`), and every refresh adds a child whose `parentId` names the
 * row it replaced. All rows of a family share `userId`, `tokenVersion`,
 * `persistent` and `expiresAt`, and the root's `revokedAt` is the one that
 * decides whether the family is still alive.
 */
export interface StaffRefreshTokenRow {
  id: string;
  userId: string;
  familyId: string;
  parentId: string | null;
  tokenHash: string;
  tokenVersion: number;
  persistent: boolean;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
  supersededAt: Date | null;
  retryCount: number;
  revokedAt: Date | null;
}

export interface NewStaffRefreshToken {
  /** Given only for a root, whose id must equal its `familyId`. */
  id?: string;
  userId: string;
  familyId: string;
  parentId: string | null;
  tokenHash: string;
  tokenVersion: number;
  persistent: boolean;
  expiresAt: Date;
}

export type RetryResult =
  | { kind: 'minted'; child: StaffRefreshTokenRow }
  /** The chain has moved past the parent: something it produced was used. A reuse. */
  | { kind: 'descendant-used' }
  /** The parent is revoked, or has already served its allowance of retries. */
  | { kind: 'blocked' };

/**
 * Persistence for staff refresh tokens.
 *
 * `rotate` and `retry` are the two operations that decide who wins a race, so
 * each is one transaction whose first statement is a compare-and-set on the
 * row being exchanged. Two requests presenting the same token cannot both
 * succeed: the loser's conditional update matches nothing, and the service
 * decides what that means from the row as it stands afterwards.
 */
export interface StaffRefreshTokenRepository {
  create(input: NewStaffRefreshToken): Promise<StaffRefreshTokenRow>;
  findById(id: string): Promise<StaffRefreshTokenRow | null>;
  findByHash(tokenHash: string): Promise<StaffRefreshTokenRow | null>;

  /**
   * ONE transaction: CAS `usedAt := at` WHERE id AND usedAt IS NULL AND
   * supersededAt IS NULL AND revokedAt IS NULL AND expiresAt > at; if exactly
   * one row changed, insert `child`. Returns the child, or null if the CAS lost.
   */
  rotate(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
  ): Promise<StaffRefreshTokenRow | null>;

  /**
   * ONE transaction, serialised on the parent's row lock:
   *
   * 1. CAS `retryCount := retryCount + 1` WHERE id = parentId AND revokedAt IS
   *    NULL AND usedAt IS NOT NULL AND retryCount < maxRetries. No row → `blocked`.
   * 2. Any child of the parent with `usedAt` set → `descendant-used`.
   * 3. `supersededAt := at` on every child that is unused, unsuperseded and
   *    unrevoked.
   * 4. Re-read the children; one now used (a concurrent rotation of a child
   *    committed first) → `descendant-used`.
   * 5. Insert `child` → `minted`.
   *
   * `descendant-used` and `blocked` roll the whole transaction back, so a
   * refused retry spends no allowance and supersedes nothing.
   */
  retry(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
    maxRetries: number,
  ): Promise<RetryResult>;

  /** `revokedAt := at` on every row of the family not already revoked, root included. Returns rows changed. */
  revokeFamily(familyId: string, at: Date): Promise<number>;

  deleteExpired(before: Date): Promise<number>;
}
