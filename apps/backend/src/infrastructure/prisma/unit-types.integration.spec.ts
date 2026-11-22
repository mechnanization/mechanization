import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migration 0109, «أنواع الوحدات»: one system type per premises `UnitType`,
 * every premises unit given the system type of its own `unitType` (a floor
 * block given none), and the rules the database holds — a system type keeps its
 * base, a name is used once, no type takes a structural base, a type in use is
 * never deleted.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_types_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(join(__dirname, 'tenant/migrations/0109_unit_types/migration.sql'), 'utf8');

/** The values of `UnitType` that describe a floor, not premises. */
const STRUCTURAL = ['PILOTIS', 'EMPTY_FLOOR'];

describeIfDb('migration 0109: unit types', () => {
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
  /** A building with one unit of `unitType` and no `unitTypeId`, as the build before 0109 writes it. */
  const unitOf = async (unitType: string) => {
    const building = await db.building.create({
      data: {
        parcelNumber: `8${++parcel}`,
        codeSuffix: 'A',
        code: `Z-1-8${parcel}-A`,
        structureType: 'RESIDENTIAL_BUILDING' as never,
        floorsCount: 1,
        createdById: adminId,
      },
    });
    return db.unit.create({
      data: { buildingId: building.id, floor: 1, sequence: 1, unitCode: '0101', unitType: unitType as never },
    });
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    await db.user.create({
      data: { id: adminId, kind: 'STAFF', tenantSlug: 'ut', email: `${adminId}@ut.gov.lb`, firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('holds one active system type for every premises value of the UnitType enum, and none for a floor', async () => {
    const { rows } = await ddl.query<{ value: string }>(
      `SELECT unnest(enum_range(NULL::"${SCHEMA}"."UnitType"))::text AS value`,
    );
    const premises = rows.map((row) => row.value).filter((value) => !STRUCTURAL.includes(value));
    const system = await db.unitTypeEntry.findMany({ where: { isSystem: true } });
    expect(system.map((type) => type.baseType).sort()).toEqual(premises.sort());
    expect(system.every((type) => type.isActive && type.createdById === null)).toBe(true);
    expect(system.find((type) => type.baseType === 'SHOP')).toMatchObject({ nameAr: 'محل تجاري', nameEn: 'Commercial Shop' });
  });

  it('gives every premises unit with no type the system type of its own unitType, leaves a floor block without one, and changes nothing on a second run', async () => {
    const flat = await unitOf('APARTMENT');
    const shop = await unitOf('SHOP');
    const pilotis = await unitOf('PILOTIS');
    // A custom type already chosen is never overwritten by the backfill.
    const school = await db.unitTypeEntry.create({
      data: { nameAr: `مدرسة ${randomUUID().slice(0, 6)}`, baseType: 'OFFICE' as never, createdById: adminId },
    });
    const filed = await unitOf('OFFICE');
    await db.unit.update({ where: { id: filed.id }, data: { unitTypeId: school.id } });

    await replay();
    await replay();

    const typed = await db.unit.findMany({
      where: { id: { in: [flat.id, shop.id, pilotis.id, filed.id] } },
      include: { unitTypeEntry: true },
    });
    const byId = (id: string) => typed.find((row) => row.id === id)!;
    expect(byId(flat.id).unitTypeEntry).toMatchObject({ isSystem: true, baseType: 'APARTMENT' });
    expect(byId(shop.id).unitTypeEntry).toMatchObject({ isSystem: true, baseType: 'SHOP' });
    expect(byId(pilotis.id).unitTypeId).toBeNull();
    expect(byId(filed.id).unitTypeId).toBe(school.id);
    expect(await db.unitTypeEntry.count({ where: { isSystem: true } })).toBe(7);
  });

  it('keeps a system type on its base and a system type for ever, and lets it be renamed', async () => {
    const shop = await db.unitTypeEntry.findFirstOrThrow({ where: { isSystem: true, baseType: 'SHOP' as never } });
    expect(await refusal(`UPDATE "unit_types" SET "baseType" = 'OFFICE' WHERE "id" = $1`, [shop.id])).toBe('23514');
    expect(await refusal(`UPDATE "unit_types" SET "isSystem" = false WHERE "id" = $1`, [shop.id])).toBe('23514');
    expect(await refusal(`UPDATE "unit_types" SET "nameAr" = 'دكان', "isActive" = false WHERE "id" = $1`, [shop.id])).toBeNull();

    const electricity = await db.unitTypeEntry.create({
      data: { nameAr: `شركة كهرباء ${randomUUID().slice(0, 6)}`, baseType: 'OFFICE' as never, createdById: adminId },
    });
    expect(await refusal(`UPDATE "unit_types" SET "isSystem" = true, "createdById" = NULL WHERE "id" = $1`, [electricity.id])).toBe('23514');
    // The database lets a custom type unused by any unit move; the service refuses it once one uses it.
    expect(await refusal(`UPDATE "unit_types" SET "baseType" = 'WAREHOUSE' WHERE "id" = $1`, [electricity.id])).toBeNull();
  });

  it('refuses a name used twice, an untrimmed or empty name, a structural base, a second system row for a base, and deleting a type in use', async () => {
    const insert = (nameAr: string, baseType = 'OFFICE', nameEn: string | null = null, isSystem = false) =>
      refusal(
        `INSERT INTO "unit_types" ("nameAr", "nameEn", "baseType", "isSystem") VALUES ($1, $2, $3::"UnitType", $4)`,
        [nameAr, nameEn, baseType, isSystem],
      );
    expect(await insert('شقة')).toBe('23505');
    expect(await insert(' مدرسة')).toBe('23514');
    expect(await insert('')).toBe('23514');
    expect(await insert('مدرسة', 'OFFICE', '  ')).toBe('23514');
    expect(await insert('مدرسة', 'PILOTIS')).toBe('23514');
    expect(await insert('مدرسة', 'EMPTY_FLOOR')).toBe('23514');
    expect(await insert('مكتب ثان', 'OFFICE', null, true)).toBe('23505');
    expect(await insert('مدرسة')).toBeNull();

    const used = await unitOf('GARAGE');
    await replay();
    const { unitTypeId } = await db.unit.findUniqueOrThrow({ where: { id: used.id } });
    expect(await refusal(`DELETE FROM "unit_types" WHERE "id" = $1`, [unitTypeId])).toBe('23503');
  });

  it('does not recount a building when the backfill sets a unit type', async () => {
    const unit = await unitOf('APARTMENT');
    const before = await db.building.findUniqueOrThrow({ where: { id: unit.buildingId }, select: { unitsTotal: true, unitsSurveyed: true } });
    await replay();
    const after = await db.building.findUniqueOrThrow({ where: { id: unit.buildingId }, select: { unitsTotal: true, unitsSurveyed: true } });
    expect(after).toEqual(before);
  });
});
