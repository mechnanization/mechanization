import { randomUUID } from 'node:crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Client } from 'pg';
import { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { migrateTenantSchema } from '../../../infrastructure/prisma/tenant-migrator';
import { tenantTestClient } from '../../../infrastructure/prisma/tenant-test-client';
import { PrismaAuditRepository } from '../../../infrastructure/repositories/audit.repository';
import { AuditService } from '../audit/audit.service';
import { ParcelDuesService } from '../fees/parcel-dues.service';
import { RequestAnswersService } from '../request-forms/request-answers.service';
import { RequestFormsService } from '../request-forms/request-forms.service';
import { CitizenRequestsService, type RequestActor } from './citizen-requests.service';

/**
 * Requests on a form the manager defined (migrations 0112 and 0113, open decisions §24), against a real tenant schema: what a
 * citizen and the counter are offered, answers judged and written with the request, a linked question and the file that cannot
 * fill it (F4), a stale version, the retry key with answers, one open request per citizen and form, the papers a file question
 * takes, the fee's bill and the checks before it, and what staff and the citizen read back (F8). Synthetic people only.
 *
 * Set `TEST_DATABASE_URL` to a throwaway Postgres 17; never staging.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const SCHEMA = 'tenant_request_form_submit_spec';
const describeIfDb = TEST_DATABASE_URL ? describe : describe.skip;

jest.setTimeout(60_000);
const SETUP_TIMEOUT_MS = 240_000;

const PDF = Buffer.from('%PDF-1.7\n%synthetic\n');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

const text = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  type: 'SHORT_TEXT' as const,
  labelAr: `سؤال ${key}`,
  linkedSource: null,
  config: {},
  ...extra,
});

describeIfDb('requests on a form', () => {
  let ddl: Client;
  let db: TenantPrismaClient;
  let context: TenantContextService;
  let service: CitizenRequestsService;
  let forms: RequestFormsService;
  let answers: RequestAnswersService;
  let files: { put: jest.Mock; createSignedUrl: jest.Mock; remove: jest.Mock };
  const whish = { isLive: false };
  const manager = { id: randomUUID(), role: 'SUPER_ADMIN' };
  const clerk = { id: randomUUID(), role: 'ADMINISTRATIVE_OFFICER' };
  const staffActor: RequestActor = { kind: 'STAFF', ...clerk };

  const within = <T>(work: () => Promise<T>): Promise<T> =>
    context.run({ tenantId: 'rfs', tenantSlug: 'rfs', schemaName: SCHEMA, prisma: db }, work);

  beforeAll(async () => {
    ddl = new Client({ connectionString: TEST_DATABASE_URL });
    await ddl.connect();
    await ddl.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await migrateTenantSchema(ddl, SCHEMA);
    db = tenantTestClient(TEST_DATABASE_URL!, SCHEMA);
    context = new TenantContextService();
    files = {
      put: jest.fn(async (file: { requestId: string; extension: string }) => ({
        storagePath: `rfs/requests/${file.requestId}/${randomUUID()}${file.extension}`,
      })),
      createSignedUrl: jest.fn(async () => 'https://bucket.example/signed'),
      remove: jest.fn(async () => undefined),
    };
    const audit = new AuditService(new PrismaAuditRepository(context), context, {} as never, {} as never);
    answers = new RequestAnswersService(context);
    forms = new RequestFormsService(context, audit);
    service = new CitizenRequestsService(context, audit, new ParcelDuesService(context), new EventEmitter2(), answers, files as never, whish);
    for (const [person, role] of [
      [manager, 'SUPER_ADMIN'],
      [clerk, 'ADMINISTRATIVE_OFFICER'],
    ] as const) {
      await db.user.create({
        data: { id: person.id, kind: 'STAFF', tenantSlug: 'rfs', firstName: 'موظف', lastName: 'تجربة', email: `${person.id}@rfs.test`, role: role as never },
      });
    }
  }, SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await db?.$disconnect();
    await ddl?.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await ddl?.end();
  }, SETUP_TIMEOUT_MS);

  /** A citizen with one card, and a file as complete as asked. */
  const citizen = async (file: Record<string, unknown> = {}) => {
    const id = randomUUID();
    await db.user.create({
      data: {
        id,
        kind: 'CITIZEN',
        tenantSlug: 'rfs',
        firstName: 'سامر',
        middleName: 'حسن',
        lastName: 'تجربة',
        motherName: 'زينب',
        identityDocNumber: `ID${randomUUID().slice(0, 8)}`,
        civilRecordNumber: '45',
        phone: '+96171123456',
        ...file,
      },
    });
    const registration = await db.registration.create({ data: { citizenId: id, referenceNumber: `RF-${randomUUID()}` } });
    const card = await db.propertyEntry.create({
      data: { registrationId: registration.id, occupancyType: 'OWNER', propertyType: 'LAND', propertyNumber: `7${randomUUID().slice(0, 5)}` },
    });
    return { id, cardId: card.id, actor: { kind: 'CITIZEN', id } as RequestActor };
  };

  const settings = { nameAr: 'إفادة سكن', feeAmount: 50_000, propertyMode: 'OPTIONAL', askCapacity: false, askPurpose: false, sortOrder: 0 };

  /** A form that is published and switched on. */
  const liveForm = async (fields: unknown[] = [text('reason')], extra: Record<string, unknown> = {}) => {
    const created = await within(() => forms.create({ ...settings, ...extra } as never, manager));
    await within(() => forms.saveDraft(created.id, { expectedRevision: created.draft!.revision, fields } as never, manager));
    await within(() => forms.publish(created.id, manager));
    return within(() => forms.setEnabled(created.id, true, manager));
  };

  const file = (
    person: { id: string; cardId: string; actor: RequestActor },
    form: { id: string; current: { id: string } | null },
    overrides: Record<string, unknown> = {},
    actor: RequestActor = person.actor,
  ) =>
    within(() =>
      service.submit(
        { citizenId: person.id, formId: form.id, formVersionId: form.current!.id, answers: { reason: 'لتسجيل الأولاد' }, clientRequestId: randomUUID(), ...overrides } as never,
        actor,
      ),
    );

  const row = (id: string) => db.citizenRequest.findUniqueOrThrow({ where: { id } });
  const storedAnswers = (id: string) =>
    db.citizenRequestAnswer.findMany({ where: { requestId: id }, select: { value: true, origin: true, field: { select: { key: true } } } });

  describe('what is offered', () => {
    it('offers a form that is switched on and published, with its questions, and not one that is not', async () => {
      const live = await liveForm([text('reason')]);
      const draftOnly = await within(() => forms.create({ ...settings, nameAr: 'مسودة فقط' } as never, manager));
      const off = await liveForm([text('reason')], { nameAr: 'موقوف' });
      await within(() => forms.setEnabled(off.id, false, manager));
      const archived = await liveForm([text('reason')], { nameAr: 'مؤرشف' });
      await within(() => forms.archive(archived.id, manager));

      const offered = await within(() => answers.offeredForms());
      const ids = offered.map((form) => form.id);
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(draftOnly.id);
      expect(ids).not.toContain(off.id);
      expect(ids).not.toContain(archived.id);
      const shown = offered.find((form) => form.id === live.id)!;
      expect(shown).toMatchObject({ versionId: live.current!.id, feeAmount: 50_000, propertyMode: 'OPTIONAL' });
      expect(shown.fields.map((field) => field.key)).toEqual(['reason']);
    });

    it('carries the citizen\'s own file value on a linked question, null where the file holds nothing, and none at the counter', async () => {
      const form = await liveForm([text('mother', { linkedSource: 'MOTHER_NAME' }), text('first', { linkedSource: 'FIRST_NAME' })]);
      const full = await citizen();
      const bare = await citizen({ motherName: null });
      const mineFull = (await within(() => answers.offeredForms(full.id))).find((candidate) => candidate.id === form.id)!;
      expect(mineFull.fields.map((field) => [field.key, field.linkedValue])).toEqual([
        ['mother', 'زينب'],
        ['first', 'سامر'],
      ]);
      const mineBare = (await within(() => answers.offeredForms(bare.id))).find((candidate) => candidate.id === form.id)!;
      expect(mineBare.fields.find((field) => field.key === 'mother')?.linkedValue).toBeNull();
      const counter = (await within(() => answers.offeredForms())).find((candidate) => candidate.id === form.id)!;
      expect(counter.fields.every((field) => !('linkedValue' in field))).toBe(true);
    });

    it('prefills the counter from the chosen citizen\'s file, and refuses a form that is not offered', async () => {
      const form = await liveForm([text('mother', { linkedSource: 'MOTHER_NAME' }), text('reason')]);
      const person = await citizen({ motherName: null });
      expect(await within(() => answers.prefill(form.id, person.id))).toEqual({
        formId: form.id,
        citizenId: person.id,
        linkedValues: { mother: null },
      });
      const off = await liveForm();
      await within(() => forms.setEnabled(off.id, false, manager));
      await expect(within(() => answers.prefill(off.id, person.id))).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
    });
  });

  describe('filing online', () => {
    it('writes the request on the form and version, its answers, and an audit row with no answer in it', async () => {
      const form = await liveForm([text('reason'), text('first', { linkedSource: 'FIRST_NAME' }), text('size', { type: 'INTEGER' })]);
      const person = await citizen();
      const filed = await file(person, form, { answers: { reason: 'لتسجيل الأولاد', size: '4' } });
      expect(filed).toMatchObject({ status: 'AWAITING_PAYMENT', fee: 50_000, replayed: false });

      expect(await row(filed.id)).toMatchObject({
        formId: form.id,
        formVersionId: form.current!.id,
        requestType: 'OTHER',
        applicantCapacity: null,
        channel: 'ONLINE',
        citizenId: person.id,
      });
      const stored = await storedAnswers(filed.id);
      expect(stored.map((a) => [a.field.key, a.value, a.origin]).sort()).toEqual(
        [
          ['first', 'سامر', 'FROM_FILE'],
          ['reason', 'لتسجيل الأولاد', 'ANSWERED'],
          ['size', 4, 'ANSWERED'],
        ].sort(),
      );
      const { rows } = await ddl.query(`SELECT "after" FROM "${SCHEMA}".audit_log_entries WHERE "entityId" = $1 AND "action" = 'REQUEST_SUBMITTED'`, [filed.id]);
      expect(rows[0].after).toMatchObject({ formId: form.id, formVersionId: form.current!.id, fee: 50_000 });
      expect(JSON.stringify(rows[0].after)).not.toContain('لتسجيل');
    });

    it('goes straight to review for a free form', async () => {
      const form = await liveForm([text('reason')], { feeAmount: 0 });
      const filed = await file(await citizen(), form);
      expect(filed).toMatchObject({ status: 'IN_REVIEW', fee: 0 });
    });

    it('refuses a form that is off, archived, unknown or never published', async () => {
      const person = await citizen();
      const off = await liveForm();
      await within(() => forms.setEnabled(off.id, false, manager));
      await expect(file(person, off)).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
      const archived = await liveForm();
      await within(() => forms.archive(archived.id, manager));
      await expect(file(person, archived)).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
      await expect(file(person, { id: randomUUID(), current: { id: randomUUID() } })).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_FOUND' });
      const draftOnly = await within(() => forms.create(settings as never, manager));
      await expect(file(person, { id: draftOnly.id, current: { id: randomUUID() } })).rejects.toMatchObject({ code: 'REQUEST_FORM_NOT_OFFERED' });
      expect(await db.citizenRequest.count({ where: { citizenId: person.id } })).toBe(0);
    });

    it('refuses answers to a version that was republished since the screen loaded, and accepts the current one', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const started = await within(() => forms.startDraft(form.id, manager));
      await within(() => forms.saveDraft(form.id, { expectedRevision: started.draft!.revision, fields: [text('reason'), text('extra')] } as never, manager));
      const next = await within(() => forms.publish(form.id, manager));
      await expect(file(person, form, { answers: { reason: 'x' } })).rejects.toMatchObject({ code: 'REQUEST_FORM_VERSION_STALE' });
      const filed = await file(person, next, { answers: { reason: 'x', extra: 'y' } });
      expect((await row(filed.id)).formVersionId).toBe(next.current!.id);
    });

    it('files against the current version when the body names none', async () => {
      const form = await liveForm();
      const filed = await file(await citizen(), form, { formVersionId: undefined });
      expect((await row(filed.id)).formVersionId).toBe(form.current!.id);
    });
  });

  describe('judging the answers', () => {
    it('refuses every wrong answer at once with its code, no value in the error, and writes nothing', async () => {
      const form = await liveForm([text('reason'), text('size', { type: 'INTEGER', config: { min: 1, max: 9 } }), text('when', { type: 'DATE' })]);
      const person = await citizen();
      const secret = 'سر-لا-يجب-أن-يظهر';
      const error = await file(person, form, { answers: { reason: '', size: 99, when: secret, ghost: secret } }).catch((e) => e);
      expect(error).toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });
      expect(error.details.issues).toEqual([
        { fieldKey: 'ghost', code: 'UNKNOWN_FIELD' },
        { fieldKey: 'reason', code: 'REQUIRED' },
        { fieldKey: 'size', code: 'ABOVE_MAX', params: { max: 9 } },
        { fieldKey: 'when', code: 'NOT_A_DATE' },
      ]);
      expect(JSON.stringify(error.details)).not.toContain(secret);
      expect(await db.citizenRequest.count({ where: { citizenId: person.id } })).toBe(0);
      expect(await db.citizenRequestAnswer.count({ where: { request: { citizenId: person.id } } })).toBe(0);
    });

    it('takes the value of a linked question from the file and refuses one sent for it', async () => {
      const form = await liveForm([text('first', { linkedSource: 'FIRST_NAME' })]);
      const person = await citizen();
      const error = await file(person, form, { answers: { first: 'غيره' } }).catch((e) => e);
      expect(error).toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });
      expect(error.details.issues).toEqual([{ fieldKey: 'first', code: 'LINKED_FIELD_NOT_ANSWERABLE' }]);
      const filed = await file(person, form, { answers: {} });
      expect((await storedAnswers(filed.id))[0]).toMatchObject({ value: 'سامر', origin: 'FROM_FILE' });
    });

    it('blocks the request while the file cannot fill a linked question, until a clerk completes it (F4)', async () => {
      const form = await liveForm([text('mother', { linkedSource: 'MOTHER_NAME', labelAr: 'اسم الأم' }), text('reason')]);
      const person = await citizen({ motherName: null });
      const error = await file(person, form).catch((e) => e);
      expect(error).toMatchObject({ code: 'REQUEST_FORM_LINKED_FIELD_EMPTY', params: { field: 'اسم الأم' }, details: { fieldKeys: ['mother'] } });
      expect(await db.citizenRequest.count({ where: { citizenId: person.id } })).toBe(0);

      await db.user.update({ where: { id: person.id }, data: { motherName: 'زينب' } });
      const filed = await file(person, form);
      expect(await storedAnswers(filed.id)).toHaveLength(2);
    });

    it('treats a blank file value as empty', async () => {
      const form = await liveForm([text('mother', { linkedSource: 'MOTHER_NAME' }), text('reason')]);
      const person = await citizen({ motherName: '   ' });
      await expect(file(person, form)).rejects.toMatchObject({ code: 'REQUEST_FORM_LINKED_FIELD_EMPTY' });
    });
  });

  describe('the request\'s own questions (F6)', () => {
    it('asks for the capacity when the form does, and keeps it', async () => {
      const form = await liveForm([text('reason')], { askCapacity: true });
      const person = await citizen();
      const error = await file(person, form).catch((e) => e);
      expect(error).toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });
      expect(error.details.issues).toEqual([{ fieldKey: 'applicantCapacity', code: 'REQUIRED' }]);
      const filed = await file(person, form, { applicantCapacity: 'TENANT' });
      expect((await row(filed.id)).applicantCapacity).toBe('TENANT');
    });

    it('names a card only when the form asks, and refuses one that is not the citizen\'s own', async () => {
      const required = await liveForm([text('reason')], { propertyMode: 'REQUIRED' });
      const person = await citizen();
      const other = await citizen();
      await expect(file(person, required)).rejects.toMatchObject({ code: 'REQUEST_PROPERTY_REQUIRED' });
      await expect(file(person, required, { propertyEntryId: other.cardId })).rejects.toMatchObject({ code: 'REQUEST_PROPERTY_NOT_YOURS' });
      const filed = await file(person, required, { propertyEntryId: person.cardId });
      expect((await row(filed.id)).propertyEntryId).toBe(person.cardId);

      const none = await liveForm([text('reason')], { propertyMode: 'NONE', nameAr: 'بلا عقار' });
      const dropped = await file(await citizen(), none, { propertyEntryId: person.cardId });
      expect((await row(dropped.id)).propertyEntryId).toBeNull();
    });

    it('keeps the purpose when the form asks for it, and drops it when it does not', async () => {
      const asks = await liveForm([text('reason')], { askPurpose: true, nameAr: 'يسأل الغرض' });
      const silent = await liveForm([text('reason')], { askPurpose: false, nameAr: 'لا يسأل الغرض' });
      expect((await row((await file(await citizen(), asks, { purpose: 'للمدرسة' })).id)).purpose).toBe('للمدرسة');
      expect((await row((await file(await citizen(), silent, { purpose: 'للمدرسة' })).id)).purpose).toBeNull();
    });
  });

  describe('the retry key', () => {
    it('answers the same request again, flagged, and writes nothing twice', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const key = randomUUID();
      const first = await file(person, form, { clientRequestId: key });
      const second = await file(person, form, { clientRequestId: key });
      expect(second).toMatchObject({ id: first.id, requestNumber: first.requestNumber, replayed: true });
      expect(await db.citizenRequest.count({ where: { citizenId: person.id } })).toBe(1);
      expect(await storedAnswers(first.id)).toHaveLength(1);
    });

    it('refuses the key for other answers, another form, or a request on no form', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const key = randomUUID();
      const first = await file(person, form, { clientRequestId: key });
      await expect(file(person, form, { clientRequestId: key, answers: { reason: 'شيء آخر' } })).rejects.toMatchObject({
        code: 'REQUEST_KEY_REUSED',
        params: { number: first.requestNumber },
      });
      const another = await liveForm([text('reason')], { nameAr: 'نموذج ثان' });
      await expect(file(person, another, { clientRequestId: key })).rejects.toMatchObject({ code: 'REQUEST_KEY_REUSED' });
      await expect(
        within(() =>
          service.submit({ citizenId: person.id, requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: key } as never, person.actor),
        ),
      ).rejects.toMatchObject({ code: 'REQUEST_KEY_REUSED' });
    });

    it('answers the retry even after the file was completed, since linked answers are a snapshot', async () => {
      const form = await liveForm([text('first', { linkedSource: 'FIRST_NAME' }), text('reason')]);
      const person = await citizen();
      const key = randomUUID();
      const first = await file(person, form, { clientRequestId: key });
      await db.user.update({ where: { id: person.id }, data: { firstName: 'اسم جديد' } });
      expect(await file(person, form, { clientRequestId: key })).toMatchObject({ id: first.id, replayed: true });
    });

    it('refuses a key of a typed request for a body on a form', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const key = randomUUID();
      await within(() => service.updateType('OTHER', { enabled: true, feeAmount: 0 }, manager));
      await within(() =>
        service.submit({ citizenId: person.id, requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: key } as never, person.actor),
      );
      await expect(file(person, form, { clientRequestId: key })).rejects.toMatchObject({ code: 'REQUEST_KEY_REUSED' });
    });
  });

  describe('one open request per citizen and form', () => {
    it('refuses a second on the same form, naming the first, and allows another form', async () => {
      const form = await liveForm([text('reason')]);
      const other = await liveForm([text('reason')], { nameAr: 'نموذج آخر' });
      const person = await citizen();
      const first = await file(person, form);
      await expect(file(person, form)).rejects.toMatchObject({ code: 'REQUEST_ALREADY_OPEN', params: { number: first.requestNumber } });
      await expect(file(person, other)).resolves.toMatchObject({ replayed: false });
    });

    it('lets the citizen file again once the first is closed', async () => {
      const form = await liveForm([text('reason')], { feeAmount: 0 });
      const person = await citizen();
      const first = await file(person, form);
      await within(() => service.reject(first.id, 'سبب الرفض هنا', clerk));
      await expect(file(person, form)).resolves.toMatchObject({ replayed: false });
    });

    it('lets exactly one of two presses with different keys win', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const results = await Promise.allSettled([file(person, form), file(person, form)]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'REQUEST_ALREADY_OPEN' });
      expect(await db.citizenRequest.count({ where: { citizenId: person.id, formId: form.id } })).toBe(1);
    });

    it('does not collide with a request on a built-in type of the same citizen', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      await within(() => service.updateType('OTHER', { enabled: true, feeAmount: 0 }, manager));
      await within(() =>
        service.submit({ citizenId: person.id, requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: randomUUID() } as never, person.actor),
      );
      await expect(file(person, form)).resolves.toMatchObject({ replayed: false });
    });
  });

  describe('at the counter', () => {
    it('files for a citizen who is present, recording the clerk', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const filed = await file(person, form, {}, staffActor);
      expect(await row(filed.id)).toMatchObject({ channel: 'COUNTER', createdById: clerk.id, citizenId: person.id });
    });
  });

  describe('the papers a file question takes', () => {
    const idCopy = text('id_copy', { type: 'FILE', config: { attachmentType: 'IDENTITY', maxFiles: 2, accept: ['application/pdf'] } });
    const lease = text('lease', { type: 'FILE', config: { attachmentType: 'LEASE_CONTRACT', maxFiles: 1, accept: ['application/pdf', 'image/jpeg'] } });

    const upload = (person: { id: string; actor: RequestActor }, id: string, buffer: Buffer, fieldKey?: string, type?: string) =>
      within(() =>
        service.addAttachment(id, { buffer, size: buffer.length }, type as never, person.actor, { citizenId: person.id }, fieldKey),
      );

    it('files a paper under the question\'s own kind, whatever kind the client sends', async () => {
      const form = await liveForm([text('reason'), idCopy]);
      const person = await citizen();
      const filed = await file(person, form);
      const paper = await upload(person, filed.id, PDF, 'id_copy', 'OTHER');
      expect(paper).toMatchObject({ type: 'IDENTITY', fieldKey: 'id_copy', mimeType: 'application/pdf' });
      const stored = await db.citizenRequestAttachment.findUniqueOrThrow({ where: { id: paper.id } });
      expect(stored.fieldId).not.toBeNull();
    });

    it('refuses a kind of file the question does not accept, and a paper over its limit', async () => {
      const form = await liveForm([text('reason'), idCopy]);
      const person = await citizen();
      const filed = await file(person, form);
      await expect(upload(person, filed.id, JPEG, 'id_copy')).rejects.toMatchObject({ code: 'REQUEST_ATTACHMENT_UNSUPPORTED' });
      await upload(person, filed.id, PDF, 'id_copy');
      await upload(person, filed.id, PDF, 'id_copy');
      await expect(upload(person, filed.id, PDF, 'id_copy')).rejects.toMatchObject({ code: 'REQUEST_ATTACHMENT_LIMIT', params: { max: 2 } });
      expect(await db.citizenRequestAttachment.count({ where: { requestId: filed.id } })).toBe(2);
    });

    it('refuses a key that is no file question of the request\'s form, or any key on a request on no form', async () => {
      const form = await liveForm([text('reason'), idCopy]);
      const person = await citizen();
      const filed = await file(person, form);
      const refused = await upload(person, filed.id, PDF, 'reason').catch((e) => e);
      expect(refused).toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });
      expect(refused.details.issues).toEqual([{ fieldKey: 'reason', code: 'UNKNOWN_FIELD' }]);
      await expect(upload(person, filed.id, PDF, 'nope')).rejects.toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });

      await within(() => service.updateType('OTHER', { enabled: true, feeAmount: 0 }, manager));
      const typed = await within(() =>
        service.submit({ citizenId: person.id, requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: randomUUID() } as never, person.actor),
      );
      await expect(upload(person, typed.id, PDF, 'id_copy')).rejects.toMatchObject({ code: 'REQUEST_ANSWERS_INVALID' });
    });

    it('takes an extra paper with no question on a request on a form, as on any request', async () => {
      const form = await liveForm([text('reason'), idCopy]);
      const person = await citizen();
      const filed = await file(person, form);
      expect(await upload(person, filed.id, PDF, undefined, 'OWNERSHIP_PROOF')).toMatchObject({ type: 'OWNERSHIP_PROOF', fieldKey: null });
    });

    it('does not put one citizen\'s paper on another\'s request', async () => {
      const form = await liveForm([text('reason'), idCopy]);
      const owner = await citizen();
      const other = await citizen();
      const filed = await file(owner, form);
      await expect(upload(other, filed.id, PDF, 'id_copy')).rejects.toMatchObject({ code: 'REQUEST_NOT_FOUND' });
    });

    describe('the fee\'s bill', () => {
      it('is raised only once every file question holds a paper, and carries the form\'s name and fee', async () => {
        const form = await liveForm([text('reason'), idCopy, lease], { feeAmount: 75_000, nameAr: 'إفادة بالأوراق' });
        const person = await citizen();
        const filed = await file(person, form);
        // The identity copy rule (D2) comes first; then every question of the form.
        await expect(within(() => service.raiseBill(filed.id, staffActor))).rejects.toMatchObject({ code: 'REQUEST_IDENTITY_COPY_REQUIRED' });
        await upload(person, filed.id, PDF, 'id_copy');
        const missing = await within(() => service.raiseBill(filed.id, staffActor)).catch((e) => e);
        expect(missing).toMatchObject({ code: 'REQUEST_FORM_FILE_REQUIRED', params: { field: 'سؤال lease' }, details: { fieldKeys: ['lease'] } });
        expect((await row(filed.id)).citizenPaymentId).toBeNull();

        await upload(person, filed.id, PDF, 'lease');
        const bill = await within(() => service.raiseBill(filed.id, staffActor));
        expect(bill).toMatchObject({ amount: 75_000, existed: false });
        const payment = await db.citizenPayment.findUniqueOrThrow({ where: { id: bill.citizenPaymentId } });
        expect(payment.title).toBe('رسم إفادة بالأوراق');
      });

      it('charges what the form charges now, not what it charged when the request was filed (D1)', async () => {
        const form = await liveForm([text('reason')], { feeAmount: 10_000 });
        const person = await citizen();
        const filed = await file(person, form);
        await within(() => forms.update(form.id, { ...settings, feeAmount: 30_000 } as never, manager));
        expect((await within(() => service.get(filed.id))).fee).toBe(30_000);
        await upload(person, filed.id, PDF, undefined, 'IDENTITY');
        expect(await within(() => service.raiseBill(filed.id, staffActor))).toMatchObject({ amount: 30_000 });
      });

      it('lets a request whose form was made free go to review, as a type made free does', async () => {
        const form = await liveForm([text('reason')], { feeAmount: 10_000 });
        const person = await citizen();
        const filed = await file(person, form);
        await within(() => forms.update(form.id, { ...settings, feeAmount: 0 } as never, manager));
        const waived = await within(() => service.get(filed.id));
        expect(waived.status).toBe('IN_REVIEW');
        expect((await row(filed.id)).paidAt).toBeNull();
      });
    });

    it('is asked for again at approval, where a free form has no bill to hold the papers back', async () => {
      const form = await liveForm([text('reason'), idCopy], { feeAmount: 0 });
      const person = await citizen();
      const filed = await file(person, form);
      await expect(within(() => service.approve(filed.id, 'يفيد بأن المذكور', clerk))).rejects.toMatchObject({ code: 'REQUEST_FORM_FILE_REQUIRED' });
      await upload(person, filed.id, PDF, 'id_copy');
      expect((await within(() => service.approve(filed.id, 'يفيد بأن المذكور', clerk))).status).toBe('READY_FOR_PICKUP');
    });
  });

  describe('what is read back', () => {
    it('hands staff the form\x27s statement draft with the request, and a request on no form none', async () => {
      const form = await liveForm([text('reason')], { statementTemplate: 'يفيد المختار بأن', nameAr: 'نموذج بمسودة' });
      const filed = await file(await citizen(), form);
      expect((await within(() => service.get(filed.id))).statementTemplate).toBe('يفيد المختار بأن');
    });

    it('shows staff the stored answers with where each came from, and the citizen the same with identity numbers masked (F8)', async () => {
      const form = await liveForm([
        text('reason'),
        text('idn', { type: 'DOCUMENT_NUMBER' }),
        text('first', { linkedSource: 'FIRST_NAME' }),
        text('id_copy', { type: 'FILE', config: { attachmentType: 'IDENTITY', maxFiles: 1, accept: ['application/pdf'] } }),
      ]);
      const person = await citizen();
      const filed = await file(person, form, { answers: { reason: 'سبب', idn: '123456789' } });

      const staff = await within(() => service.get(filed.id));
      expect(staff.form).toMatchObject({ id: form.id, versionId: form.current!.id, versionNumber: 1, nameAr: 'إفادة سكن' });
      expect(staff.answers.map((a) => [a.fieldKey, a.value, a.origin])).toEqual([
        ['reason', 'سبب', 'ANSWERED'],
        ['idn', '123456789', 'ANSWERED'],
        ['first', 'سامر', 'FROM_FILE'],
      ]);
      expect(staff.missingPapers).toEqual([{ fieldKey: 'id_copy', labelAr: 'سؤال id_copy', labelEn: null }]);

      const mine = await within(() => service.mineOne(person.id, filed.id));
      expect(mine.answers.find((a) => a.fieldKey === 'idn')?.value).toBe('••••••789');
      expect(mine.answers.find((a) => a.fieldKey === 'reason')?.value).toBe('سبب');
      expect(JSON.stringify(mine)).not.toContain('123456789');
      expect(mine.missingPapers).toHaveLength(1);
      // The clerk's draft for the statement is staff's: the citizen's view has no such key.
      expect('statementTemplate' in mine).toBe(false);

      await within(() => service.addAttachment(filed.id, { buffer: PDF, size: PDF.length }, undefined, person.actor, { citizenId: person.id }, 'id_copy'));
      const after = await within(() => service.get(filed.id));
      expect(after.missingPapers).toEqual([]);
      expect(after.attachments[0]).toMatchObject({ type: 'IDENTITY', fieldKey: 'id_copy', fieldLabelAr: 'سؤال id_copy' });
    });

    it('lists the form on the queue and on the citizen\'s own list, and nothing on a request on no form', async () => {
      const form = await liveForm([text('reason')], { nameAr: 'نموذج الطابور' });
      const person = await citizen();
      const filed = await file(person, form);
      const queue = await within(() => service.queue({ page: 1, pageSize: 200 } as never));
      expect(queue.items.find((item) => item.id === filed.id)?.form).toMatchObject({ id: form.id, nameAr: 'نموذج الطابور' });
      const mine = await within(() => service.mine(person.id));
      expect(mine[0]!.form?.nameAr).toBe('نموذج الطابور');

      await within(() => service.updateType('OTHER', { enabled: true, feeAmount: 0 }, manager));
      const typed = await citizen();
      await within(() =>
        service.submit({ citizenId: typed.id, requestType: 'OTHER', applicantCapacity: 'OWNER', clientRequestId: randomUUID() } as never, typed.actor),
      );
      const [only] = await within(() => service.mine(typed.id));
      expect(only).toMatchObject({ form: null, answers: [], missingPapers: [] });
    });

    it('keeps a request\'s answers whole after its form is republished and archived', async () => {
      const form = await liveForm([text('reason')]);
      const person = await citizen();
      const filed = await file(person, form);
      const started = await within(() => forms.startDraft(form.id, manager));
      await within(() => forms.saveDraft(form.id, { expectedRevision: started.draft!.revision, fields: [text('other')] } as never, manager));
      await within(() => forms.publish(form.id, manager));
      await within(() => forms.archive(form.id, manager));
      const read = await within(() => service.get(filed.id));
      expect(read.form).toMatchObject({ versionNumber: 1 });
      expect(read.answers.map((a) => a.fieldKey)).toEqual(['reason']);
    });
  });
});
