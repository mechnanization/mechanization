import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { STAFF_REFRESH_TOKEN_REPOSITORY } from '../../../domain/interfaces/base-repository.interface';
import {
  NewStaffRefreshToken,
  StaffRefreshTokenRepository,
  StaffRefreshTokenRow,
} from '../../../domain/interfaces/staff-refresh-token-repository.interface';
import { SessionRevocationService } from './session-revocation.service';

/**
 * The label the refresh key is derived under — see `refreshKey`. Bump the
 * suffix to void every outstanding refresh token and rename every cookie.
 */
const REFRESH_KEY_LABEL = 'staff-refresh.v1';

/**
 * How many times one token may be exchanged again after its first exchange.
 *
 * A retry exists for the refresh whose response never arrived — a dropped
 * connection, a tab closed mid-request, two tabs racing for the same cookie.
 * Each of those costs one retry, and a clerk on a bad connection might lose two
 * in a row. Past three, what is presenting the token is no longer a client
 * recovering from a lost answer, and the family is ended as a reuse.
 */
const MAX_RETRIES_PER_TOKEN = 3;

const COOKIE_PREFIX = 'mz_sr_';

/**
 * What a token we minted looks like: 32 random bytes, base64url. The bounds are
 * loose on purpose (the cookie reader shares them); what matters is that a
 * value which cannot be ours is refused before it costs a hash and a query.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refresh token as it leaves the service: headed for a cookie, and nowhere else. */
export interface IssuedRefreshToken {
  token: string;
  cookieName: string;
  familyId: string;
  persistent: boolean;
  expiresAt: Date;
}

export type ExchangeResult =
  | { outcome: 'rotated' | 'retried'; next: IssuedRefreshToken }
  /** The chain had moved past this token, or its retries ran out: the family is revoked. */
  | { outcome: 'reused'; revoked: number }
  /** The family was revoked or expired meanwhile, or the row cannot be exchanged. */
  | { outcome: 'ended' };

/**
 * Staff refresh tokens: opaque, rotating, stored only as a keyed hash.
 *
 * Every exchange consumes the presented token and hands back its successor, so
 * a token is good for one exchange. The hard part is telling a thief from a
 * client whose last answer was lost, because both present a token that has
 * already been used. The rule this class enforces:
 *
 * **A token can be exchanged again only while nothing it produced has been
 * used, at most three times; presenting a token after the chain has moved past
 * it ends the family.**
 *
 * A lost response leaves an unused child behind — the client never received
 * it — so the parent may be retried, and the retry supersedes that child. A
 * thief replaying a token its owner has since refreshed finds a used child and
 * ends the family, signing both of them out; the owner signs in again, the
 * thief cannot.
 *
 * The honest gap: someone who presents a stolen token **before** its owner
 * does wins that exchange. They hold a session for one access-token lifetime
 * (at most `JWT_STAFF_IDLE_TTL`) plus at most three retries, until the owner's
 * next refresh finds the chain moved on and the family is revoked.
 */
@Injectable()
export class StaffRefreshTokenService {
  private readonly logger = new Logger(StaffRefreshTokenService.name);

  constructor(
    @Inject(STAFF_REFRESH_TOKEN_REPOSITORY)
    private readonly repository: StaffRefreshTokenRepository,
    private readonly config: ConfigService,
    private readonly revocation: SessionRevocationService,
  ) {}

  /**
   * HMAC(JWT_SECRET, label) — the same derivation as the password-reset key.
   *
   * Derived rather than configured, so there is no second secret to
   * distribute, and so rotating `JWT_SECRET` voids every refresh token and
   * renames every cookie along with every access token. A keyed hash rather
   * than a bare SHA-256 so that a copy of the table — a backup, a dump — is not
   * a list of values to test offline against a leaked cookie jar.
   */
  private refreshKey(): Buffer {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_SECRET'))
      .update(REFRESH_KEY_LABEL)
      .digest();
  }

  private hash(token: string): string {
    return createHmac('sha256', this.refreshKey()).update(token).digest('hex');
  }

  /**
   * The cookie this account's refresh token travels in.
   *
   * One name per account, so two staff accounts signed in in one browser never
   * overwrite each other's cookie, and a late logout response for one can
   * never clear the other's. Keyed, so nobody without the secret can compute
   * the name another account's cookie will carry — which is what planting a
   * cookie under it for that account would need.
   */
  cookieNameFor(userId: string): string {
    const digest = createHmac('sha256', this.refreshKey()).update(`cookie:${userId}`).digest('hex');
    return `${COOKIE_PREFIX}${digest.slice(0, 24)}`;
  }

  /** Starts a family: the root row, whose id is the family's id and the access token's `sid`. */
  async issueFamily(input: {
    userId: string;
    tokenVersion: number;
    persistent: boolean;
    expiresAt: Date;
  }): Promise<IssuedRefreshToken> {
    const familyId = randomUUID();
    const token = mintToken();

    await this.repository.create({
      id: familyId,
      userId: input.userId,
      familyId,
      parentId: null,
      tokenHash: this.hash(token),
      tokenVersion: input.tokenVersion,
      persistent: input.persistent,
      expiresAt: input.expiresAt,
    });

    return {
      token,
      cookieName: this.cookieNameFor(input.userId),
      familyId,
      persistent: input.persistent,
      expiresAt: input.expiresAt,
    };
  }

