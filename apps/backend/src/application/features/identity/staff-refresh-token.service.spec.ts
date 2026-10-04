import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  NewStaffRefreshToken,
  RetryResult,
  StaffRefreshTokenRepository,
  StaffRefreshTokenRow,
} from '../../../domain/interfaces/staff-refresh-token-repository.interface';
import { SessionRevocationService } from './session-revocation.service';
import { ExchangeResult, IssuedRefreshToken, StaffRefreshTokenService } from './staff-refresh-token.service';

/**
 * The rotation rules, over an in-memory port.
 *
 * What is under test is the service's reading of each outcome the port can
 * report — rotated, lost the compare-and-set, retried, refused — so the port
 * here has to report them for the same reasons Postgres would. It keeps the
 * contract written on `StaffRefreshTokenRepository`: each method is one atomic
 * step (nothing else runs between its reads and its writes, which is what the
 * row lock buys the real one), `rotate` and `retry` change a row only when its
 * compare-and-set holds, and a refused `retry` leaves the store exactly as it
 * found it. The real repository's behaviour under genuinely concurrent
 * transactions is pinned against Postgres in
 * `staff-refresh-token.repository.integration.spec.ts`.
 *
 * Races are staged by the order of calls: a request that read its row before
 * another request changed it is a call made with the older snapshot.
 */
class InMemoryStaffRefreshTokens implements StaffRefreshTokenRepository {
  private rows = new Map<string, StaffRefreshTokenRow>();

  async create(input: NewStaffRefreshToken): Promise<StaffRefreshTokenRow> {
    return { ...this.insert(this.rows, input) };
  }

  async findById(id: string): Promise<StaffRefreshTokenRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByHash(tokenHash: string): Promise<StaffRefreshTokenRow | null> {
    const row = [...this.rows.values()].find((candidate) => candidate.tokenHash === tokenHash);
    return row ? { ...row } : null;
  }

  async rotate(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
  ): Promise<StaffRefreshTokenRow | null> {
    const parent = this.rows.get(parentId);
    const exchangeable =
      parent !== undefined &&
      parent.usedAt === null &&
      parent.supersededAt === null &&
      parent.revokedAt === null &&
      parent.expiresAt > at;
    if (!exchangeable) return null;

    parent.usedAt = at;
    return { ...this.insert(this.rows, child) };
  }

  async retry(
    parentId: string,
    child: NewStaffRefreshToken,
    at: Date,
    maxRetries: number,
  ): Promise<RetryResult> {
    // Every step runs against a copy that replaces the store only on success:
    // the rollback a refused retry gets from its transaction.
    const staged = new Map([...this.rows].map(([id, row]) => [id, { ...row }]));

    const parent = staged.get(parentId);
    if (
      !parent ||
      parent.revokedAt !== null ||
      parent.usedAt === null ||
      parent.retryCount >= maxRetries
    ) {
      return { kind: 'blocked' };
    }
    parent.retryCount += 1;

    const children = [...staged.values()].filter((row) => row.parentId === parentId);
    if (children.some((row) => row.usedAt !== null)) return { kind: 'descendant-used' };

    for (const row of children) {
      if (row.usedAt === null && row.supersededAt === null && row.revokedAt === null) {
        row.supersededAt = at;
      }
    }

    const minted = this.insert(staged, child);
    this.rows = staged;
    return { kind: 'minted', child: { ...minted } };
  }

  async revokeFamily(familyId: string, at: Date): Promise<number> {
    let revoked = 0;
    for (const row of this.rows.values()) {
      if (row.familyId === familyId && row.revokedAt === null) {
        row.revokedAt = at;
        revoked += 1;
      }
    }
    return revoked;
  }

