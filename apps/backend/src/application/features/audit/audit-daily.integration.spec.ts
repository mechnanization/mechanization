import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';

/**
 * «التقرير اليومي» against a real Postgres.
 *
 * The roll-up is one hand-written query with two levels of aggregation and a
 * timezone conversion, and none of that can be checked against a mock: the
 * mock has no `AT TIME ZONE`. The case that matters most is the last one —
 * `createdAt` is `TIMESTAMP(3)`, storing UTC with no zone attached, so a single
 * `AT TIME ZONE` reads the stored value as though it had been written in
 * Beirut and files an evening's work under the wrong day. Three hours is
 * exactly the kind of error nobody notices until an auditor asks why a
 * building was created at midnight.
 *
 * Set `TEST_DATABASE_URL` to run it (a throwaway Postgres 17 — never staging).
 */

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_audit_daily_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('Audit daily roll-up', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let repository: PrismaAuditRepository;

  const jawad = randomUUID();
  const samar = randomUUID();

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-audit-daily', tenantSlug: 'audit-daily', schemaName: SCHEMA, prisma: db },
      work,
    );

  /** One audit row at an exact instant, so the day boundaries are decidable. */
  const entry = (actorId: string, action: string, at: string) =>
    db.auditLogEntry.create({
      data: {
        actorId,
        actorType: 'STAFF',
        action,
        entityType: 'Building',
        entityId: randomUUID(),
        createdAt: new Date(at),
      },
    });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    repository = new PrismaAuditRepository(context);

    for (const [id, first] of [
      [jawad, 'جواد'],
      [samar, 'سمر'],
    ] as const) {
      await db.user.create({
        data: {
          id,
          kind: 'STAFF',
          tenantSlug: 'audit-daily',
          email: `${id}@audit.gov.lb`,
          firstName: first,
          lastName: 'موظف',
          role: 'FIELD_INSPECTOR',
          passwordHash: 'x',
        },
      });
    }

    // 2026-09-15, Beirut (UTC+3 in September): morning and afternoon.
    await entry(jawad, 'BUILDING_CREATED', '2026-09-15T07:00:00.000Z');
    await entry(jawad, 'UNIT_ADDED', '2026-09-15T07:30:00.000Z');
    await entry(jawad, 'UNIT_ADDED', '2026-09-15T08:00:00.000Z');
    await entry(samar, 'BUILDING_CREATED', '2026-09-15T09:00:00.000Z');

    // The next day, for one of them only.
    await entry(jawad, 'CASE_LOGGED', '2026-09-16T06:00:00.000Z');

    /*
      22:30 Beirut on the 15th, which is 19:30 UTC. Still the 15th in Beirut,
      and the 15th in UTC too — so this row alone cannot tell the two apart.
      The one below can.
    */
    await entry(samar, 'UNIT_EDITED', '2026-09-15T19:30:00.000Z');

    /*
      00:30 UTC on the 16th is 03:30 Beirut on the 16th — same day either way.
      21:30 UTC on the 15th is 00:30 Beirut on the *16th*: the row that proves
      the conversion happens in the reader's zone and not the server's.
    */
    await entry(samar, 'CASE_LOGGED', '2026-09-15T21:30:00.000Z');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  it('gives one row per staff member per day, with their actions counted', async () => {
    const result = await within(() =>
      repository.daily({ timeZone: 'Asia/Beirut', limit: 50, offset: 0 }),
    );

    // 15th: jawad and samar. 16th: jawad, and samar's 00:30 Beirut row.
    expect(result.total).toBe(4);

    const jawadOn15 = result.items.find((row) => row.day === '2026-09-15' && row.actorId === jawad);
    expect(jawadOn15).toBeDefined();
    expect(jawadOn15!.total).toBe(3);
    // Commonest first: two unit additions ahead of the one building.
    expect(jawadOn15!.actions).toEqual([
      { action: 'UNIT_ADDED', count: 2 },
      { action: 'BUILDING_CREATED', count: 1 },
    ]);

    const samarOn15 = result.items.find((row) => row.day === '2026-09-15' && row.actorId === samar);
    expect(samarOn15!.total).toBe(2);
    expect(samarOn15!.actions.map((a) => a.action).sort()).toEqual(['BUILDING_CREATED', 'UNIT_EDITED']);
  });

  it('buckets by the reader’s zone, not the server’s', async () => {
    const beirut = await within(() =>
      repository.daily({ timeZone: 'Asia/Beirut', limit: 50, offset: 0 }),
    );
    const utc = await within(() => repository.daily({ timeZone: 'UTC', limit: 50, offset: 0 }));

    /*
      21:30 UTC on the 15th is 00:30 on the 16th in Beirut. Read in Beirut that
      row belongs to samar's 16th; read in UTC it belongs to her 15th. The two
      answers differing is the whole point — a single AT TIME ZONE would have
      made them differ the other way, by three hours in the wrong direction.
    */
    const samarBeirut16 = beirut.items.find((row) => row.day === '2026-09-16' && row.actorId === samar);
    expect(samarBeirut16?.total).toBe(1);
    expect(samarBeirut16?.actions).toEqual([{ action: 'CASE_LOGGED', count: 1 }]);

    const samarUtc16 = utc.items.find((row) => row.day === '2026-09-16' && row.actorId === samar);
    expect(samarUtc16).toBeUndefined();

    const samarUtc15 = utc.items.find((row) => row.day === '2026-09-15' && row.actorId === samar);
    expect(samarUtc15?.total).toBe(3);
  });

  it('narrows by the same filters as the entry list', async () => {
    const mine = await within(() =>
      repository.daily({ actorId: jawad, timeZone: 'Asia/Beirut', limit: 50, offset: 0 }),
    );
    expect(mine.total).toBe(2);
    expect(mine.items.every((row) => row.actorId === jawad)).toBe(true);

    const units = await within(() =>
      repository.daily({ actions: ['UNIT_ADDED'], timeZone: 'Asia/Beirut', limit: 50, offset: 0 }),
    );
    expect(units.total).toBe(1);
    expect(units.items[0]!.actions).toEqual([{ action: 'UNIT_ADDED', count: 2 }]);

    const oneDay = await within(() =>
      repository.daily({
        from: new Date('2026-09-16T00:00:00.000Z'),
        timeZone: 'Asia/Beirut',
        limit: 50,
        offset: 0,
      }),
    );
    expect(oneDay.items.every((row) => row.day === '2026-09-16')).toBe(true);
  });

  it('pages over groups rather than over entries', async () => {
    const first = await within(() =>
      repository.daily({ timeZone: 'Asia/Beirut', limit: 1, offset: 0 }),
    );
    // The total counts groups, so a page of one still reports all four.
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(4);
    // Newest day first.
    expect(first.items[0]!.day).toBe('2026-09-16');

    const second = await within(() =>
      repository.daily({ timeZone: 'Asia/Beirut', limit: 1, offset: 1 }),
    );
    expect(second.items[0]!.day).toBe('2026-09-16');
    expect(second.items[0]!.actorId).not.toBe(first.items[0]!.actorId);
  });
});

