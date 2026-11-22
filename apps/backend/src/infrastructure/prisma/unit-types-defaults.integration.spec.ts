import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migration 0110, the unit types every municipality starts with: one type per
 * name, each on the base whose picture and billing fit it, none a system row,
 * and a name a municipality already took left as it made it.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_types_defaults_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(join(__dirname, 'tenant/migrations/0110_default_unit_types/migration.sql'), 'utf8');

/** What the request of 2026-11-21 named, one type per name, and the base each takes. */
const EXPECTED: Record<string, string[]> = {
  OFFICE: ['مدرسة', 'شركة كهرباء', 'مؤسسة مياه', 'سرايا', 'مبنى بلدي', 'مخفر', 'مركز أمني', 'مسجد', 'كنيسة', 'دار عبادة', 'مصرف'],
  CLINIC: ['مستوصف', 'مركز صحي'],
  SHOP: ['مطعم', 'مقهى', 'صيدلية', 'مخبز', 'فرن', 'محطة وقود', 'سوبرماركت', 'ملحمة', 'صالون حلاقة', 'صالون تجميل'],
  WAREHOUSE: ['ورشة', 'مشغل', 'معمل', 'مصنع'],
};

describeIfDb('migration 0110: default unit types', () => {
  let ddl: Client;
  let db: TenantPrismaClient;

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

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('adds one active ordinary type per name, on the base its picture and billing fit, beside the seven system types', async () => {
    const rows = await db.unitTypeEntry.findMany({ where: { isSystem: false } });
    const byBase = (base: string) => rows.filter((row) => row.baseType === base).map((row) => row.nameAr).sort();
    for (const [base, names] of Object.entries(EXPECTED)) expect(byBase(base)).toEqual([...names].sort());
    expect(rows).toHaveLength(Object.values(EXPECTED).flat().length);
    expect(rows.every((row) => row.isActive && row.createdById === null && row.nameEn)).toBe(true);
    expect(await db.unitTypeEntry.count({ where: { isSystem: true } })).toBe(7);
    // A slash in the request is two types, never one name.
    expect(rows.some((row) => row.nameAr.includes('/'))).toBe(false);
  });

  it('changes nothing on a second run, and leaves a name a municipality already took as it made it', async () => {
    const before = await db.unitTypeEntry.count();
    await replay();
    expect(await db.unitTypeEntry.count()).toBe(before);

    // A municipality that renamed one, switched one off and re-based one keeps all three.
    await db.unitTypeEntry.update({ where: { nameAr: 'مدرسة' }, data: { nameEn: 'Public school', isActive: false } });
    await db.unitTypeEntry.update({ where: { nameAr: 'مطعم' }, data: { baseType: 'WAREHOUSE' as never } });
    await replay();
    expect(await db.unitTypeEntry.findUniqueOrThrow({ where: { nameAr: 'مدرسة' } })).toMatchObject({ nameEn: 'Public school', isActive: false });
    expect(await db.unitTypeEntry.findUniqueOrThrow({ where: { nameAr: 'مطعم' } })).toMatchObject({ baseType: 'WAREHOUSE' });
    expect(await db.unitTypeEntry.count()).toBe(before);
  });

  it('skips a type the municipality had already added under the same name, and adds the rest', async () => {
    // As if the municipality had typed «مدرسة» (as a clinic) before 0110 reached it, and never had «مسجد».
    await db.unitTypeEntry.deleteMany({ where: { nameAr: { in: ['مدرسة', 'مسجد'] } } });
    await db.unitTypeEntry.create({ data: { nameAr: 'مدرسة', baseType: 'CLINIC' as never } });
    await replay();

    // Its own «مدرسة» is left as the municipality made it; the missing «مسجد» is added back as a default.
    expect(await db.unitTypeEntry.findMany({ where: { nameAr: 'مدرسة' }, select: { baseType: true } })).toEqual([{ baseType: 'CLINIC' }]);
    expect(await db.unitTypeEntry.findMany({ where: { nameAr: 'مسجد' }, select: { baseType: true } })).toEqual([{ baseType: 'OFFICE' }]);
  });
});