  async deleteExpired(before: Date): Promise<number> {
    let deleted = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt < before) {
        this.rows.delete(id);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Everything stored, copied — for asserting what a call did or did not write. */
  snapshot(): StaffRefreshTokenRow[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }

  family(familyId: string): StaffRefreshTokenRow[] {
    return this.snapshot().filter((row) => row.familyId === familyId);
  }

  childrenOf(parentId: string): StaffRefreshTokenRow[] {
    return this.snapshot().filter((row) => row.parentId === parentId);
  }

  /** Removes one row outright, to stage a chain whose parent is gone. */
  drop(id: string): void {
    this.rows.delete(id);
  }

  private insert(
    into: Map<string, StaffRefreshTokenRow>,
    input: NewStaffRefreshToken,
  ): StaffRefreshTokenRow {
    // The unique index on "tokenHash".
    if ([...into.values()].some((row) => row.tokenHash === input.tokenHash)) {
      throw new Error('Unique constraint failed on the fields: (`tokenHash`)');
    }

    const row: StaffRefreshTokenRow = {
      id: input.id ?? randomUUID(),
      userId: input.userId,
      familyId: input.familyId,
      parentId: input.parentId,
      tokenHash: input.tokenHash,
      tokenVersion: input.tokenVersion,
      persistent: input.persistent,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
      usedAt: null,
      supersededAt: null,
      retryCount: 0,
      revokedAt: null,
    };
    into.set(row.id, row);
    return row;
  }
}

const SECRET = 'test-secret-at-least-32-characters-long-xx';
const OTHER_SECRET = 'another-secret-also-32-characters-long-yy';

/** Every clock in this file is explicit. Nothing here depends on when it runs. */
const T0 = new Date('2026-09-26T08:00:00.000Z');
const CAP = new Date('2026-09-26T16:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function configWith(secret: string): ConfigService {
  return {
    getOrThrow: jest.fn((name: string) => {
      if (name === 'JWT_SECRET') return secret;
      throw new Error(`unexpected config read: ${name}`);
    }),
  } as unknown as ConfigService;
}

function build(options: { secret?: string; repository?: InMemoryStaffRefreshTokens } = {}) {
  const repository = options.repository ?? new InMemoryStaffRefreshTokens();
  const liveness = { forgetFamily: jest.fn().mockResolvedValue(undefined) };
  const service = new StaffRefreshTokenService(
    repository,
    configWith(options.secret ?? SECRET),
    liveness as unknown as SessionRevocationService,
  );
  return { service, repository, liveness };
}

async function issue(service: StaffRefreshTokenService, overrides: { persistent?: boolean } = {}) {
  return service.issueFamily({
    userId: 'staff-1',
    tokenVersion: 2,
    persistent: overrides.persistent ?? false,
    expiresAt: CAP,
  });
}

/** The row a token names, which a test needs as the "presented" snapshot. */
async function rowOf(service: StaffRefreshTokenService, token: string): Promise<StaffRefreshTokenRow> {
  const row = await service.find(token);
  if (!row) throw new Error('expected the token to resolve to a row');
  return row;
}

/** Narrows an exchange to its successful branch, failing the test otherwise. */
function nextOf(result: ExchangeResult): IssuedRefreshToken {
  if (result.outcome !== 'rotated' && result.outcome !== 'retried') {
    throw new Error(`expected a successor, got '${result.outcome}'`);
  }
  return result.next;
}

let warnings: string[];

beforeEach(() => {
  warnings = [];
  jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(() => jest.restoreAllMocks());

describe('StaffRefreshTokenService — the token, its hash and its cookie', () => {
  it('stores a keyed hash, never the token and never a bare digest of it', async () => {
    // A bare SHA-256 would let a copy of the table be tested offline against
    // a leaked cookie jar. Keyed off JWT_SECRET, a dump alone proves nothing.
    const { service, repository } = build();
    const issued = await issue(service);

    const [root] = repository.snapshot();
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(root.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(root.tokenHash).not.toContain(issued.token);
    expect(root.tokenHash).not.toBe(createHash('sha256').update(issued.token).digest('hex'));
  });

  it('finds a token under the secret it was minted with, and under no other', async () => {
    // Rotating JWT_SECRET has always ended every staff session; the refresh
    // tokens must end with them rather than survive as a way back in.
    const repository = new InMemoryStaffRefreshTokens();
    const minted = build({ repository });
    const rotated = build({ repository, secret: OTHER_SECRET });

    const issued = await issue(minted.service);

    await expect(minted.service.find(issued.token)).resolves.toMatchObject({
      familyId: issued.familyId,
    });
    await expect(rotated.service.find(issued.token)).resolves.toBeNull();
  });

  it('refuses a malformed token before it costs a hash and a query', async () => {
    const { service, repository } = build();
    const findByHash = jest.spyOn(repository, 'findByHash');

    for (const malformed of ['', 'short', 'has spaces in it and is long', 'x'.repeat(201), 'a=b'.repeat(10)]) {
      await expect(service.find(malformed)).resolves.toBeNull();
    }
    expect(findByHash).not.toHaveBeenCalled();
  });

  it('names one cookie per account, stable, and keyed off the secret', () => {
    const { service } = build();
    const { service: rotated } = build({ secret: OTHER_SECRET });

    const name = service.cookieNameFor('staff-1');

    expect(name).toMatch(/^mz_sr_[0-9a-f]{24}$/);
    expect(service.cookieNameFor('staff-1')).toBe(name);
    // Two accounts in one browser never share, or overwrite, a cookie.
    expect(service.cookieNameFor('staff-2')).not.toBe(name);
    // Nobody without the secret can compute the name to plant a cookie under.
    expect(rotated.cookieNameFor('staff-1')).not.toBe(name);
  });
});

describe('StaffRefreshTokenService — a family', () => {
  it('is rooted at a row whose id is the family id', async () => {
    const { service, repository } = build();
    const issued = await issue(service, { persistent: true });

    const [root] = repository.snapshot();
    expect(root).toMatchObject({
      id: issued.familyId,
      familyId: issued.familyId,
      parentId: null,
      userId: 'staff-1',
      tokenVersion: 2,
      persistent: true,
      expiresAt: CAP,
      usedAt: null,
      retryCount: 0,
      revokedAt: null,
    });
    expect(issued).toMatchObject({
      cookieName: service.cookieNameFor('staff-1'),
      persistent: true,
      expiresAt: CAP,
    });
  });

  it('hands out a different token and family on every sign-in', async () => {
    const { service } = build();
    const first = await issue(service);
    const second = await issue(service);

    expect(second.token).not.toBe(first.token);
    expect(second.familyId).not.toBe(first.familyId);
  });

  it('finds the root by the family id, and nothing by any other id', async () => {
    const { service } = build();
    const issued = await issue(service);
    const child = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    const childRow = await rowOf(service, child.token);

    await expect(service.familyRoot(issued.familyId)).resolves.toMatchObject({ id: issued.familyId });
    // A child's id is a row in the family but not the family: it must not be
    // mistaken for the root whose `revokedAt` speaks for everyone.
    await expect(service.familyRoot(childRow.id)).resolves.toBeNull();
    await expect(service.familyRoot(randomUUID())).resolves.toBeNull();
  });

  it('answers a malformed family id with null, without querying', async () => {
    // A `sid` is read out of a token; a non-UUID reaching a uuid column is a
    // 500, not a refusal.
    const { service, repository } = build();
    const findById = jest.spyOn(repository, 'findById');

    await expect(service.familyRoot('not-a-uuid')).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
  });

  it('revokes every row and drops the cached liveness with it', async () => {
    const { service, repository, liveness } = build();
    const issued = await issue(service);
    await service.exchange(await rowOf(service, issued.token), at(30));

    await expect(service.revokeFamily(issued.familyId, at(40))).resolves.toBe(2);

    expect(repository.family(issued.familyId).every((row) => row.revokedAt !== null)).toBe(true);
    expect(liveness.forgetFamily).toHaveBeenCalledWith(issued.familyId);
  });
});

describe('StaffRefreshTokenService — exchange: rotation', () => {
  it('rotates an unused token into a child that inherits everything but its hash', async () => {
    const { service, repository } = build();
    const issued = await issue(service, { persistent: true });

    const result = await service.exchange(await rowOf(service, issued.token), at(30));

    expect(result.outcome).toBe('rotated');
    const next = nextOf(result);
    const [root] = repository.family(issued.familyId).filter((row) => row.parentId === null);
    const [child] = repository.childrenOf(issued.familyId);

    expect(next.token).not.toBe(issued.token);
    expect(root.usedAt).toEqual(at(30));
    expect(child).toMatchObject({
      parentId: root.id,
      familyId: issued.familyId,
      userId: 'staff-1',
      tokenVersion: 2,
      persistent: true,
      // The cap: inherited, never recomputed, so rotating never lengthens a session.
      expiresAt: CAP,
    });
    expect(next).toMatchObject({
      familyId: issued.familyId,
      cookieName: issued.cookieName,
      persistent: true,
      expiresAt: CAP,
    });
    await expect(rowOf(service, next.token)).resolves.toMatchObject({ id: child.id });
  });

  it('keeps the cap through a long chain of rotations', async () => {
    const { service, repository } = build();
    const issued = await issue(service);

    let token = issued.token;
    for (let minute = 30; minute <= 450; minute += 30) {
      token = nextOf(await service.exchange(await rowOf(service, token), at(minute))).token;
    }

    const family = repository.family(issued.familyId);
    expect(family).toHaveLength(16);
    expect(family.every((row) => row.expiresAt.getTime() === CAP.getTime())).toBe(true);
  });

  it('ends a family whose cap has passed rather than rotating it', async () => {
    const { service, repository } = build();
    const issued = await issue(service);
    const before = repository.snapshot();

    const late = new Date(CAP.getTime() + 1_000);
    await expect(service.exchange(await rowOf(service, issued.token), late)).resolves.toEqual({
      outcome: 'ended',
    });
    expect(repository.snapshot()).toEqual(before);
  });

  it('ends, not rotates, when the family was revoked after the row was read', async () => {
    // A logout landing between the refresh's read and its exchange: the
    // compare-and-set loses, and the re-read finds the family over.
    const { service, repository } = build();
    const issued = await issue(service);
    const stale = await rowOf(service, issued.token);

    await service.revokeFamily(issued.familyId, at(29));

    await expect(service.exchange(stale, at(30))).resolves.toEqual({ outcome: 'ended' });
    expect(repository.family(issued.familyId)).toHaveLength(1);
  });
});

describe('StaffRefreshTokenService — exchange: a lost response is not a theft', () => {
  it('serves a used token again when nothing it produced was used, superseding that child', async () => {
    /*
      The response carrying the child never arrived — a dropped connection, a
      tab closed mid-request. The client still holds the parent and presents
      it again. That must work, and must not be recorded as a reuse.
    */
    const { service, repository } = build();
    const issued = await issue(service);
    const lost = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));

    const result = await service.exchange(await rowOf(service, issued.token), at(31));

    expect(result.outcome).toBe('retried');
    const next = nextOf(result);
    expect(next.token).not.toBe(lost.token);

    const lostRow = await rowOf(service, lost.token);
    const root = await service.familyRoot(issued.familyId);
    expect(lostRow.supersededAt).toEqual(at(31));
    expect(root).toMatchObject({ retryCount: 1, revokedAt: null });
    expect(repository.family(issued.familyId).every((row) => row.revokedAt === null)).toBe(true);
  });

  it('serves a superseded token as another retry of its parent', async () => {
    /*
      Two requests carrying the same cookie: the second one's retry
      superseded the child the first one received. When that first child is
      presented it is the same client asking again, so it is answered from the
      parent — not refused, and not a reuse.
    */
    const { service } = build();
    const issued = await issue(service);
    const first = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    const second = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));

    const result = await service.exchange(await rowOf(service, first.token), at(31));

    expect(result.outcome).toBe('retried');
    const third = nextOf(result);
    const thirdRow = await rowOf(service, third.token);
    const root = await service.familyRoot(issued.familyId);
    // Minted from the parent, as its third answer; the second is now the lost one.
    expect(thirdRow.parentId).toBe(issued.familyId);
    expect(root?.retryCount).toBe(2);
    await expect(rowOf(service, second.token)).resolves.toMatchObject({ supersededAt: at(31) });
  });

  it('treats two requests racing with one token as a retry, not a reuse', async () => {
    // Both read the unused row. The first rotates it; the second loses the
    // compare-and-set, re-reads, finds it used with nothing downstream used,
    // and is served as a retry.
    const { service, repository } = build();
    const issued = await issue(service);
    const snapshotA = await rowOf(service, issued.token);
    const snapshotB = await rowOf(service, issued.token);

    const a = await service.exchange(snapshotA, at(30));
    const b = await service.exchange(snapshotB, at(30));

    expect(a.outcome).toBe('rotated');
    expect(b.outcome).toBe('retried');
    expect(repository.family(issued.familyId).every((row) => row.revokedAt === null)).toBe(true);
  });

  it('logs a retry without the token', async () => {
    const { service } = build();
    const issued = await issue(service);
    const lost = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    const retried = nextOf(await service.exchange(await rowOf(service, issued.token), at(31)));

    expect(warnings.join('\n')).toContain(issued.familyId);
    for (const token of [issued.token, lost.token, retried.token]) {
      expect(warnings.join('\n')).not.toContain(token);
    }
  });
});

