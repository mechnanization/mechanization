import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import {
  NewStaffRefreshToken,
  RetryResult,
  StaffRefreshTokenRow,
} from '../../domain/interfaces/staff-refresh-token-repository.interface';
import { TenantContextService } from '../context/tenant-context.service';
import { migrateTenantSchema } from '../prisma/tenant-migrator';
import { tenantTestClient } from '../prisma/tenant-test-client';
import { PrismaStaffRefreshTokenRepository } from './staff-refresh-token.repository';

/**
 * The refresh-token repository against a real Postgres.
 *
 * Everything the rotation rules rest on is a claim about the database: that
 * two requests presenting one token cannot both exchange it, that a refused
 * retry leaves nothing behind, that retries of one parent queue on its row
 * lock, and that a rotation racing a retry of its parent loses or wins
 * cleanly — never both, never neither. The service's spec proves what it does
 * with each answer over an in-memory port; this proves Postgres gives those
 * answers, at READ COMMITTED, through Prisma's interactive transactions.
 *
 * The concurrency tests fire their calls together and assert what must hold
 * whichever of them the database serves first, so they do not depend on an
 * interleaving and cannot flake on one.
 *
 * Set `TEST_DATABASE_URL` to run it — a throwaway Postgres 17 container, never
 * the local development database and never staging: the suite drops and
 * rebuilds its own schema.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_staff_refresh_spec';

const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

/** Explicit clocks. `rotate` and `retry` compare against the `at` they are given. */
const AT = new Date('2026-09-26T08:00:00.000Z');
const CAP = new Date('2099-01-01T00:00:00.000Z');
const minutesAfter = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

