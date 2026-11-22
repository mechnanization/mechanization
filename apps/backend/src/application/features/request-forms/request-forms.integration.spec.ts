import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { RequestFormsService } from './request-forms.service';

/**
 * The manager's request forms against a real tenant schema (migrations 0112 and 0113; open decisions §24): the lifecycle
 * (create, draft, publish, enable, disable, archive, delete), the draft's revision check, every refusal with its code, the
 * audit row of every write, and the rule that a form somebody filed on is archived and never deleted (F7).
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_request_forms_service_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const settings = {
  nameAr: 'إفادة سكن',
  feeAmount: 50_000,
  propertyMode: 'OPTIONAL' as const,
  askCapacity: false,
  askPurpose: true,
  sortOrder: 0,
};

const text = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  type: 'SHORT_TEXT' as const,
  labelAr: `سؤال ${key}`,
  linkedSource: null,
  config: {},
  ...extra,
});

describeIfDb('request forms (the manager)', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let forms: RequestFormsService;
  const managerId = randomUUID();
  const manager = { id: managerId, role: 'SUPER_ADMIN' };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'rfs', tenantSlug: 'rfs', schemaName: SCHEMA, prisma: db }, work);

  const make = (extra: Record<string, unknown> = {}) => within(() => forms.create({ ...settings, ...extra } as never, manager));
  const save = (id: string, revision: number, fields: unknown[]) =>
    within(() => forms.saveDraft(id, { expectedRevision: revision, fields } as never, manager));
  /** A form with a published version of the given questions. */
  const published = async (fields: unknown[] = [text('reason')], extra: Record<string, unknown> = {}) => {
    const created = await make(extra);
    await save(created.id, created.draft!.revision, fields);
    return within(() => forms.publish(created.id, manager));
  };
  const actions = async (id: string): Promise<string[]> =>
    (await ddl.query(`SELECT "action" FROM "${SCHEMA}".audit_log_entries WHERE "entityType" = 'RequestForm' AND "entityId" = $1 ORDER BY "createdAt", "id"`, [id])).rows.map(
      (row) => row.action as string,
    );

  /** A request filed on the form's published version, written the way the migration's own spec writes one. */
  const fileRequest = async (formId: string, versionId: string): Promise<void> => {
    const citizen = randomUUID();
    await ddl.query(
      `INSERT INTO "${SCHEMA}".users ("id", "kind", "tenantSlug", "firstName", "lastName", "updatedAt") VALUES ($1, 'CITIZEN', 'rfs', 'مواطن', 'جديد', now())`,
      [citizen],
    );
    await ddl.query(
      `INSERT INTO "${SCHEMA}".citizen_requests ("requestNumber", "citizenId", "channel", "requestType", "applicantCapacity", "status", "formId", "formVersionId", "clientRequestId")
       VALUES ($1, $2, 'ONLINE', 'OTHER', NULL, 'AWAITING_PAYMENT', $3, $4, $5)`,
      [`REQ-${randomUUID().slice(0, 12)}`, citizen, formId, versionId, randomUUID()],
    );
  };

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    forms = new RequestFormsService(context, audit);
    await db.user.create({
      data: { id: managerId, kind: 'STAFF', tenantSlug: 'rfs', email: `${managerId}@rfs.gov.lb`, firstName: 'مدير', lastName: 'البلدية', role: 'SUPER_ADMIN' as never },
    });
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  describe('creating', () => {
    it('makes a form that is switched off, with an empty first draft', async () => {
      const form = await make();
      expect(form).toMatchObject({
        nameAr: 'إفادة سكن',
        feeAmount: 50_000,
        enabled: false,
        propertyMode: 'OPTIONAL',
        askPurpose: true,
        systemType: null,
        archivedAt: null,
        current: null,
        requestCount: 0,
      });
      expect(form.draft).toMatchObject({ versionNumber: 1, status: 'DRAFT', revision: 1, fields: [] });
      expect(await actions(form.id)).toEqual(['REQUEST_FORM_CREATED']);
    });

    it('writes the audit row with the settings and no question text', async () => {
      const form = await make({ statementTemplate: 'يفيد المختار بأن' });
      const { rows } = await ddl.query(`SELECT "after" FROM "${SCHEMA}".audit_log_entries WHERE "entityId" = $1`, [form.id]);
      expect(rows[0].after).toMatchObject({ nameAr: 'إفادة سكن', feeAmount: 50_000, hasTemplate: true });
      expect(JSON.stringify(rows[0].after)).not.toContain('يفيد المختار');
    });

    it('lists it with its counts', async () => {
      const form = await make({ nameAr: 'نموذج للقائمة' });
      const item = (await within(() => forms.list())).find((row) => row.id === form.id);
      expect(item).toMatchObject({ nameAr: 'نموذج للقائمة', enabled: false, fieldCount: 0, hasDraft: true, requestCount: 0, archivedAt: null });
    });
  });

  describe('updating the settings', () => {
    it('changes the settings and audits before and after', async () => {
      const form = await make();
      const updated = await within(() => forms.update(form.id, { ...settings, nameAr: 'اسم جديد', feeAmount: 75_000, nameEn: 'New' } as never, manager));
      expect(updated).toMatchObject({ nameAr: 'اسم جديد', nameEn: 'New', feeAmount: 75_000 });
      const { rows } = await ddl.query(`SELECT "before", "after" FROM "${SCHEMA}".audit_log_entries WHERE "entityId" = $1 AND "action" = 'REQUEST_FORM_UPDATED'`, [form.id]);
      expect(rows[0].before).toMatchObject({ nameAr: 'إفادة سكن', feeAmount: 50_000 });
      expect(rows[0].after).toMatchObject({ nameAr: 'اسم جديد', feeAmount: 75_000 });
    });

    it('does not find a form that does not exist', async () => {
      await expect(within(() => forms.update(randomUUID(), settings as never, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
      await expect(within(() => forms.get(randomUUID()))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
    });
  });

  describe('the draft', () => {
    it('saves the questions in order and counts the revision up', async () => {
      const form = await make();
      const saved = await save(form.id, 1, [text('b'), text('a', { type: 'YES_NO' })]);
      expect(saved.draft?.revision).toBe(2);
      expect(saved.draft?.fields.map((field) => [field.key, field.position, field.type])).toEqual([
        ['b', 0, 'SHORT_TEXT'],
        ['a', 1, 'YES_NO'],
      ]);
    });

    it('replaces the questions whole, so a removed one is gone', async () => {
      const form = await make();
      await save(form.id, 1, [text('a'), text('b'), text('c')]);
      const saved = await save(form.id, 2, [text('c')]);
      expect(saved.draft?.fields.map((field) => field.key)).toEqual(['c']);
    });

    it('refuses a save from a stale screen, and leaves the draft as the other save made it', async () => {
      const form = await make();
      await save(form.id, 1, [text('first')]);
      await expect(save(form.id, 1, [text('second')])).rejects.toMatchObject({ code: 'REQUEST_FORM_EDIT_CONFLICT' });
      expect((await within(() => forms.get(form.id))).draft?.fields.map((field) => field.key)).toEqual(['first']);
    });

    it('lets exactly one of two saves of one revision win when they race', async () => {
      const form = await make();
      const results = await Promise.allSettled([save(form.id, 1, [text('x')]), save(form.id, 1, [text('y')])]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const lost = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: 'REQUEST_FORM_EDIT_CONFLICT' });
    });

    it('refuses two questions with one key, naming it', async () => {
      const form = await make();
      await expect(save(form.id, 1, [text('a'), text('a')])).rejects.toMatchObject({
        code: 'REQUEST_FORM_FIELD_KEY_TAKEN',
        params: { key: 'a' },
      });
    });

    it('keeps a choice question, a linked question and a file question as defined', async () => {
      const form = await make();
      const saved = await save(form.id, 1, [
        text('kind', { type: 'SINGLE_CHOICE', config: { choices: [{ key: 'a', labelAr: 'أ' }, { key: 'b', labelAr: 'ب' }] } }),
        text('first_name', { linkedSource: 'FIRST_NAME' }),
        text('id_copy', { type: 'FILE', config: { attachmentType: 'IDENTITY', maxFiles: 2, accept: ['application/pdf'] } }),
      ]);
      expect(saved.draft?.fields).toMatchObject([
        { key: 'kind', config: { choices: [{ key: 'a' }, { key: 'b' }] } },
        { key: 'first_name', linkedSource: 'FIRST_NAME' },
        { key: 'id_copy', config: { attachmentType: 'IDENTITY', maxFiles: 2, accept: ['application/pdf'] } },
      ]);
    });

    it('audits ids and counts, never a question', async () => {
      const form = await make();
      await save(form.id, 1, [text('secret_looking_key', { labelAr: 'سؤال خاص جداً' })]);
      const { rows } = await ddl.query(`SELECT "after" FROM "${SCHEMA}".audit_log_entries WHERE "entityId" = $1 AND "action" = 'REQUEST_FORM_DRAFT_SAVED'`, [form.id]);
      expect(rows[0].after).toMatchObject({ revision: 2, fieldCount: 1 });
      expect(JSON.stringify(rows[0].after)).not.toContain('سؤال خاص');
      expect(JSON.stringify(rows[0].after)).not.toContain('secret_looking_key');
    });
  });

  describe('publishing', () => {
    it('freezes the draft as the current version', async () => {
      const form = await published([text('reason')]);
      expect(form.draft).toBeNull();
      expect(form.current).toMatchObject({ versionNumber: 1, status: 'PUBLISHED' });
      expect(form.current?.publishedAt).not.toBeNull();
      expect(form.current?.fields.map((field) => field.key)).toEqual(['reason']);
      expect(await actions(form.id)).toEqual(['REQUEST_FORM_CREATED', 'REQUEST_FORM_DRAFT_SAVED', 'REQUEST_FORM_PUBLISHED']);
    });

    it('refuses a draft with no questions, with the issue in details', async () => {
      const form = await make();
      await expect(within(() => forms.publish(form.id, manager))).rejects.toMatchObject({
        code: 'REQUEST_FORM_NOT_PUBLISHABLE',
        details: { issues: [{ code: 'NO_FIELDS' }] },
      });
      expect((await within(() => forms.get(form.id))).current).toBeNull();
    });

    it('refuses a second publish: there is no draft left', async () => {
      const form = await published();
      await expect(within(() => forms.publish(form.id, manager))).rejects.toMatchObject({
        code: 'REQUEST_FORM_NOT_PUBLISHABLE',
        details: { issues: [{ code: 'NO_DRAFT' }] },
      });
    });

    it('refuses a save into a draft that was published meanwhile', async () => {
      const form = await make();
      await save(form.id, 1, [text('a')]);
      await within(() => forms.publish(form.id, manager));
      await expect(save(form.id, 2, [text('b')])).rejects.toMatchObject({ code: 'REQUEST_FORM_EDIT_CONFLICT' });
    });

    it('never lets a published version change under the database\'s guard', async () => {
      const form = await published();
      await expect(ddl.query(`UPDATE "${SCHEMA}".request_form_versions SET "revision" = 99 WHERE "id" = $1`, [form.current!.id])).rejects.toMatchObject({ code: '23514' });
    });
  });

  describe('editing a published form', () => {
    it('starts a draft that is a copy of the published questions, numbered after the last version', async () => {
      const form = await published([text('a'), text('b', { type: 'YES_NO' })]);
      const started = await within(() => forms.startDraft(form.id, manager));
      expect(started.draft).toMatchObject({ versionNumber: 2, status: 'DRAFT', revision: 1 });
      expect(started.draft?.fields.map((field) => [field.key, field.type])).toEqual([
        ['a', 'SHORT_TEXT'],
        ['b', 'YES_NO'],
      ]);
      expect(started.current?.versionNumber).toBe(1);
    });

    it('answers the draft that exists instead of starting a second', async () => {
      const form = await published();
      const first = await within(() => forms.startDraft(form.id, manager));
      const again = await within(() => forms.startDraft(form.id, manager));
      expect(again.draft?.id).toBe(first.draft?.id);
      expect(await actions(form.id)).toEqual(['REQUEST_FORM_CREATED', 'REQUEST_FORM_DRAFT_SAVED', 'REQUEST_FORM_PUBLISHED', 'REQUEST_FORM_DRAFT_STARTED']);
    });

    it('leaves the published version as it was while the draft is edited, and publishes it as version two', async () => {
      const form = await published([text('a')]);
      const started = await within(() => forms.startDraft(form.id, manager));
      await save(form.id, started.draft!.revision, [text('a'), text('b')]);
      const mid = await within(() => forms.get(form.id));
      expect(mid.current?.fields.map((field) => field.key)).toEqual(['a']);
      const after = await within(() => forms.publish(form.id, manager));
      expect(after.current).toMatchObject({ versionNumber: 2 });
      expect(after.current?.fields.map((field) => field.key)).toEqual(['a', 'b']);
      expect(after.draft).toBeNull();
    });

    it('keeps the version a request was filled against exactly as it was', async () => {
      const form = await published([text('a')]);
      await fileRequest(form.id, form.current!.id);
      const started = await within(() => forms.startDraft(form.id, manager));
      await save(form.id, started.draft!.revision, [text('z')]);
      await within(() => forms.publish(form.id, manager));
      const { rows } = await ddl.query(`SELECT "key" FROM "${SCHEMA}".request_form_fields WHERE "versionId" = $1`, [form.current!.id]);
      expect(rows.map((row) => row.key)).toEqual(['a']);
    });
  });

  describe('switching on and off', () => {
    it('refuses to switch on a form that was never published', async () => {
      const form = await make();
      await expect(within(() => forms.setEnabled(form.id, true, manager))).rejects.toMatchObject({
        code: 'REQUEST_FORM_NOT_PUBLISHABLE',
        details: { issues: [{ code: 'NOT_PUBLISHED' }] },
      });
    });

    it('switches a published form on and off, one audit row each', async () => {
      const form = await published();
      expect((await within(() => forms.setEnabled(form.id, true, manager))).enabled).toBe(true);
      expect((await within(() => forms.setEnabled(form.id, false, manager))).enabled).toBe(false);
      expect((await actions(form.id)).slice(-2)).toEqual(['REQUEST_FORM_ENABLED', 'REQUEST_FORM_DISABLED']);
    });

    it('is quiet when the form is already as asked: no second row', async () => {
      const form = await published();
      await within(() => forms.setEnabled(form.id, true, manager));
      await within(() => forms.setEnabled(form.id, true, manager));
      expect((await actions(form.id)).filter((action) => action === 'REQUEST_FORM_ENABLED')).toHaveLength(1);
    });
  });

  describe('archiving (F7)', () => {
    it('switches the form off and keeps it, with its requests', async () => {
      const form = await published();
      await within(() => forms.setEnabled(form.id, true, manager));
      await fileRequest(form.id, form.current!.id);
      const archived = await within(() => forms.archive(form.id, manager));
      expect(archived).toMatchObject({ enabled: false, requestCount: 1 });
      expect(archived.archivedAt).not.toBeNull();
      expect((await actions(form.id)).at(-1)).toBe('REQUEST_FORM_ARCHIVED');
    });

    it('is quiet the second time', async () => {
      const form = await published();
      await within(() => forms.archive(form.id, manager));
      await within(() => forms.archive(form.id, manager));
      expect((await actions(form.id)).filter((action) => action === 'REQUEST_FORM_ARCHIVED')).toHaveLength(1);
    });

    it('is never offered, edited, switched on or given a draft again', async () => {
      const form = await published();
      await within(() => forms.archive(form.id, manager));
      await expect(within(() => forms.setEnabled(form.id, true, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
      await expect(within(() => forms.update(form.id, settings as never, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
      await expect(within(() => forms.startDraft(form.id, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
    });
  });

  describe('deleting', () => {
    it('removes a form nobody filed on, with its versions and questions', async () => {
      const form = await published([text('a'), text('b')]);
      await within(() => forms.remove(form.id, manager));
      await expect(within(() => forms.get(form.id))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
      const { rows } = await ddl.query(`SELECT count(*)::int AS n FROM "${SCHEMA}".request_form_versions WHERE "formId" = $1`, [form.id]);
      expect(rows[0].n).toBe(0);
      expect((await actions(form.id)).at(-1)).toBe('REQUEST_FORM_DELETED');
    });

    it('removes a form that was never published', async () => {
      const form = await make();
      await within(() => forms.remove(form.id, manager));
      await expect(within(() => forms.get(form.id))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
    });

    it('refuses a form that has a request, and keeps everything', async () => {
      const form = await published();
      await fileRequest(form.id, form.current!.id);
      await expect(within(() => forms.remove(form.id, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_HAS_REQUESTS', params: { count: 1 } });
      const kept = await within(() => forms.get(form.id));
      expect(kept.current?.fields).toHaveLength(1);
      expect(kept.requestCount).toBe(1);
    });

    it('refuses a built-in form even with no request', async () => {
      // 0114 made a system form of every built-in type.
      const { rows } = await ddl.query(`SELECT "id" FROM "${SCHEMA}".request_forms WHERE "systemType" = 'VACANCY'`);
      await expect(within(() => forms.remove(rows[0].id, manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_SYSTEM' });
      expect((await within(() => forms.get(rows[0].id))).systemType).toBe('VACANCY');
    });

    it('does not find a form that is not there', async () => {
      await expect(within(() => forms.remove(randomUUID(), manager))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
    });
  });

  describe('the list', () => {
    it('counts the questions of the current version, not the draft\'s, and the requests filed', async () => {
      const form = await published([text('a'), text('b')]);
      await fileRequest(form.id, form.current!.id);
      const started = await within(() => forms.startDraft(form.id, manager));
      await save(form.id, started.draft!.revision, [text('a')]);
      const item = (await within(() => forms.list())).find((row) => row.id === form.id);
      expect(item).toMatchObject({ fieldCount: 2, hasDraft: true, requestCount: 1 });
    });

    it('is empty-safe', async () => {
      await expect(within(() => forms.list())).resolves.toBeInstanceOf(Array);
    });
  });
});