describe('StaffRefreshTokenService — exchange: presenting a token the chain has moved past', () => {
  it('ends the whole family when something the token produced was used', async () => {
    /*
      The thief's case, or the owner's after the thief went first: the parent
      is presented again after its child has itself been exchanged. There is
      no lost response that explains that, so the family ends — both parties
      are signed out, and only the owner can sign back in.
    */
    const { service, repository, liveness } = build();
    const issued = await issue(service);
    const child = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    nextOf(await service.exchange(await rowOf(service, child.token), at(60)));

    const result = await service.exchange(await rowOf(service, issued.token), at(61));

    expect(result).toEqual({ outcome: 'reused', revoked: 3 });
    expect(repository.family(issued.familyId).every((row) => row.revokedAt !== null)).toBe(true);
    expect(liveness.forgetFamily).toHaveBeenCalledWith(issued.familyId);
  });

  it('spends no retry allowance when it refuses', async () => {
    // The refused retry rolls back: the parent's count is as it was, and no
    // sibling was superseded on the way to the refusal.
    const { service } = build();
    const issued = await issue(service);
    const child = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    nextOf(await service.exchange(await rowOf(service, child.token), at(60)));

    await service.exchange(await rowOf(service, issued.token), at(61));

    const root = await service.familyRoot(issued.familyId);
    expect(root?.retryCount).toBe(0);
    await expect(rowOf(service, child.token)).resolves.toMatchObject({ supersededAt: null });
  });

  it('allows three retries of one token, and ends the family at the fourth', async () => {
    const { service, repository } = build();
    const issued = await issue(service);
    await service.exchange(await rowOf(service, issued.token), at(30));

    for (const minute of [31, 32, 33]) {
      const retried = await service.exchange(await rowOf(service, issued.token), at(minute));
      expect(retried.outcome).toBe('retried');
    }

    const fourth = await service.exchange(await rowOf(service, issued.token), at(34));

    // Root + the first child + three retried children.
    expect(fourth).toEqual({ outcome: 'reused', revoked: 5 });
    expect(repository.family(issued.familyId).every((row) => row.revokedAt !== null)).toBe(true);
  });

  it('logs a reuse without the token', async () => {
    const { service } = build();
    const issued = await issue(service);
    const child = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    nextOf(await service.exchange(await rowOf(service, child.token), at(60)));

    await service.exchange(await rowOf(service, issued.token), at(61));

    expect(warnings.some((line) => /reuse/i.test(line) && line.includes(issued.familyId))).toBe(true);
    expect(warnings.join('\n')).not.toContain(issued.token);
    expect(warnings.join('\n')).not.toContain(child.token);
  });
});

