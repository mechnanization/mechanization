import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { saveBuildingMatrixSchema } from '@mechanization/shared-schemas';
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
 * The building editor's save, all or nothing, against a real Postgres.
 *
 * The save used to be one request for the building and one per unit, so a
 * refused unit left the rest applied. Each test is one promise the single
 * transaction makes: everything lands together, one refusal writes nothing,
 * and a dry run leaves no trace — not even an audit row.
 *
 * Set `TEST_DATABASE_URL` to run it (Postgres 17). Never point it at staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_matrix_save_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('BuildingsService.saveMatrix', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let buildings: BuildingsService;
  let officerId: string;

  const actor = () => ({ id: officerId, role: 'FIELD_INSPECTOR' });
  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'tenant-matrix', tenantSlug: 'matrix', schemaName: SCHEMA, prisma: db }, work);
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
        tenantSlug: 'matrix',
        email: `officer-${officerId}@matrix.gov.lb`,
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

  /** Two floors, two flats each. */
  const building = (parcelNumber: string) =>
    within(async () => {
      const { building: created } = await buildings.create(
        { parcelNumber, structureType: 'RESIDENTIAL_BUILDING', lifecycleStatus: 'IN_USE', floorsCount: 2, acknowledgedDuplicates: true } as never,
        actor(),
      );
      await buildings.generateUnits(
        created.id,
        { kind: 'uniform', fromFloor: 0, toFloor: 1, unitsPerFloor: 2, unitType: 'APARTMENT' },
        actor(),
      );
      const units = await db.unit.findMany({ where: { buildingId: created.id }, orderBy: [{ floor: 'asc' }, { sequence: 'asc' }] });
      return { id: created.id, units };
    });

  const save = (id: string, body: Record<string, unknown>) =>
    within(() => buildings.saveMatrix(id, saveBuildingMatrixSchema.parse(body), actor()));

  it('removes the top floor, retypes a flat, adds one and lowers the floor count, in one save', async () => {
    const { id, units } = await building('MX-1');
    const top = units.filter((unit) => unit.floor === 1);
    const ground = units.filter((unit) => unit.floor === 0);

    const result = await save(id, {
      building: { name: 'بناية النور', floorsCount: 1 },
      remove: top.map((unit) => unit.id),
      update: [{ id: ground[0]!.id, floor: 0, startCol: 1, endCol: 1, unitType: 'SHOP' }],
      add: [{ floor: 0, startCol: 3, endCol: 3, unitType: 'APARTMENT' }],
    });

    expect(result.dryRun).toBe(false);
    expect(result.removed.sort()).toEqual(top.map((unit) => unit.unitCode).sort());
    expect(result.added).toHaveLength(1);
    const after = await db.building.findUniqueOrThrow({ where: { id } });
    // The shrink the old editor had to send in two steps.
    expect([after.floorsCount, after.name]).toEqual([1, 'بناية النور']);
    const left = await db.unit.findMany({ where: { buildingId: id } });
    expect(left).toHaveLength(3);
    expect(left.find((unit) => unit.id === ground[0]!.id)!.unitType).toBe('SHOP');
  });

  it('writes nothing when one change is refused', async () => {
    const { id, units } = await building('MX-2');
    const lived = units[0]!;
    const citizenId = randomUUID();
    await db.user.create({ data: { id: citizenId, kind: 'CITIZEN', tenantSlug: 'matrix', firstName: 'ساكن', lastName: 'تجربة' } });
    await db.unitOccupancy.create({ data: { unitId: lived.id, citizenId, role: 'TENANT', toDate: new Date() } });
    const before = await db.building.findUniqueOrThrow({ where: { id } });

    await expect(
      save(id, {
        building: { name: 'اسم جديد' },
        remove: [lived.id],
        add: [{ floor: 1, startCol: 3, endCol: 3, unitType: 'APARTMENT' }],
      }),
    ).rejects.toThrow(new RegExp(lived.unitCode));

    // Not the name, not the new flat, not the removal.
    const after = await db.building.findUniqueOrThrow({ where: { id } });
    expect(after.name).toBe(before.name);
    expect(await db.unit.count({ where: { buildingId: id } })).toBe(4);
  });

  it('rehearses a save without writing it, or a line of audit', async () => {
    const { id, units } = await building('MX-3');
    await pause();
    const auditBefore = await db.auditLogEntry.count({ where: { entityId: id } });

    const result = await save(id, {
      building: { name: 'تجربة فقط' },
      remove: [units[3]!.id],
      add: [{ floor: 0, startCol: 3, endCol: 3, unitType: 'SHOP' }],
      dryRun: true,
    });
    await pause();

    expect(result).toMatchObject({ dryRun: true, removed: [units[3]!.unitCode] });
    expect(result.added).toHaveLength(1);
    expect(result.building.name).toBe('تجربة فقط');
    expect((await db.building.findUniqueOrThrow({ where: { id } })).name).toBeNull();
    expect(await db.unit.count({ where: { buildingId: id } })).toBe(4);
    expect(await db.auditLogEntry.count({ where: { entityId: id } })).toBe(auditBefore);
  });

  it('refuses a unit that is not this building’s, and a screen somebody saved over', async () => {
    const first = await building('MX-4');
    const other = await building('MX-5');
    await expect(save(first.id, { building: {}, remove: [other.units[0]!.id] })).rejects.toThrow(/لم تعد في هذا المبنى/);
    await expect(
      save(first.id, { building: { name: 'x' }, expectedUpdatedAt: new Date(Date.now() - 86_400_000).toISOString() }),
    ).rejects.toThrow(/بعد أن فتحتَه/);
  });

  it('lets only one of two saves from the same screen through, even at the same moment', async () => {
    const { id } = await building('MX-6');
    const opened = (await db.building.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();

    const results = await Promise.allSettled([
      save(id, { building: { name: 'الأول' }, expectedUpdatedAt: opened }),
      save(id, { building: { name: 'الثاني' }, expectedUpdatedAt: opened }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/بعد أن فتحتَه/);
  });
});
