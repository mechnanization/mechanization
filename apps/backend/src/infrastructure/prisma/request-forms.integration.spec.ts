import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { loadTenantMigrations, migrateTenantSchema } from './tenant-migrator';

/**
 * Migrations 0112 and 0113, the request form builder (docs/request-forms-plan.md §3):
 * the rules the database holds, each proven by watching a write that breaks it fail with
 * the code that rule raises — 23505 for a unique index, 23514 for a CHECK or a trigger —
 * and the write beside it that keeps it succeed, so a refusal can only
 * be that rule's. Plus the one thing a migration owes a municipality that already has
 * data: that it lands on requests filed before it, and replays as a no-op.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_request_forms_spec';
const UPGRADE_SCHEMA = 'tenant_request_forms_upgrade_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const MIGRATIONS = ['0112_request_form_enums', '0113_request_forms'].map((name) =>
  readFileSync(join(__dirname, `tenant/migrations/${name}/migration.sql`), 'utf8'),
);

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

describeIfDb('migrations 0112 and 0113: request forms', () => {
  let ddl: Client;
  const managerId = randomUUID();
  const citizenId = randomUUID();
  const otherCitizenId = randomUUID();

  /** Runs `sql` in `schema`, committed. */
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
  const run = (sql: string, params: unknown[] = []) => runIn(SCHEMA, sql, params);

  /** Runs `sql` in the spec schema, rolled back, and returns the Postgres error code it raised, or null. */
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

  // ── builders ─────────────────────────────────────────────────────────────

  const newForm = async (extra: { systemType?: string } = {}): Promise<string> =>
    (
      await run(
        `INSERT INTO request_forms ("nameAr", "systemType", "createdById") VALUES ($1, $2::"RequestType", $3) RETURNING "id"`,
        [`نموذج ${randomUUID().slice(0, 8)}`, extra.systemType ?? null, managerId],
      )
    ).rows[0].id as string;

  const newVersion = async (formId: string, versionNumber = 1): Promise<string> =>
    (
      await run(`INSERT INTO request_form_versions ("formId", "versionNumber", "createdById") VALUES ($1, $2, $3) RETURNING "id"`, [
        formId,
        versionNumber,
        managerId,
      ])
    ).rows[0].id as string;

  type Field = Partial<{ key: string; position: number; type: string; linkedSource: string | null; config: unknown; labelAr: string }>;
  const fieldSql = (versionId: string, field: Field): [string, unknown[]] => [
    `INSERT INTO request_form_fields ("versionId", "key", "position", "type", "labelAr", "linkedSource", "config")
     VALUES ($1, $2, $3, $4::"RequestFieldType", $5, $6::"RequestLinkedSource", $7::jsonb) RETURNING "id"`,
    [
      versionId,
      field.key ?? `q_${randomUUID().slice(0, 8)}`,
      field.position ?? 0,
      field.type ?? 'SHORT_TEXT',
      field.labelAr ?? 'سؤال',
      field.linkedSource ?? null,
      JSON.stringify(field.config ?? {}),
    ],
  ];
  const addField = async (versionId: string, field: Field = {}): Promise<string> => (await run(...fieldSql(versionId, field))).rows[0].id as string;
  const fieldRefusal = (versionId: string, field: Field) => refusal(...fieldSql(versionId, field));

  const publish = (versionId: string) =>
    run(`UPDATE request_form_versions SET "status" = 'PUBLISHED', "publishedAt" = now(), "publishedById" = $2 WHERE "id" = $1`, [
      versionId,
      managerId,
    ]);

  /** A form with a published version that is its current one. */
  const liveForm = async (fields: Field[] = []): Promise<{ formId: string; versionId: string; fieldIds: string[] }> => {
    const formId = await newForm();
    const versionId = await newVersion(formId);
    const fieldIds: string[] = [];
    for (const [index, field] of fields.entries()) fieldIds.push(await addField(versionId, { position: index, ...field }));
    await publish(versionId);
    await run(`UPDATE request_forms SET "currentVersionId" = $2, "enabled" = true WHERE "id" = $1`, [formId, versionId]);
    return { formId, versionId, fieldIds };
  };

  type Request = Partial<{
    type: string;
    capacity: string | null;
    status: string;
    formId: string | null;
    formVersionId: string | null;
    citizen: string;
  }>;
  const requestSql = (request: Request): [string, unknown[]] => [
    `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "status", "formId", "formVersionId", "clientRequestId")
     VALUES ($1, $2, 'ONLINE', $3::"RequestType", $4::"ApplicantCapacity", $5::"RequestStatus", $6, $7, $8) RETURNING "id"`,
    [
      `REQ-${randomUUID().slice(0, 12)}`,
      request.citizen ?? citizenId,
      request.type ?? 'OTHER',
      request.capacity === undefined ? 'OWNER' : request.capacity,
      request.status ?? 'AWAITING_PAYMENT',
      request.formId ?? null,
      request.formVersionId ?? null,
      randomUUID(),
    ],
  ];
  /** A citizen of its own, so a request never meets the one-open rule of another test's. */
  const freshCitizen = async (): Promise<string> => {
    const id = randomUUID();
    await run(`INSERT INTO users ("id", "kind", "tenantSlug", "firstName", "lastName", "updatedAt") VALUES ($1, 'CITIZEN', 'rf', 'مواطن', 'جديد', now())`, [id]);
    return id;
  };
  const addRequest = async (request: Request = {}): Promise<string> =>
    (await run(...requestSql({ ...request, citizen: request.citizen ?? (await freshCitizen()) }))).rows[0].id as string;
  const requestRefusal = (request: Request) => refusal(...requestSql(request));

  const answerSql = (requestId: string, fieldId: string): [string, unknown[]] => [
    `INSERT INTO citizen_request_answers ("requestId", "fieldId", "value") VALUES ($1, $2, '"x"'::jsonb) RETURNING "id"`,
    [requestId, fieldId],
  ];
  const attachmentSql = (requestId: string, fieldId: string | null): [string, unknown[]] => [
    `INSERT INTO citizen_request_attachments ("requestId", "type", "storagePath", "mimeType", "sizeBytes", "uploadedById", "fieldId")
     VALUES ($1, 'IDENTITY', $2, 'application/pdf', 100, $3, $4) RETURNING "id"`,
    [requestId, `t/${randomUUID()}.pdf`, citizenId, fieldId],
  ];

  const seedUsers = async (schema: string) => {
    await runIn(
      schema,
      `INSERT INTO users ("id", "kind", "tenantSlug", "email", "firstName", "lastName", "role", "updatedAt")
       VALUES ($1, 'STAFF', 'rf', $2, 'مدير', 'النظام', 'SUPER_ADMIN', now())`,
      [managerId, `${managerId}@rf.gov.lb`],
    );
    for (const id of [citizenId, otherCitizenId]) {
      await runIn(schema, `INSERT INTO users ("id", "kind", "tenantSlug", "firstName", "lastName", "updatedAt") VALUES ($1, 'CITIZEN', 'rf', 'مواطن', 'تجريبي', now())`, [id]);
    }
  };

  /** Applies the migrations whose names pass `include`, each in its own transaction, as the migrator does. */
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

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl.query(`DROP SCHEMA IF EXISTS "${UPGRADE_SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    await seedUsers(SCHEMA);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.query(`DROP SCHEMA IF EXISTS "${UPGRADE_SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  // ── the migration itself ─────────────────────────────────────────────────

  it('replays both files without error and without a second copy of anything', async () => {
    const count = async () =>
      (
        await run(
          `SELECT (SELECT count(*) FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = $1)
                + (SELECT count(*) FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND NOT tg.tgisinternal)
                + (SELECT count(*) FROM pg_indexes WHERE schemaname = $1)
                + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype = 'e') AS n`,
          [SCHEMA],
        )
      ).rows[0].n;
    const before = await count();
    for (const sql of MIGRATIONS) await run(sql);
    expect(await count()).toBe(before);
  });

  describe('on a municipality that already has requests', () => {
    let openLegacy: string;
    let completedLegacy: string;
    const before = new Map<string, unknown>();

    beforeAll(async () => {
      // The schema as it stood before this release: every migration up to 0111.
      await applyMigrations(UPGRADE_SCHEMA, (name) => name < '0112');
      await seedUsers(UPGRADE_SCHEMA);
      const legacy = (status: string, type: string) =>
        runIn(
          UPGRADE_SCHEMA,
          `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "status", "clientRequestId")
           VALUES ($1, $2, 'ONLINE', $3::"RequestType", 'OWNER', $4::"RequestStatus", $5) RETURNING "id"`,
          [`REQ-OLD-${randomUUID().slice(0, 8)}`, citizenId, type, status, randomUUID()],
        ).then((result) => result.rows[0].id as string);
      openLegacy = await legacy('AWAITING_PAYMENT', 'CLEARANCE');
      // One taken all the way to COMPLETED, through the transitions 0094 allows.
      completedLegacy = await legacy('IN_REVIEW', 'RESIDENCY');
      await runIn(
        UPGRADE_SCHEMA,
        `UPDATE citizen_requests SET "status" = 'READY_FOR_PICKUP', "readyAt" = now(), "readyById" = $2, "statement" = 'تشهد البلدية' WHERE "id" = $1`,
        [completedLegacy, managerId],
      );
      await runIn(UPGRADE_SCHEMA, `UPDATE citizen_requests SET "status" = 'COMPLETED', "completedAt" = now(), "completedById" = $2 WHERE "id" = $1`, [
        completedLegacy,
        managerId,
      ]);
      const snapshot = await runIn(UPGRADE_SCHEMA, `SELECT to_jsonb(r) AS row FROM citizen_requests r ORDER BY "id"`);
      for (const { row } of snapshot.rows) before.set(row.id, row);

      await applyMigrations(UPGRADE_SCHEMA, (name) => name === '0112_request_form_enums' || name === '0113_request_forms');
    }, SETUP_TIMEOUT_MS);

    it('leaves every request as it was, the new columns empty', async () => {
      const { rows } = await runIn(UPGRADE_SCHEMA, `SELECT to_jsonb(r) AS row FROM citizen_requests r ORDER BY "id"`);
      expect(rows).toHaveLength(before.size);
      for (const { row } of rows) {
        const { formId, formVersionId, ...rest } = row;
        expect(formId).toBeNull();
        expect(formVersionId).toBeNull();
        expect(rest).toEqual(before.get(row.id));
      }
    });

    const upgradeRefusal = async (sql: string, params: unknown[] = []): Promise<string | null> => {
      await ddl.query('BEGIN');
      try {
        await ddl.query(`SET LOCAL search_path TO "${UPGRADE_SCHEMA}"`);
        await ddl.query(sql, params);
        return null;
      } catch (error) {
        return (error as { code?: string }).code ?? 'unknown';
      } finally {
        await ddl.query('ROLLBACK');
      }
    };

    it('still refuses a second open request of one type for one citizen, as before', async () => {
      expect(
        await upgradeRefusal(
          `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "clientRequestId")
           VALUES ('REQ-DUP', $1, 'ONLINE', 'CLEARANCE', 'OWNER', $2)`,
          [citizenId, randomUUID()],
        ),
      ).toBe(UNIQUE_VIOLATION);
    });

    it('lets a request be filed with no capacity, which the build before it never did', async () => {
      expect(
        await upgradeRefusal(
          `INSERT INTO citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "clientRequestId")
           VALUES ('REQ-NOCAP', $1, 'ONLINE', 'OTHER', NULL, $2)`,
          [citizenId, randomUUID()],
        ),
      ).toBeNull();
    });

    it('links an already COMPLETED request to a form once, and never changes it again (the later backfill)', async () => {
      const formId = randomUUID();
      const versionId = randomUUID();
      await runIn(UPGRADE_SCHEMA, `INSERT INTO request_forms ("id", "nameAr", "systemType") VALUES ($1, 'إفادة سكن', 'RESIDENCY')`, [formId]);
      await runIn(
        UPGRADE_SCHEMA,
        `INSERT INTO request_form_versions ("id", "formId", "versionNumber", "status", "publishedAt") VALUES ($1, $2, 1, 'PUBLISHED', now())`,
        [versionId, formId],
      );
      await runIn(UPGRADE_SCHEMA, `UPDATE citizen_requests SET "formId" = $2, "formVersionId" = $3 WHERE "id" = $1`, [completedLegacy, formId, versionId]);
      const { rows } = await runIn(UPGRADE_SCHEMA, `SELECT "formId", "status" FROM citizen_requests WHERE "id" = $1`, [completedLegacy]);
      expect(rows[0]).toMatchObject({ formId, status: 'COMPLETED' });

      // The same closed request, changed in any other way, is still refused.
      expect(await upgradeRefusal(`UPDATE citizen_requests SET "formId" = NULL, "formVersionId" = NULL WHERE "id" = $1`, [completedLegacy])).toBe(CHECK_VIOLATION);
      expect(await upgradeRefusal(`UPDATE citizen_requests SET "purpose" = 'تغيير' WHERE "id" = $1`, [completedLegacy])).toBe(CHECK_VIOLATION);
      // And an open legacy request keeps its history rule: its type never changes.
      expect(await upgradeRefusal(`UPDATE citizen_requests SET "requestType" = 'OTHER' WHERE "id" = $1`, [openLegacy])).toBe(CHECK_VIOLATION);
    });
  });

  // ── the forms, their versions and their fields ───────────────────────────

  describe('a form', () => {
    it('refuses a fee that is negative or not whole pounds, and a blank or over-long name', async () => {
      for (const [column, value] of [
        ['"feeAmount"', '-1'],
        ['"feeAmount"', '1500.50'],
      ] as const) {
        expect(await refusal(`INSERT INTO request_forms ("nameAr", ${column}) VALUES ('نموذج', ${value})`)).toBe(CHECK_VIOLATION);
      }
      expect(await refusal(`INSERT INTO request_forms ("nameAr") VALUES ('   ')`)).toBe(CHECK_VIOLATION);
      expect(await refusal(`INSERT INTO request_forms ("nameAr") VALUES (repeat('ا', 201))`)).toBe(CHECK_VIOLATION);
      expect(await refusal(`INSERT INTO request_forms ("nameAr", "nameEn", "feeAmount") VALUES ('نموذج', 'Form', 250000)`)).toBeNull();
    });

    it('stands for one built-in type at most, and never for another once made', async () => {
      await newForm({ systemType: 'SIGNAGE' });
      expect(await refusal(`INSERT INTO request_forms ("nameAr", "systemType") VALUES ('أخرى', 'SIGNAGE')`)).toBe(UNIQUE_VIOLATION);
      // Any number of custom forms: a NULL system type never collides.
      expect(await refusal(`INSERT INTO request_forms ("nameAr") VALUES ('مخصص')`)).toBeNull();

      const formId = await newForm({ systemType: 'VACANCY' });
      expect(await refusal(`UPDATE request_forms SET "systemType" = 'OTHER' WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_forms SET "systemType" = NULL WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_forms SET "nameAr" = 'اسم جديد' WHERE "id" = $1`, [formId])).toBeNull();
    });

    it('is offered only once it has a published version, and never archived', async () => {
      const formId = await newForm();
      expect(await refusal(`UPDATE request_forms SET "enabled" = true WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);

      const versionId = await newVersion(formId);
      // A draft is not a current version.
      expect(await refusal(`UPDATE request_forms SET "currentVersionId" = $2 WHERE "id" = $1`, [formId, versionId])).toBe(CHECK_VIOLATION);
      await publish(versionId);
      expect(await refusal(`UPDATE request_forms SET "currentVersionId" = $2, "enabled" = true WHERE "id" = $1`, [formId, versionId])).toBeNull();

      await run(`UPDATE request_forms SET "currentVersionId" = $2, "enabled" = true WHERE "id" = $1`, [formId, versionId]);
      expect(await refusal(`UPDATE request_forms SET "archivedAt" = now(), "archivedById" = $2 WHERE "id" = $1`, [formId, managerId])).toBe(CHECK_VIOLATION);
      expect(
        await refusal(`UPDATE request_forms SET "archivedAt" = now(), "archivedById" = $2, "enabled" = false WHERE "id" = $1`, [formId, managerId]),
      ).toBeNull();
      // Archived with no one to name is refused: the stamp and who move together.
      expect(await refusal(`UPDATE request_forms SET "archivedAt" = now(), "enabled" = false WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
    });

    it("never takes another form's version as its current one", async () => {
      const first = await liveForm();
      const second = await liveForm();
      expect(await refusal(`UPDATE request_forms SET "currentVersionId" = $2 WHERE "id" = $1`, [first.formId, second.versionId])).toBe(CHECK_VIOLATION);
    });
  });

  describe('a version', () => {
    it('allows one draft a form, and one number once', async () => {
      const formId = await newForm();
      const first = await newVersion(formId, 1);
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber") VALUES ($1, 2)`, [formId])).toBe(UNIQUE_VIOLATION);
      await publish(first);
      // With the first published, a new draft is allowed — but not under a number already used.
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber") VALUES ($1, 2)`, [formId])).toBeNull();
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber") VALUES ($1, 1)`, [formId])).toBe(UNIQUE_VIOLATION);
    });

    it('is PUBLISHED exactly when it carries its stamp', async () => {
      const formId = await newForm();
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber", "status") VALUES ($1, 1, 'PUBLISHED')`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber", "publishedAt") VALUES ($1, 1, now())`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`INSERT INTO request_form_versions ("formId", "versionNumber", "revision") VALUES ($1, 1, 0)`, [formId])).toBe(CHECK_VIOLATION);
    });

    it('lets a draft be edited and published once, and never changes after', async () => {
      const formId = await newForm();
      const versionId = await newVersion(formId);
      expect(await refusal(`UPDATE request_form_versions SET "revision" = "revision" + 1 WHERE "id" = $1`, [versionId])).toBeNull();
      expect(await refusal(`UPDATE request_form_versions SET "revision" = 0 WHERE "id" = $1`, [versionId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_form_versions SET "versionNumber" = 9 WHERE "id" = $1`, [versionId])).toBe(CHECK_VIOLATION);

      await publish(versionId);
      expect(await refusal(`UPDATE request_form_versions SET "revision" = "revision" + 1 WHERE "id" = $1`, [versionId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_form_versions SET "status" = 'DRAFT', "publishedAt" = NULL, "publishedById" = NULL WHERE "id" = $1`, [versionId])).toBe(CHECK_VIOLATION);
      // A write that changes nothing is not a change.
      expect(await refusal(`UPDATE request_form_versions SET "revision" = "revision" WHERE "id" = $1`, [versionId])).toBeNull();
    });

    it('is never removed once a request was filled against it, and may be before', async () => {
      const used = await liveForm();
      const unused = await liveForm();
      await addRequest({ formId: used.formId, formVersionId: used.versionId });
      // Disabled first: an enabled form must keep a current version (its CHECK), which removal would take away.
      for (const { formId } of [used, unused]) await run(`UPDATE request_forms SET "enabled" = false WHERE "id" = $1`, [formId]);

      expect(await refusal(`DELETE FROM request_form_versions WHERE "id" = $1`, [used.versionId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM request_form_versions WHERE "id" = $1`, [unused.versionId])).toBeNull();
    });

    it('cannot be removed from under an enabled form', async () => {
      const live = await liveForm();
      expect(await refusal(`DELETE FROM request_form_versions WHERE "id" = $1`, [live.versionId])).toBe(CHECK_VIOLATION);
    });
  });

  describe('a field', () => {
    let draftId: string;
    beforeAll(async () => {
      draftId = await newVersion(await newForm());
    });

    it.each([
      ['a key that starts with a digit', { key: '1name' }],
      ['a key with a capital letter', { key: 'Name' }],
      ['a key with a space', { key: 'full name' }],
      ['a key over 40 characters', { key: `a${'b'.repeat(40)}` }],
      ['a position of 40 (at most 40 questions)', { position: 40 }],
      ['a negative position', { position: -1 }],
      ['a blank label', { labelAr: '   ' }],
      ['a configuration that is not an object', { config: [1, 2] }],
      ['a name part linked to a phone question', { type: 'PHONE', linkedSource: 'FIRST_NAME' }],
      ['an identity number linked to a short text', { type: 'SHORT_TEXT', linkedSource: 'IDENTITY_NUMBER' }],
      ['a phone linked to a document number', { type: 'DOCUMENT_NUMBER', linkedSource: 'PHONE' }],
    ] as [string, Field][])('refuses %s', async (_label, field) => {
      expect(await fieldRefusal(draftId, { key: 'ok_key', position: 0, ...field })).toBe(CHECK_VIOLATION);
    });

    it('accepts each of those once it is put right, and each linked source on the type that can hold it', async () => {
      for (const field of [
        { key: 'a', position: 0 },
        { key: 'b', position: 39 },
        { key: 'c', position: 1, type: 'SHORT_TEXT', linkedSource: 'FIRST_NAME' },
        { key: 'd', position: 2, type: 'SHORT_TEXT', linkedSource: 'MOTHER_NAME' },
        { key: 'e', position: 3, type: 'PHONE', linkedSource: 'PHONE' },
        { key: 'f', position: 4, type: 'DOCUMENT_NUMBER', linkedSource: 'IDENTITY_NUMBER' },
        { key: 'g', position: 5, type: 'DOCUMENT_NUMBER', linkedSource: 'CIVIL_RECORD_NUMBER' },
        { key: 'h', position: 6, type: 'SINGLE_CHOICE', config: { choices: [{ key: 'one' }] } },
      ] satisfies Field[]) {
        expect(await fieldRefusal(draftId, field)).toBeNull();
      }
    });

    it('is unique by key and by position inside a version, and may repeat across versions', async () => {
      const versionId = await newVersion(await newForm());
      await addField(versionId, { key: 'name', position: 0 });
      expect(await fieldRefusal(versionId, { key: 'name', position: 1 })).toBe(UNIQUE_VIOLATION);
      expect(await fieldRefusal(versionId, { key: 'other', position: 0 })).toBe(UNIQUE_VIOLATION);
      const another = await newVersion(await newForm());
      expect(await fieldRefusal(another, { key: 'name', position: 0 })).toBeNull();
    });

    it('is written into a draft only, and never moved to another version', async () => {
      const versionId = await newVersion(await newForm());
      const fieldId = await addField(versionId, { key: 'name', position: 0 });
      expect(await refusal(`UPDATE request_form_fields SET "labelAr" = 'جديد' WHERE "id" = $1`, [fieldId])).toBeNull();
      const other = await newVersion(await newForm());
      expect(await refusal(`UPDATE request_form_fields SET "versionId" = $2 WHERE "id" = $1`, [fieldId, other])).toBe(CHECK_VIOLATION);

      await publish(versionId);
      expect(await refusal(`UPDATE request_form_fields SET "labelAr" = 'بعد النشر' WHERE "id" = $1`, [fieldId])).toBe(CHECK_VIOLATION);
      expect(await fieldRefusal(versionId, { key: 'late', position: 1 })).toBe(CHECK_VIOLATION);
    });

    it('may go with a published version nobody has filled, and never once a request has', async () => {
      const used = await liveForm([{ key: 'name' }]);
      const unused = await liveForm([{ key: 'name' }]);
      await addRequest({ formId: used.formId, formVersionId: used.versionId });
      expect(await refusal(`DELETE FROM request_form_fields WHERE "id" = $1`, [used.fieldIds[0]])).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM request_form_fields WHERE "id" = $1`, [unused.fieldIds[0]])).toBeNull();
    });
  });

  // ── requests on a form ───────────────────────────────────────────────────

  describe('a request on a form', () => {
    it('is filed against a published version of its own form, with both ids or neither', async () => {
      const live = await liveForm();
      const draft = await newVersion(await newForm());
      const draftForm = (await run(`SELECT "formId" FROM request_form_versions WHERE "id" = $1`, [draft])).rows[0].formId as string;

      expect(await requestRefusal({ formId: live.formId, formVersionId: live.versionId })).toBeNull();
      expect(await requestRefusal({ formId: draftForm, formVersionId: draft })).toBe(CHECK_VIOLATION); // a draft
      expect(await requestRefusal({ formId: (await liveForm()).formId, formVersionId: live.versionId })).toBe(CHECK_VIOLATION); // another form's version: the guard speaks first, the composite key behind it is the backstop
      expect(await requestRefusal({ formId: live.formId })).toBe(CHECK_VIOLATION); // a form with no version
      expect(await requestRefusal({ formVersionId: live.versionId })).toBe(CHECK_VIOLATION); // a version with no form
    });

    it('may carry no capacity, and still carries the rule that nothing it was filed with changes', async () => {
      const live = await liveForm();
      const id = await addRequest({ formId: live.formId, formVersionId: live.versionId, capacity: null });
      expect(await refusal(`UPDATE citizen_requests SET "applicantCapacity" = 'OWNER' WHERE "id" = $1`, [id])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE citizen_requests SET "formId" = $2 WHERE "id" = $1`, [id, (await liveForm()).formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE citizen_requests SET "status" = 'IN_REVIEW' WHERE "id" = $1`, [id])).toBeNull();
    });

    it('is never deleted, as before', async () => {
      const id = await addRequest();
      expect(await refusal(`DELETE FROM citizen_requests WHERE "id" = $1`, [id])).toBe(CHECK_VIOLATION);
    });

    it('keeps the one-open rule per citizen, type and card for requests on no form', async () => {
      const first = await addRequest({ type: 'SIGNAGE', citizen: otherCitizenId });
      expect(await requestRefusal({ type: 'SIGNAGE', citizen: otherCitizenId })).toBe(UNIQUE_VIOLATION);
      expect(await requestRefusal({ type: 'RENOVATION', citizen: otherCitizenId })).toBeNull();
      // Closing it frees the place.
      await run(`UPDATE citizen_requests SET "status" = 'CANCELLED', "cancelledAt" = now() WHERE "id" = $1`, [first]);
      expect(await requestRefusal({ type: 'SIGNAGE', citizen: otherCitizenId })).toBeNull();
    });

    it('keeps one open request per citizen and form, and lets two forms and a typed request sit together', async () => {
      const a = await liveForm();
      const b = await liveForm();
      const first = await addRequest({ formId: a.formId, formVersionId: a.versionId, citizen: otherCitizenId });
      expect(await requestRefusal({ formId: a.formId, formVersionId: a.versionId, citizen: otherCitizenId })).toBe(UNIQUE_VIOLATION);
      // A second form (both stored as OTHER), and the legacy «طلب عام», do not collide with it.
      expect(await requestRefusal({ formId: b.formId, formVersionId: b.versionId, citizen: otherCitizenId })).toBeNull();
      await addRequest({ type: 'OTHER', citizen: otherCitizenId });
      expect(await requestRefusal({ type: 'OTHER', citizen: otherCitizenId })).toBe(UNIQUE_VIOLATION);
      // Another citizen is free to file the same form.
      expect(await requestRefusal({ formId: a.formId, formVersionId: a.versionId })).toBeNull();
      await run(`UPDATE citizen_requests SET "status" = 'CANCELLED', "cancelledAt" = now() WHERE "id" = $1`, [first]);
      expect(await requestRefusal({ formId: a.formId, formVersionId: a.versionId, citizen: otherCitizenId })).toBeNull();
    });
  });

  // ── answers and papers ───────────────────────────────────────────────────

  describe('an answer', () => {
    it('is written for a question of its request’s own version, and never for a file question', async () => {
      const live = await liveForm([{ key: 'name' }, { key: 'photo', type: 'FILE' }]);
      const elsewhere = await liveForm([{ key: 'name' }]);
      const requestId = await addRequest({ formId: live.formId, formVersionId: live.versionId });

      expect(await refusal(...answerSql(requestId, live.fieldIds[0]!))).toBeNull();
      expect(await refusal(...answerSql(requestId, elsewhere.fieldIds[0]!))).toBe(CHECK_VIOLATION); // another version's question
      expect(await refusal(...answerSql(requestId, live.fieldIds[1]!))).toBe(CHECK_VIOLATION); // a file question
      // A request on no form takes none.
      expect(await refusal(...answerSql(await addRequest(), live.fieldIds[0]!))).toBe(CHECK_VIOLATION);
    });

    it('is answered once per question', async () => {
      const live = await liveForm([{ key: 'name' }]);
      const requestId = await addRequest({ formId: live.formId, formVersionId: live.versionId, citizen: otherCitizenId });
      await run(...answerSql(requestId, live.fieldIds[0]!));
      expect(await refusal(...answerSql(requestId, live.fieldIds[0]!))).toBe(UNIQUE_VIOLATION);
    });

    it('is a value, never JSON null, and is written once: no update, no delete', async () => {
      const live = await liveForm([{ key: 'name' }]);
      const requestId = await addRequest({ formId: live.formId, formVersionId: live.versionId });
      expect(await refusal(`INSERT INTO citizen_request_answers ("requestId", "fieldId", "value") VALUES ($1, $2, 'null'::jsonb)`, [requestId, live.fieldIds[0]])).toBe(CHECK_VIOLATION);
      const { rows } = await run(...answerSql(requestId, live.fieldIds[0]!));
      const answerId = rows[0].id as string;
      expect(await refusal(`UPDATE citizen_request_answers SET "value" = '"y"'::jsonb WHERE "id" = $1`, [answerId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`DELETE FROM citizen_request_answers WHERE "id" = $1`, [answerId])).toBe(CHECK_VIOLATION);
    });

    it('takes no more once the request is closed', async () => {
      const live = await liveForm([{ key: 'a' }, { key: 'b' }]);
      const requestId = await addRequest({ formId: live.formId, formVersionId: live.versionId });
      await run(...answerSql(requestId, live.fieldIds[0]!));
      await run(`UPDATE citizen_requests SET "status" = 'CANCELLED', "cancelledAt" = now() WHERE "id" = $1`, [requestId]);
      expect(await refusal(...answerSql(requestId, live.fieldIds[1]!))).toBe(CHECK_VIOLATION);
    });

    it.each(['citizen_request_answers', 'request_form_fields', 'request_form_versions'])('cannot be emptied by TRUNCATE on %s', async (table) => {
      expect(await refusal(`TRUNCATE "${table}" CASCADE`)).not.toBeNull();
    });
  });

  describe('a paper filed for a question', () => {
    it('names a FILE question of its request’s own version, or none', async () => {
      const live = await liveForm([{ key: 'name' }, { key: 'photo', type: 'FILE' }]);
      const elsewhere = await liveForm([{ key: 'photo', type: 'FILE' }]);
      const requestId = await addRequest({ formId: live.formId, formVersionId: live.versionId });

      expect(await refusal(...attachmentSql(requestId, null))).toBeNull(); // as every paper was before forms
      expect(await refusal(...attachmentSql(requestId, live.fieldIds[1]!))).toBeNull();
      expect(await refusal(...attachmentSql(requestId, live.fieldIds[0]!))).toBe(CHECK_VIOLATION); // not a file question
      expect(await refusal(...attachmentSql(requestId, elsewhere.fieldIds[0]!))).toBe(CHECK_VIOLATION); // another version's
      expect(await refusal(...attachmentSql(await addRequest(), live.fieldIds[1]!))).toBe(CHECK_VIOLATION); // a request on no form
    });
  });

  describe('0115: the dues check is a setting of a form', () => {
    it('is off by default, and on only for a form that requires a card', async () => {
      const formId = await newForm();
      expect((await run(`SELECT "requiresNoDues" FROM request_forms WHERE "id" = $1`, [formId])).rows[0].requiresNoDues).toBe(false);
      expect(await refusal(`UPDATE request_forms SET "requiresNoDues" = true WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_forms SET "requiresNoDues" = true, "propertyMode" = 'OPTIONAL' WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
      expect(await refusal(`UPDATE request_forms SET "requiresNoDues" = true, "propertyMode" = 'REQUIRED' WHERE "id" = $1`, [formId])).toBeNull();
    });

    it('cannot lose its card once the check is on', async () => {
      const formId = await newForm();
      await run(`UPDATE request_forms SET "requiresNoDues" = true, "propertyMode" = 'REQUIRED' WHERE "id" = $1`, [formId]);
      expect(await refusal(`UPDATE request_forms SET "propertyMode" = 'NONE' WHERE "id" = $1`, [formId])).toBe(CHECK_VIOLATION);
    });

    it('replays without a second copy of the constraint', async () => {
      const count = async () =>
        (await run(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'request_forms_dues_needs_property' AND connamespace = '"` + SCHEMA + `"'::regnamespace`)).rows[0].n;
      const before = await count();
      await run(readFileSync(join(__dirname, 'tenant/migrations/0115_request_form_dues_check/migration.sql'), 'utf8'));
      expect(before).toBe(1);
      expect(await count()).toBe(1);
    });
  });
});

/** The count of enum types the spec expects, so a type dropped from 0112 fails here rather than at a CHECK. */
describeIfDb('migration 0112: the enum types', () => {
  let ddl: Client;
  const SCHEMA_ENUMS = 'tenant_request_forms_enums_spec';

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA_ENUMS}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA_ENUMS);
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA_ENUMS}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  it('creates each type with the values the contract will name, in the order the form builder lists them', async () => {
    const { rows } = await ddl.query<{ name: string; labels: string[] }>(
      `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = $1 AND t.typname LIKE 'Request%'
        GROUP BY t.typname`,
      [SCHEMA_ENUMS],
    );
    const byName = new Map(rows.map((row) => [row.name, row.labels]));
    expect(byName.get('RequestFieldType')).toEqual([
      'SHORT_TEXT', 'LONG_TEXT', 'INTEGER', 'DECIMAL', 'DATE', 'PHONE', 'DOCUMENT_NUMBER', 'SINGLE_CHOICE', 'MULTI_CHOICE', 'YES_NO', 'FILE',
    ]);
    expect(byName.get('RequestPropertyMode')).toEqual(['NONE', 'OPTIONAL', 'REQUIRED']);
    expect(byName.get('RequestFormVersionStatus')).toEqual(['DRAFT', 'PUBLISHED']);
    expect(byName.get('RequestLinkedSource')).toEqual([
      'FIRST_NAME', 'FATHER_NAME', 'LAST_NAME', 'MOTHER_NAME', 'PHONE', 'IDENTITY_NUMBER', 'CIVIL_RECORD_NUMBER',
    ]);
    expect(byName.get('RequestAnswerOrigin')).toEqual(['ANSWERED', 'FROM_FILE']);
    // A رقم مرجعي is the citizen's credential and is not a source a form can link to.
    expect([...(byName.get('RequestLinkedSource') ?? [])].join(' ')).not.toMatch(/REFERENCE/);
  });

});
