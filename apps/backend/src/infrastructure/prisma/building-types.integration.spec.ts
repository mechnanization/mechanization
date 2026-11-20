import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migrations 0105 and 0106, «أنواع المباني»: one system type per
 * `StructureType`, every building given the system type of its own structure,
 * and the rules the database holds — a system type keeps its structure, a
 * name is used once, a type in use is never deleted.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_building_types_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(join(__dirname, 'tenant/migrations/0106_building_types/migration.sql'), 'utf8');

describeIfDb('migrations 0105–0106: building types', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  const adminId = randomUUID();

  const replay = async () => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${SCHEMA}"`);
      await ddl.query(MIGRATION);
      await ddl.query('COMMIT');
    } catch (error) {
      await ddl.query('ROLLBACK');
      throw error;
    }
  };

  /** Runs `sql` in the spec schema and returns the Postgres error code it raised, or null. */
  const refusal = async (sql: string, params: unknown[] = []): Promise<string | null> => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${SCHEMA}"`);
      await ddl.query(sql, params);
      return null;
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    } finally {
      await ddl.query('ROLLBACK');
    }
  };

  let parcel = 0;
  const building = (structureType: string) =>
    db.building.create({
      data: {
        parcelNumber: `9${++parcel}`,
        codeSuffix: 'A',
        code: `Z-1-9${parcel}-A`,
        structureType: structureType as never,
        floorsCount: 1,
        createdById: adminId,
      },
    });

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    await db.user.create({
      data: { id: adminId, kind: 'STAFF', tenantSlug: 'bt', email: `${adminId}@bt.gov.lb`, firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('holds one active system type for every value of the StructureType enum, and no other', async () => {
    const { rows } = await ddl.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::"${SCHEMA}"."StructureType"))::text AS value`,
    );
    const system = await db.buildingType.findMany({ where: { isSystem: true } });
    expect(system.map((type) => type.structureType).sort()).toEqual(rows.map((row) => row.value).sort());
    expect(rows.map((row) => row.value)).toContain('PUBLIC_INSTITUTION');
    expect(system.every((type) => type.isActive && type.createdById === null)).toBe(true);
    expect(system.find((type) => type.structureType === 'PUBLIC_INSTITUTION')).toMatchObject({
      nameAr: 'منشأة عامة / خدماتية',
      defaultUnitType: 'OFFICE',
    });
  });

  it('gives every building with no type the system type of its own structure, and changes nothing on a second run', async () => {
    const house = await building('INDEPENDENT_HOUSE');
    const block = await building('MIXED_USE');
    // A custom type already chosen is never overwritten by the backfill.
    const school = await db.buildingType.create({
      data: { nameAr: `مدرسة ${randomUUID().slice(0, 6)}`, structureType: 'PUBLIC_INSTITUTION' as never, defaultUnitType: 'OFFICE' as never, createdById: adminId },
    });
    const filed = await building('PUBLIC_INSTITUTION');
    await db.building.update({ where: { id: filed.id }, data: { buildingTypeId: school.id } });

    await replay();
    await replay();

    const typed = await db.building.findMany({
      where: { id: { in: [house.id, block.id, filed.id] } },
      include: { buildingType: true },
    });
    for (const row of typed) expect(row.buildingType!.structureType).toBe(row.structureType);
    expect(typed.find((row) => row.id === house.id)!.buildingType).toMatchObject({ isSystem: true });
    expect(typed.find((row) => row.id === filed.id)!.buildingTypeId).toBe(school.id);
    expect(await db.buildingType.count({ where: { isSystem: true } })).toBe(7);
  });

  it('keeps a system type on its structure and a system type for ever, and lets it be renamed', async () => {
    const residential = await db.buildingType.findFirstOrThrow({ where: { isSystem: true, structureType: 'RESIDENTIAL_BUILDING' as never } });
    expect(
      await refusal(`UPDATE "building_types" SET "structureType" = 'MIXED_USE' WHERE "id" = $1`, [residential.id]),
    ).toBe('23514');
    expect(await refusal(`UPDATE "building_types" SET "isSystem" = false WHERE "id" = $1`, [residential.id])).toBe('23514');
    expect(
      await refusal(`UPDATE "building_types" SET "nameAr" = 'بناية سكنية', "isActive" = false WHERE "id" = $1`, [residential.id]),
    ).toBeNull();

    const clinic = await db.buildingType.create({
      data: { nameAr: `مستوصف ${randomUUID().slice(0, 6)}`, structureType: 'PUBLIC_INSTITUTION' as never, defaultUnitType: 'CLINIC' as never, createdById: adminId },
    });
    expect(await refusal(`UPDATE "building_types" SET "isSystem" = true, "createdById" = NULL WHERE "id" = $1`, [clinic.id])).toBe('23514');
    // The database lets a custom type unused by any building move; the service refuses it once one uses it.
    expect(await refusal(`UPDATE "building_types" SET "structureType" = 'MIXED_USE' WHERE "id" = $1`, [clinic.id])).toBeNull();
  });

  it('refuses a name used twice, an untrimmed or empty name, a structural default unit, and deleting a type in use', async () => {
    const insert = (nameAr: string, defaultUnitType = 'OFFICE', nameEn: string | null = null) =>
      refusal(
        `INSERT INTO "building_types" ("nameAr", "nameEn", "structureType", "defaultUnitType") VALUES ($1, $2, 'PUBLIC_INSTITUTION', $3::"UnitType")`,
        [nameAr, nameEn, defaultUnitType],
      );
    expect(await insert('منزل مستقل')).toBe('23505');
    expect(await insert(' مبنى بلدي')).toBe('23514');
    expect(await insert('')).toBe('23514');
    expect(await insert('مبنى بلدي', 'OFFICE', '  ')).toBe('23514');
    expect(await insert('مبنى بلدي', 'PILOTIS')).toBe('23514');
    expect(await insert('مبنى بلدي')).toBeNull();

    const used = await building('COMMERCIAL_CENTER');
    await replay();
    const { buildingTypeId } = await db.building.findUniqueOrThrow({ where: { id: used.id } });
    expect(await refusal(`DELETE FROM "building_types" WHERE "id" = $1`, [buildingTypeId])).toBe('23503');
  });
});
