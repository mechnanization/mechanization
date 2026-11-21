import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DEFAULT_UNIT_TYPE_BASE, UNIT_TYPE, isStructuralUnitType } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { BuildingsService } from './buildings.service';
import { UnitTypesService } from './unit-types.service';

/**
 * «أنواع الوحدات» against a real tenant schema (migration 0109; the user's
 * request of 2026-11-21): the system types against the shared `UNIT_TYPE`, a
 * unit's `unitType` always taken from its type, an inactive type refused on a
 * new unit and kept on an old one, a system type's base fixed, and every write
 * in the audit trail.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_types_service_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('unit types', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let types: UnitTypesService;
  let buildings: BuildingsService;
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'uts', tenantSlug: 'uts', schemaName: SCHEMA, prisma: db }, work);

  let parcel = 0;
  const newBuilding = async (input: Record<string, unknown> = {}) => {
    const { building } = await within(() =>
      buildings.create(
        { parcelNumber: `7${++parcel}`, lifecycleStatus: 'IN_USE', floorsCount: 3, structureType: 'RESIDENTIAL_BUILDING', ...input } as never,
        admin,
      ),
    );
    return building;
  };
  /** Adds one unit on `floor`, the duplicate question already answered. */
  const addUnit = (buildingId: string, input: Record<string, unknown>) =>
    within(() => buildings.addUnit(buildingId, { floor: 0, acknowledgedDuplicates: true, ...input } as never, admin));
  const system = async (baseType: string) =>
    (await within(() => types.list({ includeInactive: true }))).find((type) => type.isSystem && type.baseType === baseType)!;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    types = new UnitTypesService(context, audit);
    buildings = new BuildingsService(context, {} as never, new EventEmitter2());
    await db.user.create({
      data: { id: adminId, kind: 'STAFF', tenantSlug: 'uts', email: `${adminId}@uts.gov.lb`, firstName: 'مدير', lastName: 'البلدية', role: 'SUPER_ADMIN' as never },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('lists one system type per premises UnitType, first, and none for a floor block', async () => {
    const list = await within(() => types.list({ includeInactive: true }));
    const systemTypes = list.filter((type) => type.isSystem);
    expect(systemTypes.map((type) => type.baseType).sort()).toEqual(UNIT_TYPE.filter((type) => !isStructuralUnitType(type)).sort());
    expect(list.slice(0, systemTypes.length).every((type) => type.isSystem)).toBe(true);
  });

  it('bills a type added with only a name as an office, and files its units that way', async () => {
    const water = await within(() => types.create({ nameAr: 'شركة مياه خاصة' }, admin));
    expect(water).toMatchObject({ baseType: DEFAULT_UNIT_TYPE_BASE, isSystem: false, isActive: true });
    // Renaming sends no base, so it can never move what the type bills as.
    expect(await within(() => types.update(water.id, { nameAr: 'مياه الضيعة' }, admin))).toMatchObject({
      nameAr: 'مياه الضيعة',
      baseType: 'OFFICE',
    });

    const unit = await addUnit((await newBuilding()).id, { unitType: 'SHOP', unitTypeId: water.id });
    expect(unit).toMatchObject({ unitTypeId: water.id, unitType: 'OFFICE' });
  });

  it('files a unit under its custom type, and bills it as the type’s base whatever else was sent', async () => {
    const building = await newBuilding();
    const school = await within(() => types.create({ nameAr: 'مدرسة خاصة', baseType: 'OFFICE' }, admin));

    const unit = await addUnit(building.id, { unitType: 'SHOP', unitTypeId: school.id });
    expect(unit).toMatchObject({ unitTypeId: school.id, unitType: 'OFFICE' });
    expect((await within(() => types.list({ includeInactive: false }))).find((type) => type.id === school.id)).toMatchObject({ unitCount: 1 });
  });

  it('files a unit sent with only a unit type, as an older client or a queued save does, under that base’s system type', async () => {
    const building = await newBuilding();
    const shop = await system('SHOP');
    const unit = await addUnit(building.id, { unitType: 'SHOP' });
    expect(unit).toMatchObject({ unitTypeId: shop.id, unitType: 'SHOP' });

    // A floor block is no premises: it has no type.
    const pilotis = await addUnit(building.id, { unitType: 'PILOTIS', floor: -1 });
    expect(pilotis).toMatchObject({ unitTypeId: null, unitType: 'PILOTIS' });
  });

  it('keeps a custom type when its base is sent again, and changes it when another is chosen', async () => {
    const building = await newBuilding();
    const electricity = await within(() => types.create({ nameAr: 'شركة كهرباء خاصة', baseType: 'OFFICE' }, admin));
    const water = await within(() => types.create({ nameAr: 'شركة مياه خاصة', baseType: 'OFFICE' }, admin));
    const unit = await addUnit(building.id, { unitType: 'OFFICE', unitTypeId: electricity.id });

    expect(await within(() => buildings.updateUnit(unit.id, { unitType: 'OFFICE', notes: 'x' }, admin))).toMatchObject({
      unitTypeId: electricity.id,
    });
    // The same base, another type: nothing about billing moves, and the trail says so.
    expect(await within(() => buildings.updateUnit(unit.id, { unitType: 'OFFICE', unitTypeId: water.id }, admin))).toMatchObject({
      unitTypeId: water.id,
      unitType: 'OFFICE',
    });
    const retyped = await within(() => buildings.updateUnit(unit.id, { unitType: 'SHOP' }, admin));
    expect(retyped).toMatchObject({ unitType: 'SHOP', unitTypeId: (await system('SHOP')).id });
  });

  it('clears the type of a unit retyped into a floor block', async () => {
    const building = await newBuilding();
    const unit = await addUnit(building.id, { unitType: 'WAREHOUSE', floor: 0 });
    expect(unit.unitTypeId).not.toBeNull();
    expect(await within(() => buildings.updateUnit(unit.id, { unitType: 'PILOTIS' }, admin))).toMatchObject({
      unitType: 'PILOTIS',
      unitTypeId: null,
    });
  });

  it('gives a unit made before 0109 its system type the next time it is saved', async () => {
    const building = await newBuilding();
    const bare = await db.unit.create({
      data: { buildingId: building.id, floor: 1, sequence: 1, unitCode: '0101', unitType: 'CLINIC' as never },
    });
    expect(bare.unitTypeId).toBeNull();
    expect(await within(() => buildings.updateUnit(bare.id, { notes: 'مسح' }, admin))).toMatchObject({
      unitTypeId: (await system('CLINIC')).id,
      unitType: 'CLINIC',
    });
  });

  it('refuses a type switched off on a new unit, and keeps it on one that already has it', async () => {
    const building = await newBuilding();
    const clinic = await within(() => types.create({ nameAr: 'مستوصف خاص', baseType: 'CLINIC' }, admin));
    const unit = await addUnit(building.id, { unitType: 'CLINIC', unitTypeId: clinic.id });
    await within(() => types.update(clinic.id, { isActive: false }, admin));

    await expect(addUnit(building.id, { unitType: 'CLINIC', unitTypeId: clinic.id, floor: 1 })).rejects.toMatchObject({
      code: 'UNIT_TYPE_INACTIVE',
    });
    expect(await within(() => buildings.updateUnit(unit.id, { unitTypeId: clinic.id, notes: 'باقٍ' }, admin))).toMatchObject({
      unitTypeId: clinic.id,
      notes: 'باقٍ',
    });
    expect((await within(() => types.list({ includeInactive: false }))).some((type) => type.id === clinic.id)).toBe(false);
  });

  it('files the units a blueprint generates and the ones a building is created with under their type', async () => {
    const school = await within(() => types.create({ nameAr: 'مدرسة ابتدائية', baseType: 'OFFICE' }, admin));
    const building = await newBuilding({
      units: [
        { floor: 0, unitType: 'SHOP', unitTypeId: school.id },
        { floor: 0, unitType: 'APARTMENT' },
      ],
    });
    const created = await db.unit.findMany({ where: { buildingId: building.id }, orderBy: { sequence: 'asc' } });
    expect(created.map((unit) => [unit.unitType, unit.unitTypeId])).toEqual([
      ['OFFICE', school.id],
      ['APARTMENT', (await system('APARTMENT')).id],
    ]);

    const other = await newBuilding();
    await within(() =>
      buildings.generateUnits(other.id, { kind: 'uniform', fromFloor: 1, toFloor: 2, unitsPerFloor: 2, unitType: 'APARTMENT', unitTypeId: school.id } as never, admin),
    );
    const generated = await db.unit.findMany({ where: { buildingId: other.id } });
    expect(generated).toHaveLength(4);
    expect(generated.every((unit) => unit.unitType === 'OFFICE' && unit.unitTypeId === school.id)).toBe(true);
  });

  it('keeps a system type on its base, and a custom type on its own once a unit has it', async () => {
    const shop = await system('SHOP');
    await expect(within(() => types.update(shop.id, { baseType: 'OFFICE' }, admin))).rejects.toMatchObject({ code: 'UNIT_TYPE_SYSTEM_BASE' });
    // Renamed, the label only.
    expect(await within(() => types.update(shop.id, { nameAr: 'دكان' }, admin))).toMatchObject({ nameAr: 'دكان', baseType: 'SHOP' });

    const hall = await within(() => types.create({ nameAr: 'قاعة بلدية', baseType: 'OFFICE' }, admin));
    // Free to move while nothing uses it.
    expect(await within(() => types.update(hall.id, { baseType: 'WAREHOUSE' }, admin))).toMatchObject({ baseType: 'WAREHOUSE' });
    const building = await newBuilding();
    await addUnit(building.id, { unitType: 'WAREHOUSE', unitTypeId: hall.id });
    await expect(within(() => types.update(hall.id, { baseType: 'OFFICE' }, admin))).rejects.toMatchObject({
      code: 'UNIT_TYPE_BASE_IN_USE',
      params: { count: 1 },
    });
  });

  it('refuses a name another type has, and audits every write', async () => {
    await expect(within(() => types.create({ nameAr: 'مكتب', baseType: 'OFFICE' }, admin))).rejects.toMatchObject({
      code: 'UNIT_TYPE_NAME_TAKEN',
    });

    const created = await within(() => types.create({ nameAr: `مصرف ${randomUUID().slice(0, 4)}`, baseType: 'OFFICE' }, admin));
    await within(() => types.update(created.id, { sortOrder: 5 }, admin));
    const rows = await db.auditLogEntry.findMany({ where: { entityType: 'UnitType', entityId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.action)).toEqual(['UNIT_TYPE_CREATED', 'UNIT_TYPE_UPDATED']);
    expect(rows[1]!.before).toMatchObject({ sortOrder: 100 });
    expect(rows[1]!.after).toMatchObject({ sortOrder: 5 });
  });
});
