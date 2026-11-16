import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../generated/tenant-client';
import { migrateTenantSchema } from './tenant-migrator';
import { tenantTestClient } from './tenant-test-client';

/**
 * Migration 0104, «قائمة الإعفاء من الرسوم»: the exemption periods table, its
 * backfill from the units exempt today, and the rules the database holds.
 *
 * The backfill is checked by running the file again over units exempted
 * through their 0077 columns alone (as the build before 0104 writes them):
 * every such unit gets exactly one open period carrying its own reason, note,
 * grantor and date, and a second run adds nothing.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_fee_exemption_periods_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(
  join(__dirname, 'tenant/migrations/0104_unit_fee_exemption_periods/migration.sql'),
  'utf8',
);

describeIfDb('migration 0104: unit fee exemption periods', () => {
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

  let sequence = 0;
  const unit = async (buildingId: string) =>
    db.unit.create({
      data: { buildingId, unitCode: String(++sequence).padStart(4, '0'), floor: 0, sequence, unitType: 'OFFICE' as never },
    });

  let buildingId: string;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    await db.user.create({
      data: { id: adminId, kind: 'STAFF', tenantSlug: 'fep', email: `${adminId}@fep.gov.lb`, firstName: 'مدير', lastName: 'النظام', role: 'SUPER_ADMIN' as never },
    });
    const building = await db.building.create({
      data: { parcelNumber: '77', codeSuffix: 'A', code: 'Z-1-77-A', structureType: 'MIXED_USE' as never, floorsCount: 1, createdById: adminId },
    });
    buildingId = building.id;
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('gives every unit exempt today one open period that matches it, and adds nothing on a second run', async () => {
    const mosque = await unit(buildingId);
    const hall = await unit(buildingId);
    const billed = await unit(buildingId);
    const grantedAt = new Date('2026-10-08T07:30:00.000Z');
    // Exempted the way the build before 0104 does: the unit's columns alone.
    await db.unit.update({
      where: { id: mosque.id },
      data: { feeExemption: 'PLACE_OF_WORSHIP' as never, feeExemptionNote: '   ', feeExemptedById: adminId, feeExemptedAt: grantedAt },
    });
    await db.unit.update({
      where: { id: hall.id },
      data: { feeExemption: 'OTHER' as never, feeExemptionNote: 'قاعة البلدية', feeExemptedAt: grantedAt },
    });

    await replay();
    await replay();

    const periods = await db.unitFeeExemption.findMany({ where: { unitId: { in: [mosque.id, hall.id, billed.id] } } });
    expect(periods).toHaveLength(2);
    expect(periods.find((p) => p.unitId === mosque.id)).toMatchObject({
      reason: 'PLACE_OF_WORSHIP',
      note: null,
      decisionRef: null,
      validUntil: null,
      grantedById: adminId,
      grantedAt,
      liftedAt: null,
      liftReason: null,
    });
    expect(periods.find((p) => p.unitId === hall.id)).toMatchObject({
      reason: 'OTHER',
      note: 'قاعة البلدية',
      grantedById: null,
      grantedAt,
      liftedAt: null,
    });
  });

  it('holds one open period per unit', async () => {
    const target = await unit(buildingId);
    await db.unitFeeExemption.create({ data: { unitId: target.id, reason: 'PUBLIC_FACILITY' as never, grantedAt: new Date() } });
    expect(
      await refusal(`INSERT INTO "unit_fee_exemptions" ("unitId", "reason", "grantedAt") VALUES ($1, 'PUBLIC_FACILITY', now())`, [target.id]),
    ).toBe('23505');
    // A lifted period beside the open one is history, and allowed.
    expect(
      await refusal(
        `INSERT INTO "unit_fee_exemptions" ("unitId", "reason", "grantedAt", "liftedAt", "liftReason")
         VALUES ($1, 'PUBLIC_FACILITY', now() - interval '2 days', now() - interval '1 day', 'انتهى القرار')`,
        [target.id],
      ),
    ).toBeNull();
  });

  it('refuses a lifting without a reason, a blank text, «سبب آخر» without words, and a lift before the grant', async () => {
    const target = await unit(buildingId);
    const insert = (columns: string, values: string) =>
      refusal(`INSERT INTO "unit_fee_exemptions" ("unitId", ${columns}) VALUES ($1, ${values})`, [target.id]);

    expect(await insert(`"reason", "grantedAt", "liftedAt"`, `'PUBLIC_FACILITY', now(), now()`)).toBe('23514');
    expect(await insert(`"reason", "grantedAt", "liftReason"`, `'PUBLIC_FACILITY', now(), 'سبب'`)).toBe('23514');
    expect(await insert(`"reason", "grantedAt", "liftedById"`, `'PUBLIC_FACILITY', now(), '${adminId}'`)).toBe('23514');
    expect(await insert(`"reason", "grantedAt", "liftedAt", "liftReason"`, `'PUBLIC_FACILITY', now(), now(), '  '`)).toBe('23514');
    expect(await insert(`"reason", "grantedAt", "decisionRef"`, `'PUBLIC_FACILITY', now(), ''`)).toBe('23514');
    expect(await insert(`"reason", "grantedAt"`, `'OTHER', now()`)).toBe('23514');
    expect(
      await insert(`"reason", "grantedAt", "liftedAt", "liftReason"`, `'PUBLIC_FACILITY', now(), now() - interval '1 day', 'سبب'`),
    ).toBe('23514');
  });

  it('puts an end date only on an exempt unit', async () => {
    const target = await unit(buildingId);
    expect(await refusal(`UPDATE "units" SET "feeExemptionValidUntil" = DATE '2027-01-31' WHERE "id" = $1`, [target.id])).toBe('23514');
    expect(
      await refusal(
        `UPDATE "units" SET "feeExemption" = 'PUBLIC_FACILITY', "feeExemptedAt" = now(), "feeExemptionValidUntil" = DATE '2027-01-31'
         WHERE "id" = $1`,
        [target.id],
      ),
    ).toBeNull();
  });

  it('keeps a unit with an exemption history from being deleted, and outlives the staff who granted it', async () => {
    const target = await unit(buildingId);
    const grantor = randomUUID();
    await db.user.create({
      data: { id: grantor, kind: 'STAFF', tenantSlug: 'fep', email: `${grantor}@fep.gov.lb`, firstName: 'موظف', lastName: 'سابق', role: 'SUPER_ADMIN' as never },
    });
    const period = await db.unitFeeExemption.create({
      data: { unitId: target.id, reason: 'PUBLIC_FACILITY' as never, grantedById: grantor, grantedAt: new Date() },
    });

    expect(await refusal(`DELETE FROM "units" WHERE "id" = $1`, [target.id])).toBe('23503');

    await db.user.delete({ where: { id: grantor } });
    expect((await db.unitFeeExemption.findUniqueOrThrow({ where: { id: period.id } })).grantedById).toBeNull();
  });
});
