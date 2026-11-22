import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { REQUEST_TYPE, REQUEST_TYPES_ON_PROPERTY, ar, en } from '@mechanization/shared-schemas';
import { loadTenantMigrations, migrateTenantSchema } from './tenant-migrator';

/**
 * Migration 0114, the built-in request types as system forms (open decisions §24 F1, docs/request-forms-plan.md §3.8):
 * one form per type, its fee and switch copied once from `request_type_settings`, its first version published with no
 * questions, every request filed before it linked to its type's form without any other column changing, and a replay
 * that writes nothing — above all, never over a fee the manager has changed since.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const FRESH = 'tenant_request_system_forms_fresh_spec';
const UPGRADE = 'tenant_request_system_forms_upgrade_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATION = readFileSync(join(__dirname, 'tenant/migrations/0114_request_system_forms/migration.sql'), 'utf8');

describeIfDb('migration 0114: the built-in types as system forms', () => {
  let ddl: Client;
  const managerId = randomUUID();
  const citizens = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];

  const runIn = async (schema: string, sql: string, params: unknown[] = []) => {
    await ddl.query('BEGIN');
    try {
      await ddl.query(`SET LOCAL search_path TO "${schema}"`);
      const result = await ddl.query(sql, params);
      await ddl.query('COMMIT');
      return result;
    } catch (error) {
      await ddl.query('ROLLBACK');
      throw error;
    }
  };

  const applyMigrations = async (schema: string, include: (name: string) => boolean) => {
    await ddl.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await ddl.query(`CREATE TABLE IF NOT EXISTS "${schema}"."_tenant_migrations" ("name" TEXT PRIMARY KEY, "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now())`);
    for (const migration of loadTenantMigrations().filter((entry) => include(entry.name))) {
      await ddl.query('BEGIN');
      try {
        await ddl.query(`SET LOCAL search_path TO "${schema}"`);
        await ddl.query(migration.sql);
        await ddl.query(`INSERT INTO "${schema}"."_tenant_migrations" ("name") VALUES ($1)`, [migration.name]);
        await ddl.query('COMMIT');
      } catch (error) {
        await ddl.query('ROLLBACK');
        throw error;
      }
    }
  };

  const forms = async (schema: string) =>
    (
      await runIn(
        schema,
        `SELECT f.*, v."status" AS "versionStatus", v."versionNumber", v."publishedAt", v."publishedById",
                (SELECT count(*)::int FROM request_form_fields x WHERE x."versionId" = f."currentVersionId") AS "fields"
           FROM request_forms f LEFT JOIN request_form_versions v ON v."id" = f."currentVersionId"
          WHERE f."systemType" IS NOT NULL ORDER BY f."sortOrder"`,
      )
    ).rows;

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${FRESH}" CASCADE`);
    await ddl.query(`DROP SCHEMA IF EXISTS "${UPGRADE}" CASCADE`);
    await migrateTenantSchema(ddl, FRESH);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await ddl?.query(`DROP SCHEMA IF EXISTS "${FRESH}" CASCADE`);
    await ddl?.query(`DROP SCHEMA IF EXISTS "${UPGRADE}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('on a municipality that has never set a type', () => {
    it('makes one system form per type, off and free, named as the labels name the type', async () => {
      const rows = await forms(FRESH);
      expect(rows.map((row) => row.systemType)).toEqual([...REQUEST_TYPE]);
      for (const row of rows) {
        expect(row).toMatchObject({ enabled: false, askCapacity: true, askPurpose: true, archivedAt: null });
        expect(Number(row.feeAmount)).toBe(0);
        expect(row.nameAr).toBe(ar.requestType[row.systemType as (typeof REQUEST_TYPE)[number]]);
        expect(row.nameEn).toBe(en.requestType[row.systemType as (typeof REQUEST_TYPE)[number]]);
      }
    });

    it('asks for a card exactly where the type always did (D4), and leaves it optional elsewhere', async () => {
      for (const row of await forms(FRESH)) {
        const tied = (REQUEST_TYPES_ON_PROPERTY as readonly string[]).includes(row.systemType);
        expect(row.propertyMode).toBe(tied ? 'REQUIRED' : 'OPTIONAL');
      }
    });

    it('publishes each form\'s first version with no questions and nobody\'s name on it, and makes it current', async () => {
      for (const row of await forms(FRESH)) {
        expect(row).toMatchObject({ versionStatus: 'PUBLISHED', versionNumber: 1, fields: 0, publishedById: null });
        expect(row.publishedAt).not.toBeNull();
        expect(row.currentVersionId).not.toBeNull();
      }
    });
  });

  describe('on a municipality that has set some types and filed some requests', () => {
    const before = new Map<string, unknown>();
    const filed: Record<string, string> = {};

    beforeAll(async () => {
      await applyMigrations(UPGRADE, (name) => name < '0114');
      for (const id of [managerId, ...citizens]) {
        await runIn(UPGRADE, `INSERT INTO users ("id", "kind", "tenantSlug", "firstName", "lastName", "updatedAt") VALUES ($1, 'CITIZEN', 'sf', 'مواطن', 'تجريبي', now())`, [id]);
      }
      await runIn(
        UPGRADE,
        `INSERT INTO request_type_settings ("requestType", "enabled", "feeAmount", "updatedById") VALUES
           ('CLEARANCE', true, 200000, $1), ('RESIDENCY', true, 100000, $1), ('OTHER', false, 50000, $1)`,
        [managerId],
      );
      const legacy = (index: number, type: string, status: string) =>
        runIn(
          UPGRADE,
          `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "status", "clientRequestId")
           VALUES ($1, $2, 'ONLINE', $3::"RequestType", 'OWNER', $4::"RequestStatus", $5) RETURNING "id"`,
          [`REQ-SF-${randomUUID().slice(0, 8)}`, citizens[index], type, status, randomUUID()],
        ).then((result) => result.rows[0].id as string);
      filed.clearance = await legacy(0, 'CLEARANCE', 'AWAITING_PAYMENT');
      filed.residency = await legacy(1, 'RESIDENCY', 'IN_REVIEW');
      // A closed one: the link is the one write 0113's guard lets through a finished request.
      filed.rejected = await legacy(2, 'OTHER', 'IN_REVIEW');
      await runIn(UPGRADE, `UPDATE citizen_requests SET "status" = 'REJECTED', "rejectionReason" = 'لا ينطبق عليه', "rejectedAt" = now(), "rejectedById" = $2 WHERE "id" = $1`, [
        filed.rejected,
        managerId,
      ]);
      const snapshot = await runIn(UPGRADE, `SELECT to_jsonb(r) AS row FROM citizen_requests r ORDER BY "id"`);
      for (const { row } of snapshot.rows) before.set(row.id, row);

      await applyMigrations(UPGRADE, (name) => name === '0114_request_system_forms');
    }, SETUP_TIMEOUT_MS);

    it('copies the fee and the switch the manager had set, once, and leaves a type never set off and free', async () => {
      const byType = new Map((await forms(UPGRADE)).map((row) => [row.systemType, row]));
      expect(byType.get('CLEARANCE')).toMatchObject({ enabled: true });
      expect(Number(byType.get('CLEARANCE')!.feeAmount)).toBe(200000);
      expect(byType.get('RESIDENCY')).toMatchObject({ enabled: true });
      expect(Number(byType.get('RESIDENCY')!.feeAmount)).toBe(100000);
      expect(byType.get('OTHER')).toMatchObject({ enabled: false });
      expect(Number(byType.get('OTHER')!.feeAmount)).toBe(50000);
      expect(byType.get('VACANCY')).toMatchObject({ enabled: false });
      expect(Number(byType.get('VACANCY')!.feeAmount)).toBe(0);
    });

    it('links every request to its type\'s form and published version, and changes nothing else on it', async () => {
      const byType = new Map((await forms(UPGRADE)).map((row) => [row.systemType, row]));
      const { rows } = await runIn(UPGRADE, `SELECT to_jsonb(r) AS row FROM citizen_requests r ORDER BY "id"`);
      expect(rows).toHaveLength(before.size);
      for (const { row } of rows) {
        const { formId, formVersionId, ...rest } = row;
        const was = before.get(row.id) as Record<string, unknown>;
        const form = byType.get(row.requestType)!;
        expect(formId).toBe(form.id);
        expect(formVersionId).toBe(form.currentVersionId);
        expect(rest).toEqual(Object.fromEntries(Object.entries(was).filter(([key]) => key !== 'formId' && key !== 'formVersionId')));
      }
    });

    it('replays as a no-op: nothing written, and a fee the manager changed since is not copied over', async () => {
      const wasForms = (await forms(UPGRADE)).map((row) => ({ id: row.id, updatedAt: row.updatedAt }));
      await runIn(UPGRADE, `UPDATE request_forms SET "feeAmount" = 777000, "enabled" = false WHERE "systemType" = 'CLEARANCE'`);
      await runIn(UPGRADE, MIGRATION);
      await runIn(UPGRADE, MIGRATION);
      const after = await forms(UPGRADE);
      expect(after).toHaveLength(8);
      expect(after.map((row) => row.id)).toEqual(wasForms.map((row) => row.id));
      const clearance = after.find((row) => row.systemType === 'CLEARANCE')!;
      expect(Number(clearance.feeAmount)).toBe(777000);
      expect(clearance.enabled).toBe(false);
      const versions = await runIn(UPGRADE, `SELECT count(*)::int AS n FROM request_form_versions`);
      expect(versions.rows[0].n).toBe(8);
    });

    it('links a request filed afterwards on no form on the next replay, as the same type\'s form', async () => {
      const late = (
        await runIn(
          UPGRADE,
          `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "status", "clientRequestId")
           VALUES ($1, $2, 'ONLINE', 'SIGNAGE', 'OWNER', 'AWAITING_PAYMENT', $3) RETURNING "id"`,
          [`REQ-SF-${randomUUID().slice(0, 8)}`, citizens[3], randomUUID()],
        )
      ).rows[0].id as string;
      await runIn(UPGRADE, MIGRATION);
      const { rows } = await runIn(
        UPGRADE,
        `SELECT r."formId" = f."id" AS "linked" FROM citizen_requests r JOIN request_forms f ON f."systemType" = 'SIGNAGE' WHERE r."id" = $1`,
        [late],
      );
      expect(rows[0].linked).toBe(true);
    });
  });

  it('is the next free number and no gap', () => {
    const names = loadTenantMigrations().map((entry) => entry.name);
    expect(names.slice(-3)).toEqual(['0112_request_form_enums', '0113_request_forms', '0114_request_system_forms']);
  });
});
