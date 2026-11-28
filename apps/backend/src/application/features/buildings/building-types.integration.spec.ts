import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { STRUCTURE_TYPE, STRUCTURE_TYPE_MAP } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { BuildingTypesService } from './building-types.service';
import { BuildingsService } from './buildings.service';

/**
 * «أنواع المباني» against a real tenant schema (migrations 0105, 0106; the
 * user's request of 2026-11-16): the system types against the shared
 * `STRUCTURE_TYPE`, a building's structure always taken from its type, an
 * inactive type refused on a new building and kept on an old one, a system
 * type's structure fixed, and every write in the audit trail.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_building_types_service_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

describeIfDb('building types', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let types: BuildingTypesService;
  let buildings: BuildingsService;
  const adminId = randomUUID();
  const admin = { id: adminId, role: 'SUPER_ADMIN' as const };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'bts', tenantSlug: 'bts', schemaName: SCHEMA, prisma: db }, work);

  let parcel = 0;
  const newBuilding = (input: Record<string, unknown>) =>
    within(() =>
      buildings.create(
        { parcelNumber: `8${++parcel}`, lifecycleStatus: 'IN_USE', floorsCount: 1, structureType: 'RESIDENTIAL_BUILDING', ...input } as never,
        admin,
      ),
    );

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    types = new BuildingTypesService(context, audit);
    buildings = new BuildingsService(context, new EventEmitter2());
    await db.user.create({
      data: { id: adminId, kind: 'STAFF', tenantSlug: 'bts', email: `${adminId}@bts.gov.lb`, firstName: 'مدير', lastName: 'البلدية', role: 'SUPER_ADMIN' as const as never },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('lists one system type per shared StructureType, first, each starting units as STRUCTURE_TYPE_MAP says', async () => {
    const list = await within(() => types.list({ includeInactive: true }));
    const system = list.filter((type) => type.isSystem);
    expect(system.map((type) => type.structureType).sort()).toEqual([...STRUCTURE_TYPE].sort());
    for (const type of system) expect(type.defaultUnitType).toBe(STRUCTURE_TYPE_MAP[type.structureType].defaultUnitType);
    expect(list.slice(0, system.length).every((type) => type.isSystem)).toBe(true);
  });

  it('takes a building’s structure from its type, never from the body beside it', async () => {
    const clinic = await within(() =>
      types.create({ nameAr: 'مستوصف', structureType: 'PUBLIC_INSTITUTION', defaultUnitType: 'CLINIC' }, admin),
    );
    const { building } = await newBuilding({ buildingTypeId: clinic.id, structureType: 'WAREHOUSE_HANGAR' });
    expect(building).toMatchObject({ buildingTypeId: clinic.id, structureType: 'PUBLIC_INSTITUTION' });

    // An older client sends only a structure: the building is filed under its system type.
    const { building: legacy } = await newBuilding({ structureType: 'MIXED_USE' });
    const mixed = (await within(() => types.list({ includeInactive: false }))).find(
      (type) => type.isSystem && type.structureType === 'MIXED_USE',
    )!;
    expect(legacy).toMatchObject({ buildingTypeId: mixed.id, structureType: 'MIXED_USE' });

    // Retyped on edit: the structure follows the type.
    const edited = await within(() => buildings.update(legacy.id, { buildingTypeId: clinic.id } as never, admin));
    expect(edited).toMatchObject({ buildingTypeId: clinic.id, structureType: 'PUBLIC_INSTITUTION' });
  });

  it('refuses a type switched off on a new building, and keeps it on one that already has it', async () => {
    const school = await within(() =>
      types.create({ nameAr: 'مدرسة', structureType: 'PUBLIC_INSTITUTION', defaultUnitType: 'OFFICE' }, admin),
    );
    const { building } = await newBuilding({ buildingTypeId: school.id });
    await within(() => types.update(school.id, { isActive: false }, admin));

    await expect(newBuilding({ buildingTypeId: school.id })).rejects.toMatchObject({ code: 'BUILDING_TYPE_INACTIVE' });
    const kept = await within(() => buildings.update(building.id, { buildingTypeId: school.id, name: 'مدرسة الضيعة' } as never, admin));
    expect(kept).toMatchObject({ buildingTypeId: school.id, name: 'مدرسة الضيعة' });
    expect((await within(() => types.list({ includeInactive: false }))).some((type) => type.id === school.id)).toBe(false);
  });

  it('keeps a system type on its structure, and a custom type on its own once a building has it', async () => {
    const residential = (await within(() => types.list({ includeInactive: false }))).find(
      (type) => type.isSystem && type.structureType === 'RESIDENTIAL_BUILDING',
    )!;
    await expect(within(() => types.update(residential.id, { structureType: 'MIXED_USE' }, admin))).rejects.toMatchObject({
      code: 'BUILDING_TYPE_SYSTEM_STRUCTURE',
    });
    // Renamed, the label only.
    expect(await within(() => types.update(residential.id, { nameAr: 'بناية سكنية' }, admin))).toMatchObject({
      nameAr: 'بناية سكنية',
      structureType: 'RESIDENTIAL_BUILDING',
    });

    const hall = await within(() => types.create({ nameAr: 'مبنى بلدي', structureType: 'PUBLIC_INSTITUTION', defaultUnitType: 'OFFICE' }, admin));
    await newBuilding({ buildingTypeId: hall.id });
    await expect(within(() => types.update(hall.id, { structureType: 'MIXED_USE' }, admin))).rejects.toMatchObject({
      code: 'BUILDING_TYPE_STRUCTURE_IN_USE',
      params: { count: 1 },
    });
  });

  it('refuses a name another type has, and audits every write', async () => {
    await expect(
      within(() => types.create({ nameAr: 'منزل مستقل', structureType: 'INDEPENDENT_HOUSE', defaultUnitType: 'INDEPENDENT_HOUSE' }, admin)),
    ).rejects.toMatchObject({ code: 'BUILDING_TYPE_NAME_TAKEN' });

    const created = await within(() =>
      types.create({ nameAr: `مستودع بلدي ${randomUUID().slice(0, 4)}`, structureType: 'WAREHOUSE_HANGAR', defaultUnitType: 'WAREHOUSE' }, admin),
    );
    await within(() => types.update(created.id, { sortOrder: 5 }, admin));
    const rows = await db.auditLogEntry.findMany({ where: { entityType: 'BuildingType', entityId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(rows.map((row) => row.action)).toEqual(['BUILDING_TYPE_CREATED', 'BUILDING_TYPE_UPDATED']);
    expect(rows[1]!.before).toMatchObject({ sortOrder: 100 });
    expect(rows[1]!.after).toMatchObject({ sortOrder: 5 });
  });
});