describe('StaffRefreshTokenService — exchange: a family already over', () => {
  it('ends, and revokes nothing more, when the used token’s family was revoked', async () => {
    // Not a reuse: nobody moved the chain on. The family ended — a logout, a
    // refusal — and a token from it is simply over. Reporting it as a reuse
    // would write a false alarm to the audit trail.
    const { service, liveness } = build();
    const issued = await issue(service);
    await service.exchange(await rowOf(service, issued.token), at(30));
    await service.revokeFamily(issued.familyId, at(31));
    liveness.forgetFamily.mockClear();

    await expect(service.exchange(await rowOf(service, issued.token), at(32))).resolves.toEqual({
      outcome: 'ended',
    });
    expect(liveness.forgetFamily).not.toHaveBeenCalled();
  });

  it('ends a superseded token whose parent is gone', async () => {
    const { service, repository } = build();
    const issued = await issue(service);
    const lost = nextOf(await service.exchange(await rowOf(service, issued.token), at(30)));
    await service.exchange(await rowOf(service, issued.token), at(31));
    const orphan = await rowOf(service, lost.token);

    repository.drop(issued.familyId);

    await expect(service.exchange(orphan, at(32))).resolves.toEqual({ outcome: 'ended' });
  });

  it('ends, never accuses, when a refused retry has no reuse to explain it', async () => {
    /*
      A chain that cannot arise from this service's own writes — a superseded
      row whose parent was never used. The retry is refused, the parent is
      neither revoked nor out of retries, and the only honest answer is
      "ended": a reuse here would sign someone out and audit them for nothing.
    */
    const { service, repository } = build();
    const issued = await issue(service);
    const root = await rowOf(service, issued.token);
    const inconsistent: StaffRefreshTokenRow = {
      ...root,
      id: randomUUID(),
      parentId: root.id,
      tokenHash: 'f'.repeat(64),
      supersededAt: at(10),
    };

    await expect(service.exchange(inconsistent, at(11))).resolves.toEqual({ outcome: 'ended' });
    expect(repository.family(issued.familyId).every((row) => row.revokedAt === null)).toBe(true);
  });
});
