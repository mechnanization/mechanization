import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { PrismaCaseRepository } from '../../../infrastructure/repositories/case.repository';
import { AuditService } from '../audit/audit.service';
import { CasesService } from '../cases/cases.service';
import { BuildingsService } from './buildings.service';

/**
 * «تعديل عرض الوحدة» against a real Postgres: a resize lands, a resize over a
 * neighbour is refused and writes nothing, and the floor's unpositioned units
 * are pinned where the matrix drew them rather than redrawn somewhere else.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_span_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('BuildingsService.resizeUnitSpan', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'FIELD_INSPECTOR' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-span', tenantSlug: 'span', schemaName: SCHEMA, prisma: db }, work);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 400));

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();

    const events = new EventEmitter2();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    events.on('building.changed', (payload) => audit.onBuildingChanged(payload));
    const cases = new CasesService(
      new PrismaCaseRepository(context),
      { findById: async () => ({ id: officerId, kind: 'CITIZEN' }) } as never,
      events,
    );
    buildings = new BuildingsService(context, cases, events);

    officerId = randomUUID();
    await db.user.create({
      data: {
        id: officerId,
        kind: 'STAFF',
        tenantSlug: 'span',
        email: `officer-${officerId}@span.gov.lb`,
        firstName: 'موظف',
        lastName: 'تجربة',
        role: 'FIELD_INSPECTOR',
      },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** One floor of three flats, generated — so none has a stored span. */
  const building = (parcelNumber: string) =>
    within(async () => {
      const { building: created } = await buildings.create(
        { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 1, acknowledgedDuplicates: true } as never,
        actor(),
      );
      await buildings.generateUnits(
        created.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 0, unitsPerFloor: 3, unitType: 'APARTMENT' },
        actor(),
      );
      const units = await db.unit.findMany({ where: { buildingId: created.id }, orderBy: { sequence: 'asc' } });
      return { id: created.id, units };
    });

  const spans = (buildingId: string) =>
    db.unit
      .findMany({ where: { buildingId }, orderBy: { sequence: 'asc' }, select: { unitCode: true, startCol: true, endCol: true } })
      .then((rows) => rows.map((row) => [row.unitCode, row.startCol, row.endCol]));

  it('widens the last flat and pins the two before it where they were drawn', async () => {
    const { id, units } = await building('SPAN-1');
    expect(units.every((unit) => unit.startCol === null && unit.endCol === null)).toBe(true);

    // Drawn at 1, 2, 3. The third grows to 3–5.
    const row = await within(() => buildings.resizeUnitSpan(units[2]!.id, { startCol: 3, endCol: 5 }, actor()));
    expect([row.startCol, row.endCol]).toEqual([3, 5]);
    expect(await spans(id)).toEqual([
      ['0001', 1, 1],
      ['0002', 2, 2],
      ['0003', 3, 5],
    ]);

    await pause();
    const trail = await db.auditLogEntry.findMany({
      where: { entityType: 'Building', entityId: id, action: 'UNIT_UPDATED' },
      select: { after: true },
    });
    // The resize and the two pins, each its own row.
    expect(trail).toHaveLength(3);
    expect(trail.filter((entry) => (entry.after as { pinnedBy?: string }).pinnedBy === '0003')).toHaveLength(2);
  });

  it('moves the building’s version, so a screen opened before the resize cannot write over it', async () => {
    const { id, units } = await building('SPAN-STALE');
    const before = await db.building.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    await pause();

    await within(() => buildings.resizeUnitSpan(units[2]!.id, { startCol: 3, endCol: 5 }, actor()));

    const after = await db.building.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    // The stale screen's save is refused as a stale edit instead of undoing the resize.
    await expect(
      within(() =>
        buildings.saveMatrix(
          id,
          { expectedUpdatedAt: before.updatedAt.toISOString(), building: {}, remove: [], update: [], add: [] } as never,
          actor(),
        ),
      ),
    ).rejects.toMatchObject({ details: { staleEdit: expect.anything() } });
  });

  it('refuses drawing over a neighbour and writes nothing', async () => {
    const { id, units } = await building('SPAN-2');
    await expect(
      within(() => buildings.resizeUnitSpan(units[0]!.id, { startCol: 1, endCol: 2 }, actor())),
    ).rejects.toThrow('0002');
    expect(await spans(id)).toEqual([
      ['0001', null, null],
      ['0002', null, null],
      ['0003', null, null],
    ]);
  });

  it('fills a gap in the middle of a row exactly, and not one column further', async () => {
    const { id, units } = await building('SPAN-3');
    const [first, second, third] = units as [(typeof units)[0], (typeof units)[0], (typeof units)[0]];

    // 0002 moves out to column 4, leaving column 2 empty between 0001 and 0003.
    await within(() => buildings.resizeUnitSpan(second.id, { startCol: 4, endCol: 4 }, actor()));
    expect(await spans(id)).toEqual([
      ['0001', 1, 1],
      ['0002', 4, 4],
      ['0003', 3, 3],
    ]);

    // 0001 grows right into the gap…
    await within(() => buildings.resizeUnitSpan(first.id, { startCol: 1, endCol: 2 }, actor()));
    // …after which 0003 cannot grow left into it.
    await expect(
      within(() => buildings.resizeUnitSpan(third.id, { startCol: 2, endCol: 3 }, actor())),
    ).rejects.toThrow('0001');
    expect(await spans(id)).toEqual([
      ['0001', 1, 2],
      ['0002', 4, 4],
      ['0003', 3, 3],
    ]);
  });
});
