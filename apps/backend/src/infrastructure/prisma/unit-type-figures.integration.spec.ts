import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { UNIT_FIGURE, knownUnitFigure } from '@mechanization/shared-schemas';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migration 0111, the drawing of each default unit type: one key per default,
 * every key one the shared package knows (so the elevation can draw it), none on
 * a system type, and a replay that changes nothing.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_unit_type_figures_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(join(__dirname, 'tenant/migrations/0111_unit_type_figures/migration.sql'), 'utf8');

describeIfDb('migration 0111: unit type figures', () => {
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

  it('gives every default type its own drawing, each one the shared package knows, and the system types none', async () => {
    const defaults = await db.unitTypeEntry.findMany({ where: { isSystem: false } });
    expect(defaults).toHaveLength(27);
    expect(defaults.every((row) => knownUnitFigure(row.figureKey) !== null)).toBe(true);
    // One drawing per type, and a drawing for every key the package lists.
    expect(new Set(defaults.map((row) => row.figureKey)).size).toBe(27);
    expect(defaults.map((row) => row.figureKey).sort()).toEqual([...UNIT_FIGURE].sort());
    expect(defaults.find((row) => row.nameAr === 'مسجد')?.figureKey).toBe('MOSQUE');
    expect(defaults.find((row) => row.nameAr === 'محطة وقود')?.figureKey).toBe('FUEL');
    expect((await db.unitTypeEntry.findMany({ where: { isSystem: true } })).every((row) => row.figureKey === null)).toBe(true);
  });

  it('changes nothing on a second run, and leaves a drawing a row already has', async () => {
    await db.unitTypeEntry.update({ where: { nameAr: 'مدرسة' }, data: { figureKey: 'WORSHIP' } });
    const before = await db.unitTypeEntry.findMany({ orderBy: { nameAr: 'asc' }, select: { nameAr: true, figureKey: true } });
    await replay();
    expect(await db.unitTypeEntry.findMany({ orderBy: { nameAr: 'asc' }, select: { nameAr: true, figureKey: true } })).toEqual(before);
  });

  it('keeps the drawing when a type is renamed, and refuses a key that is not shaped like one', async () => {
    const renamed = await db.unitTypeEntry.update({ where: { nameAr: 'مسجد' }, data: { nameAr: 'جامع الضيعة' } });
    expect(renamed.figureKey).toBe('MOSQUE');
    expect(await refusal(`UPDATE "unit_types" SET "figureKey" = 'mosque' WHERE "nameAr" = 'جامع الضيعة'`)).toBe('23514');
    expect(await refusal(`UPDATE "unit_types" SET "figureKey" = '' WHERE "nameAr" = 'جامع الضيعة'`)).toBe('23514');
    expect(await refusal(`UPDATE "unit_types" SET "figureKey" = 'FUTURE_FIGURE' WHERE "nameAr" = 'جامع الضيعة'`)).toBeNull();
  });
});