  /** The row a presented token names, or null — a malformed token included. */
  async find(token: string): Promise<StaffRefreshTokenRow | null> {
    if (!TOKEN_SHAPE.test(token)) return null;
    return this.repository.findByHash(this.hash(token));
  }

  /** The family's root, whose `revokedAt` and `expiresAt` speak for the whole family. */
  async familyRoot(familyId: string): Promise<StaffRefreshTokenRow | null> {
    if (!UUID_SHAPE.test(familyId)) return null;
    const root = await this.repository.findById(familyId);
    return root && root.familyId === familyId ? root : null;
  }

  /**
   * Exchanges a presented token for its successor, or decides it is a reuse.
   *
   * The caller has already checked the account and the family's root. This
   * decides only what the token's place in its chain allows, re-reading the
   * row between passes because a concurrent request may have moved it on.
   */
  async exchange(presented: StaffRefreshTokenRow, now = new Date()): Promise<ExchangeResult> {
    let row: StaffRefreshTokenRow | null = presented;

    for (let pass = 0; pass < 3 && row; pass++) {
      /*
        Superseded: a retry of this token's parent replaced it before it was
        ever used — its response was lost, or a racing request won. Presenting
        it is that same client asking again, so it is served as another retry
        of the parent rather than refused.
      */
      if (row.supersededAt) {
        const parent = row.parentId ? await this.repository.findById(row.parentId) : null;
        if (!parent) return { outcome: 'ended' };
        return this.retryFrom(parent, now);
      }

      if (row.usedAt === null) {
        const next = this.successorOf(row);
        if (await this.repository.rotate(row.id, next.row, now)) {
          return { outcome: 'rotated', next: this.issued(next.token, row) };
        }

        // Lost the compare-and-set. Whatever beat us has changed the row;
        // read it again and take the branch it now belongs in.
        row = await this.repository.findById(row.id);
        if (!row || row.revokedAt || row.expiresAt <= now) return { outcome: 'ended' };
        continue;
      }

      return this.retryFrom(row, now);
    }

    return { outcome: 'ended' };
  }

  /** Ends a family. Drops the cached liveness so the family's access tokens stop here, not 30s later. */
  async revokeFamily(familyId: string, now = new Date()): Promise<number> {
    const revoked = await this.repository.revokeFamily(familyId, now);
    await this.revocation.forgetFamily(familyId);
    return revoked;
  }

  /** Exchanges an already-used token again — see the class comment for when that is allowed. */
  private async retryFrom(parent: StaffRefreshTokenRow, now: Date): Promise<ExchangeResult> {
    const next = this.successorOf(parent);
    const result = await this.repository.retry(parent.id, next.row, now, MAX_RETRIES_PER_TOKEN);

    if (result.kind === 'minted') {
      // Expected now and then — a lost response is ordinary on a municipal
      // connection. A run of these for one account is worth a look. Never the
      // token, which would make the log a place to steal a session from.
      this.logger.warn(
        `Refresh retried: user ${parent.userId}, family ${parent.familyId}, parent ${parent.id}`,
      );
      return { outcome: 'retried', next: this.issued(next.token, parent) };
    }

    if (result.kind === 'descendant-used') {
      return this.reuse(parent, now);
    }

    // Blocked: the parent was revoked (the family ended meanwhile), or its
    // retries are spent. Only the second is a reuse.
    const fresh = await this.repository.findById(parent.id);
    if (!fresh || fresh.revokedAt) return { outcome: 'ended' };
    if (fresh.retryCount >= MAX_RETRIES_PER_TOKEN) return this.reuse(parent, now);
    return { outcome: 'ended' };
  }

  private async reuse(row: StaffRefreshTokenRow, now: Date): Promise<ExchangeResult> {
    const revoked = await this.revokeFamily(row.familyId, now);
    this.logger.warn(
      `Refresh token reuse: user ${row.userId}, family ${row.familyId} ended (${revoked} row(s) revoked)`,
    );
    return { outcome: 'reused', revoked };
  }

  /**
   * The next token in `row`'s chain. Everything but the hash and the parent is
   * inherited — above all `expiresAt`, which is what keeps the session cap
   * from moving however many times the family is exchanged.
   */
  private successorOf(row: StaffRefreshTokenRow): { token: string; row: NewStaffRefreshToken } {
    const token = mintToken();
    return {
      token,
      row: {
        userId: row.userId,
        familyId: row.familyId,
        parentId: row.id,
        tokenHash: this.hash(token),
        tokenVersion: row.tokenVersion,
        persistent: row.persistent,
        expiresAt: row.expiresAt,
      },
    };
  }

  private issued(token: string, row: StaffRefreshTokenRow): IssuedRefreshToken {
    return {
      token,
      cookieName: this.cookieNameFor(row.userId),
      familyId: row.familyId,
      persistent: row.persistent,
      expiresAt: row.expiresAt,
    };
  }
}

/** 256 bits: guessing one is not a threat model, so no throttle has to be one. */
function mintToken(): string {
  return randomBytes(32).toString('base64url');
}