describeIfDb('PrismaStaffRefreshTokenRepository', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let repository: PrismaStaffRefreshTokenRepository;
  let officerId: string;

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-refresh', tenantSlug: 'refresh', schemaName: SCHEMA, prisma: db },
      work,
    );

  const createStaff = async (): Promise<string> => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'STAFF',
        tenantSlug: 'refresh',
        email: `staff-${id}@refresh.gov.lb`,
        firstName: 'موظف',
        lastName: 'البلدية',
        role: 'ADMINISTRATIVE_OFFICER',
      },
    });
    return id;
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    repository = new PrismaStaffRefreshTokenRepository(context);
    officerId = await createStaff();
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ─────────────────────────────  Fixtures  ─────────────────────────────

  const hash = () => randomBytes(32).toString('hex');

  const startFamily = (options: { userId?: string; expiresAt?: Date } = {}) => {
    const familyId = randomUUID();
    return within(() =>
      repository.create({
        id: familyId,
        userId: options.userId ?? officerId,
        familyId,
        parentId: null,
        tokenHash: hash(),
        tokenVersion: 0,
        persistent: false,
        expiresAt: options.expiresAt ?? CAP,
      }),
    );
  };

  const childOf = (parent: StaffRefreshTokenRow): NewStaffRefreshToken => ({
    userId: parent.userId,
    familyId: parent.familyId,
    parentId: parent.id,
    tokenHash: hash(),
    tokenVersion: parent.tokenVersion,
    persistent: parent.persistent,
    expiresAt: parent.expiresAt,
  });

  const rotate = (parent: StaffRefreshTokenRow, at = AT) =>
    within(() => repository.rotate(parent.id, childOf(parent), at));

  const retry = (parent: StaffRefreshTokenRow, at = AT, max = 3) =>
    within(() => repository.retry(parent.id, childOf(parent), at, max));

  const reload = async (row: StaffRefreshTokenRow) => {
    const fresh = await within(() => repository.findById(row.id));
    if (!fresh) throw new Error(`row ${row.id} is gone`);
    return fresh;
  };

  const familyRows = (familyId: string) =>
    db.staffRefreshToken.findMany({ where: { familyId }, orderBy: { createdAt: 'asc' } });

  const childrenOf = (parentId: string) => db.staffRefreshToken.findMany({ where: { parentId } });

  /** A root that has been exchanged once, and the child that exchange produced. */
  const usedRoot = async () => {
    const root = await startFamily();
    const child = await rotate(root);
    if (!child) throw new Error('fixture: the first rotation must win');
    return { root: await reload(root), child };
  };

  // ─────────────────────────────  Storage  ─────────────────────────────

  it('stores a row and finds it by id and by hash', async () => {
    const root = await startFamily();

    await expect(within(() => repository.findById(root.id))).resolves.toEqual(root);
    await expect(within(() => repository.findByHash(root.tokenHash))).resolves.toEqual(root);
    await expect(within(() => repository.findByHash(hash()))).resolves.toBeNull();
    expect(root).toMatchObject({ usedAt: null, supersededAt: null, retryCount: 0, revokedAt: null });
  });

  it('holds a hash to one row', async () => {
    // A presented token must resolve to exactly one row or to none.
    const root = await startFamily();

    await expect(
      within(() => repository.create({ ...childOf(root), tokenHash: root.tokenHash })),
    ).rejects.toThrow(/Unique constraint/);
  });

  // ─────────────────────────────  rotate  ─────────────────────────────

  it('rotates once: marks the parent used and inserts the child', async () => {
    const root = await startFamily();

    const child = await rotate(root, minutesAfter(30));

    expect(child).toMatchObject({ parentId: root.id, familyId: root.familyId, expiresAt: CAP });
    await expect(reload(root)).resolves.toMatchObject({ usedAt: minutesAfter(30) });
    await expect(rotate(root, minutesAfter(31))).resolves.toBeNull();
    await expect(familyRows(root.familyId)).resolves.toHaveLength(2);
  });

  it('lets exactly one of five simultaneous exchanges of one token win', async () => {
    // The whole of the "used once" guarantee: the losers' conditional updates
    // queue on the row, re-read it committed, and match nothing.
    const root = await startFamily();

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => rotate(root)));

    expect(results.filter((child) => child !== null)).toHaveLength(1);
    await expect(familyRows(root.familyId)).resolves.toHaveLength(2);
  });

  it('refuses to rotate a revoked, a superseded or an expired token, and writes nothing', async () => {
    const revoked = await startFamily();
    await within(() => repository.revokeFamily(revoked.familyId, AT));

    const superseded = await startFamily();
    await db.staffRefreshToken.update({ where: { id: superseded.id }, data: { supersededAt: AT } });

    const expiring = await startFamily();
    const pastTheCap = new Date(CAP.getTime() + 1);

    await expect(rotate(revoked)).resolves.toBeNull();
    await expect(rotate(superseded)).resolves.toBeNull();
    await expect(rotate(expiring, pastTheCap)).resolves.toBeNull();

    for (const row of [revoked, superseded, expiring]) {
      await expect(childrenOf(row.id)).resolves.toEqual([]);
      await expect(reload(row)).resolves.toMatchObject({ usedAt: null });
    }
  });

  // ─────────────────────────────  retry  ─────────────────────────────

  it('refuses to retry a token that was never used', async () => {
    const root = await startFamily();

    await expect(retry(root)).resolves.toEqual({ kind: 'blocked' });
    await expect(reload(root)).resolves.toMatchObject({ retryCount: 0 });
  });

  it('retries a used token: supersedes its unused child and mints another', async () => {
    const { root, child: lost } = await usedRoot();

    const result = await retry(root, minutesAfter(1));

    expect(result.kind).toBe('minted');
    const minted = (result as Extract<RetryResult, { kind: 'minted' }>).child;
    expect(minted).toMatchObject({ parentId: root.id, familyId: root.familyId, expiresAt: CAP });
    await expect(reload(lost)).resolves.toMatchObject({ supersededAt: minutesAfter(1) });
    await expect(reload(root)).resolves.toMatchObject({ retryCount: 1 });
  });

  it('refuses a retry once the chain has moved on, and rolls every write back', async () => {
    /*
      Step 1 has already spent a retry by the time step 2 finds the used
      child. The refusal must undo it: a refused retry spends no allowance and
      supersedes nothing, or a thief's failed replays would use up the owner's
      margin for lost responses.
    */
    const { root, child } = await usedRoot();
    const grandchild = await rotate(child);
    expect(grandchild).not.toBeNull();

    await expect(retry(root, minutesAfter(1))).resolves.toEqual({ kind: 'descendant-used' });

    await expect(reload(root)).resolves.toMatchObject({ retryCount: 0 });
    await expect(reload(grandchild!)).resolves.toMatchObject({ supersededAt: null });
    await expect(familyRows(root.familyId)).resolves.toHaveLength(3);
  });

  it('stops retrying at the limit, and never retries a revoked parent', async () => {
    const { root } = await usedRoot();

    for (const minute of [1, 2, 3]) {
      await expect(retry(root, minutesAfter(minute))).resolves.toMatchObject({ kind: 'minted' });
    }
    await expect(retry(root, minutesAfter(4))).resolves.toEqual({ kind: 'blocked' });
    await expect(reload(root)).resolves.toMatchObject({ retryCount: 3 });

    const other = await usedRoot();
    await within(() => repository.revokeFamily(other.root.familyId, AT));
    await expect(retry(other.root)).resolves.toEqual({ kind: 'blocked' });
    await expect(reload(other.root)).resolves.toMatchObject({ retryCount: 0 });
  });

  it('serialises simultaneous retries of one parent on its row lock', async () => {
    // Five at once against an allowance of three: three are served, in turn,
    // each superseding the one before it; two find the allowance spent. Were
    // the lock not doing its job, more than three would mint, or several
    // children would be left live at once.
    const { root } = await usedRoot();

    const results = await Promise.all([1, 2, 3, 4, 5].map(() => retry(root)));

    const minted = results.filter((result) => result.kind === 'minted');
    expect(minted).toHaveLength(3);
    expect(results.filter((result) => result.kind === 'blocked')).toHaveLength(2);
    await expect(reload(root)).resolves.toMatchObject({ retryCount: 3 });

    const live = (await childrenOf(root.id)).filter(
      (row) => row.usedAt === null && row.supersededAt === null,
    );
    expect(live).toHaveLength(1);
    expect(minted.map((result) => (result as Extract<RetryResult, { kind: 'minted' }>).child.id)).toContain(
      live[0].id,
    );
  });

  // ───────────────────────  Row locks, held on purpose  ───────────────────────

  /**
   * Holds one row's lock from a transaction of its own, starts `contender`,
   * and commits only once Postgres reports the contender queued behind it.
   *
   * The racing tests above assert what holds in either order, but left to
   * itself the database almost always serves them the same way round. This
   * pins each order in turn: the write the holder makes is exactly the one
   * the competing repository call would have made, and the contender has to
   * re-read the row after the lock is released — which is the behaviour the
   * repository's class comment rests on.
   */
  async function whileRowLocked<T>(
    id: string,
    column: 'usedAt' | 'supersededAt',
    contender: () => Promise<T>,
  ): Promise<T> {
    const holder = new Client({ connectionString: TEST_DATABASE_URL });
    await holder.connect();
    let pending: Promise<T> | undefined;

    try {
      await holder.query('BEGIN');
      await holder.query(
        `UPDATE "${SCHEMA}"."staff_refresh_tokens" SET "${column}" = $2 WHERE "id" = $1`,
        // ISO rather than a Date: `pg` would send local time with an offset,
        // which a column without a time zone drops. Prisma writes UTC.
        [id, AT.toISOString()],
      );
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

      pending = contender();

      // Polled, not slept: each probe is a round trip, and the deadline only
      // turns a broken premise into a clear failure instead of a hang.
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await ddl.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))',
          [rows[0].pid],
        );
        if (waiting.rowCount) break;
        if (Date.now() > deadline) throw new Error('the contender never queued behind the lock');
      }

      await holder.query('COMMIT');
      return await pending;
    } catch (error) {
      await holder.query('ROLLBACK').catch(() => undefined);
      await pending?.catch(() => undefined);
      throw error;
    } finally {
      await holder.end();
    }
  }

  it('makes the second of two exchanges of one token wait for the first, then match nothing', async () => {
    const root = await startFamily();

    await expect(whileRowLocked(root.id, 'usedAt', () => rotate(root))).resolves.toBeNull();
    await expect(childrenOf(root.id)).resolves.toEqual([]);
  });

  it('makes a retry that meets a rotation of the child find it once it commits (step 4)', async () => {
    /*
      The retry's check for a used child (step 2) runs before the rotation
      commits and sees nothing; its supersede (step 3) then waits on the
      child's lock and, once released, skips the now-used child. Only the
      re-read in step 4 notices. Without it this retry would mint a token
      beside a chain that has already moved on.
    */
    const { root, child } = await usedRoot();

    await expect(whileRowLocked(child.id, 'usedAt', () => retry(root))).resolves.toEqual({
      kind: 'descendant-used',
    });

    await expect(reload(root)).resolves.toMatchObject({ retryCount: 0 });
    await expect(childrenOf(root.id)).resolves.toHaveLength(1);
    await expect(reload(child)).resolves.toMatchObject({ supersededAt: null });
  });

  it('makes a rotation that meets a retry superseding its token match nothing once it commits', async () => {
    const { child } = await usedRoot();

    await expect(whileRowLocked(child.id, 'supersededAt', () => rotate(child))).resolves.toBeNull();

    await expect(childrenOf(child.id)).resolves.toEqual([]);
    await expect(reload(child)).resolves.toMatchObject({ usedAt: null });
  });

  it('lets a rotation of a child and a retry of its parent never both win, nor both lose', async () => {
    /*
      The one cross-row race. Whichever reaches the child's row lock first
      decides it: a rotation that commits first leaves the retry finding a
      used child (a reuse); a retry that supersedes first leaves the
      rotation's compare-and-set matching nothing. Run repeatedly so both
      orders get their chance; the assertion holds for either.
    */
    for (let round = 0; round < 10; round++) {
      const { root, child } = await usedRoot();

      const [rotated, retried] = await Promise.all([rotate(child), retry(root)]);

      if (rotated) {
        expect(retried).toEqual({ kind: 'descendant-used' });
        await expect(reload(root)).resolves.toMatchObject({ retryCount: 0 });
      } else {
        expect(retried.kind).toBe('minted');
        await expect(reload(child)).resolves.toMatchObject({ usedAt: null });
        await expect(reload(root)).resolves.toMatchObject({ retryCount: 1 });
      }
    }
  });

  // ─────────────────────────────  Ending families  ─────────────────────────────

  it('revokes every row of a family once, root included, and counts only what it changed', async () => {
    const { root, child } = await usedRoot();
    await retry(root);
    const bystander = await startFamily();

    await expect(within(() => repository.revokeFamily(root.familyId, AT))).resolves.toBe(3);
    await expect(within(() => repository.revokeFamily(root.familyId, minutesAfter(1)))).resolves.toBe(0);

    const rows = await familyRows(root.familyId);
    expect(rows.every((row) => row.revokedAt?.getTime() === AT.getTime())).toBe(true);
    await expect(reload(child)).resolves.toMatchObject({ revokedAt: AT });
    await expect(reload(bystander)).resolves.toMatchObject({ revokedAt: null });
  });

  it('prunes whole families past their cap and nothing else', async () => {
    const lapsed = await startFamily({ expiresAt: new Date('2000-01-01T00:00:00.000Z') });
    await rotate(lapsed, new Date('1999-12-31T00:00:00.000Z'));
    const live = await startFamily();

    await expect(
      within(() => repository.deleteExpired(new Date('2026-01-01T00:00:00.000Z'))),
    ).resolves.toBe(2);

    await expect(familyRows(lapsed.familyId)).resolves.toEqual([]);
    await expect(familyRows(live.familyId)).resolves.toHaveLength(1);
  });

  it('goes with its account when the account is removed', async () => {
    // `StaffService.remove` hard-deletes and a restore replaces every user;
    // the sessions go with the account rather than blocking its removal.
    const leaverId = await createStaff();
    const { familyId } = await startFamily({ userId: leaverId });
    await startFamily({ userId: leaverId });

    await db.user.delete({ where: { id: leaverId } });

    await expect(db.staffRefreshToken.count({ where: { userId: leaverId } })).resolves.toBe(0);
    await expect(familyRows(familyId)).resolves.toEqual([]);
  });
});