/**
 * «النظام» in the daily report: the entries no person made (the scheduler's
 * recurring billing, a Whish callback) carry no `actorId`, so they roll up into
 * one row with a null actor. Its drill-down used to send no actor filter at
 * all, and listed every actor's entries for the day under «النظام».
 *
 * A schema of its own, so the counts the block above asserts stay its own.
 */
const SYSTEM_SCHEMA = 'tenant_audit_system_spec';

describeIfDb('Audit daily roll-up: the system row', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let repository: PrismaAuditRepository;

  const officer = randomUUID();
  const from = new Date('2026-09-20T00:00:00.000Z');
  const to = new Date('2026-09-20T20:59:59.999Z');

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run(
      { tenantId: 'tenant-audit-system', tenantSlug: 'audit-system', schemaName: SYSTEM_SCHEMA, prisma: db },
      work,
    );

  const entry = (actorId: string | null, action: string, at: string) =>
    db.auditLogEntry.create({
      data: {
        actorId,
        actorType: actorId ? 'STAFF' : 'SYSTEM',
        action,
        entityType: 'FeeNotice',
        entityId: randomUUID(),
        createdAt: new Date(at),
      },
    });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SYSTEM_SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SYSTEM_SCHEMA);

    db = tenantTestClient(TEST_DATABASE_URL!, SYSTEM_SCHEMA);
    context = new TenantContextService();
    repository = new PrismaAuditRepository(context);

    await db.user.create({
      data: {
        id: officer,
        kind: 'STAFF',
        tenantSlug: 'audit-system',
        email: `${officer}@audit.gov.lb`,
        firstName: 'جواد',
        lastName: 'موظف',
        role: 'ACCOUNTANT',
        passwordHash: 'x',
      },
    });

    // 2026-09-20 in Beirut (UTC+3): two by the officer, three by nobody.
    await entry(officer, 'FEE_ISSUED', '2026-09-20T07:00:00.000Z');
    await entry(officer, 'FEE_ISSUED', '2026-09-20T08:00:00.000Z');
    await entry(null, 'FEE_RECURRING_ISSUED', '2026-09-20T03:00:00.000Z');
    await entry(null, 'FEE_RECURRING_ISSUED', '2026-09-20T03:00:01.000Z');
    await entry(null, 'PAYMENT_WHISH_SETTLED', '2026-09-20T11:00:00.000Z');
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SYSTEM_SCHEMA}" CASCADE`);
    await ddl?.end();
  });

  it('rolls the entries with no actor into one row', async () => {
    const result = await within(() => repository.daily({ timeZone: 'Asia/Beirut', limit: 50, offset: 0 }));

    expect(result.total).toBe(2);
    expect(result.items.find((row) => row.actorId === null)?.total).toBe(3);
    expect(result.items.find((row) => row.actorId === officer)?.total).toBe(2);
  });

  it('drills the system row down to its own entries only', async () => {
    const system = await within(() =>
      repository.query({ systemActor: true, from, to, limit: 200, offset: 0 }),
    );

    // As many as the summary row counted, and none of the officer's.
    expect(system.total).toBe(3);
    expect(system.items).toHaveLength(3);
    expect(system.items.every((row) => row.actorId === null)).toBe(true);

    // What the drill-down returned with no actor filter: the whole day.
    const unfiltered = await within(() => repository.query({ from, to, limit: 200, offset: 0 }));
    expect(unfiltered.total).toBe(5);
  });

  it('narrows the summary the same way', async () => {
    const result = await within(() =>
      repository.daily({ systemActor: true, timeZone: 'Asia/Beirut', limit: 50, offset: 0 }),
    );

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ actorId: null, total: 3 });
  });
});
