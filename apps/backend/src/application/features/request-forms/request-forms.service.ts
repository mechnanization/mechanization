import { Injectable, Logger } from '@nestjs/common';
import {
  formPublishIssues,
  type CreateRequestFormInput,
  type RequestFormFieldView,
  type RequestFormListItem,
  type RequestFormVersionView,
  type RequestFormView,
  type RequestPropertyMode,
  type RequestType,
  type SaveRequestFormDraftInput,
  type UpdateRequestFormInput,
} from '@mechanization/shared-schemas';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { runInTenantTransaction } from '../../../infrastructure/context/tenant-transaction';
import { tenantSchemaRef } from '../../../infrastructure/prisma/tenant-schema-ref';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { AuditService } from '../audit/audit.service';
import { deleteRefusal, enableRefusal, fieldRow, fieldView, firstDuplicateKey, type StoredField } from './request-form.plan';

type Actor = { id: string; role: string };

const FIELD_SELECT = {
  id: true,
  key: true,
  position: true,
  type: true,
  labelAr: true,
  labelEn: true,
  helpAr: true,
  helpEn: true,
  config: true,
  linkedSource: true,
} as const;

const VERSION_SELECT = {
  id: true,
  versionNumber: true,
  status: true,
  revision: true,
  publishedAt: true,
  fields: { select: FIELD_SELECT, orderBy: { position: 'asc' as const } },
} as const;

type VersionRow = {
  id: string;
  versionNumber: number;
  status: string;
  revision: number;
  publishedAt: Date | null;
  fields: Array<Record<string, unknown>>;
};

type FormRow = {
  id: string;
  nameAr: string;
  nameEn: string | null;
  feeAmount: { toString(): string };
  enabled: boolean;
  propertyMode: string;
  askCapacity: boolean;
  askPurpose: boolean;
  statementTemplate: string | null;
  systemType: string | null;
  sortOrder: number;
  archivedAt: Date | null;
  currentVersionId: string | null;
  updatedAt: Date;
};

/** What the audit row records of a form: its settings, never a question's text and never a person. */
function auditedSettings(form: FormRow) {
  return {
    nameAr: form.nameAr,
    nameEn: form.nameEn,
    feeAmount: Number(form.feeAmount),
    enabled: form.enabled,
    propertyMode: form.propertyMode,
    askCapacity: form.askCapacity,
    askPurpose: form.askPurpose,
    hasTemplate: form.statementTemplate !== null,
    sortOrder: form.sortOrder,
  };
}

/**
 * «نماذج الإفادات» — the manager's request forms (migrations 0112 and 0113, docs/request-forms-plan.md, open decisions §24).
 *
 * A form is edited as a DRAFT version and published once; a published version never changes (F2), so a request keeps the
 * questions its citizen answered. Every write takes the form's row lock first, so two managers saving or publishing
 * together are serialised and the second is told (`REQUEST_FORM_EDIT_CONFLICT`) instead of overwriting the first. Every
 * write is one transaction with its Tier 1 audit row, ids and counts only: a question's words are the municipality's own
 * and never go to the trail.
 *
 * The manager alone writes (`REQUEST_SETTINGS_ROLES`); staff who read requests read the forms (`REQUEST_READ_ROLES`).
 * Submitting a request on a form is `CitizenRequestsService`'s, which only delegates to the answers service.
 */
@Injectable()
export class RequestFormsService {
  private readonly logger = new Logger(RequestFormsService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  private get S() {
    return tenantSchemaRef(this.tenantContext.schemaName);
  }

  // ─────────────────────────────  Reads  ─────────────────────────────

  async list(): Promise<RequestFormListItem[]> {
    const forms = (await this.db.requestForm.findMany({
      orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
    })) as unknown as FormRow[];
    if (forms.length === 0) return [];

    const ids = forms.map((form) => form.id);
    const [fieldCounts, drafts, requestCounts] = await Promise.all([
      this.db.requestFormField.groupBy({
        by: ['versionId'],
        where: { version: { formId: { in: ids } } },
        _count: { _all: true },
      }),
      this.db.requestFormVersion.findMany({ where: { formId: { in: ids }, status: 'DRAFT' }, select: { formId: true } }),
      this.db.citizenRequest.groupBy({ by: ['formId'], where: { formId: { in: ids } }, _count: { _all: true } }),
    ]);
    const fieldsOfVersion = new Map(fieldCounts.map((row) => [row.versionId, row._count._all]));
    const draftForms = new Set(drafts.map((row) => row.formId));
    const requestsOfForm = new Map(requestCounts.map((row) => [row.formId, row._count._all]));

    return forms.map((form) => ({
      id: form.id,
      nameAr: form.nameAr,
      nameEn: form.nameEn,
      feeAmount: Number(form.feeAmount),
      enabled: form.enabled,
      systemType: form.systemType as RequestType | null,
      archivedAt: form.archivedAt?.toISOString() ?? null,
      fieldCount: form.currentVersionId ? (fieldsOfVersion.get(form.currentVersionId) ?? 0) : 0,
      hasDraft: draftForms.has(form.id),
      requestCount: requestsOfForm.get(form.id) ?? 0,
      updatedAt: form.updatedAt.toISOString(),
    }));
  }

  async get(id: string): Promise<RequestFormView> {
    const form = (await this.db.requestForm.findUnique({ where: { id } })) as unknown as FormRow | null;
    if (!form) throw this.notFound();
    return this.view(form);
  }

  // ─────────────────────────────  Writes  ─────────────────────────────

  /** A new form: switched off, with an empty first draft. The questions are saved next. */
  async create(input: CreateRequestFormInput, actor: Actor): Promise<RequestFormView> {
    const id = await runInTenantTransaction(this.tenantContext, async () => {
      const created = (await this.db.requestForm.create({
        data: {
          nameAr: input.nameAr,
          nameEn: input.nameEn ?? null,
          feeAmount: input.feeAmount,
          enabled: false,
          propertyMode: input.propertyMode as never,
          askCapacity: input.askCapacity,
          askPurpose: input.askPurpose,
          statementTemplate: input.statementTemplate ?? null,
          sortOrder: input.sortOrder,
          createdById: actor.id,
          updatedById: actor.id,
        },
      })) as unknown as FormRow;
      await this.db.requestFormVersion.create({
        data: { formId: created.id, versionNumber: 1, status: 'DRAFT', revision: 1, createdById: actor.id },
      });
      await this.record(actor, 'REQUEST_FORM_CREATED', created.id, null, auditedSettings(created));
      return created.id;
    });
    return this.get(id);
  }

  /**
   * The form's own settings: its name, fee, property and capacity questions, and the statement draft. Not versioned (F2).
   * A system form keeps what its type has always asked (the card, the capacity, the purpose): those three are not changed here.
   */
  async update(id: string, input: UpdateRequestFormInput, actor: Actor): Promise<RequestFormView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const before = await this.lock(id);
      this.refuseArchived(before);
      const fixed = before.systemType !== null;
      const after = (await this.db.requestForm.update({
        where: { id },
        data: {
          nameAr: input.nameAr,
          nameEn: input.nameEn ?? null,
          feeAmount: input.feeAmount,
          ...(fixed
            ? {}
            : { propertyMode: input.propertyMode as never, askCapacity: input.askCapacity, askPurpose: input.askPurpose }),
          statementTemplate: input.statementTemplate ?? null,
          sortOrder: input.sortOrder,
          updatedById: actor.id,
        },
      })) as unknown as FormRow;
      await this.record(actor, 'REQUEST_FORM_UPDATED', id, auditedSettings(before), auditedSettings(after));
    });
    return this.get(id);
  }

  /**
   * «تعديل النموذج»: a draft to edit. Answered with the one that exists, or a new one that starts as a copy of the published
   * version's questions, numbered after the last version.
   */
  async startDraft(id: string, actor: Actor): Promise<RequestFormView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      this.refuseArchived(form);
      this.refuseSystem(form);
      const existing = await this.db.requestFormVersion.findFirst({ where: { formId: id, status: 'DRAFT' }, select: { id: true } });
      if (existing) return;

      const latest = await this.db.requestFormVersion.findFirst({
        where: { formId: id },
        orderBy: { versionNumber: 'desc' },
        select: { versionNumber: true },
      });
      const current = form.currentVersionId
        ? await this.db.requestFormField.findMany({
            where: { versionId: form.currentVersionId },
            select: FIELD_SELECT,
            orderBy: { position: 'asc' },
          })
        : [];
      const draft = await this.db.requestFormVersion.create({
        data: {
          formId: id,
          versionNumber: (latest?.versionNumber ?? 0) + 1,
          status: 'DRAFT',
          revision: 1,
          createdById: actor.id,
        },
      });
      if (current.length > 0) {
        await this.db.requestFormField.createMany({
          data: current.map((row) => ({
            versionId: draft.id,
            key: row.key,
            position: row.position,
            type: row.type,
            labelAr: row.labelAr,
            labelEn: row.labelEn,
            helpAr: row.helpAr,
            helpEn: row.helpEn,
            config: row.config ?? {},
            linkedSource: row.linkedSource,
          })),
        });
      }
      await this.record(actor, 'REQUEST_FORM_DRAFT_STARTED', id, null, {
        versionId: draft.id,
        versionNumber: draft.versionNumber,
        fieldCount: current.length,
      });
    });
    return this.get(id);
  }

  /**
   * The draft's questions, saved whole, in order. `expectedRevision` is the revision the editor read: a draft saved since is
   * refused, and so is a save when the draft was published meanwhile (there is none to save into).
   */
  async saveDraft(id: string, input: SaveRequestFormDraftInput, actor: Actor): Promise<RequestFormView> {
    const duplicate = firstDuplicateKey(input.fields);
    if (duplicate !== null) {
      throw new ValidationError({
        code: 'REQUEST_FORM_FIELD_KEY_TAKEN',
        message: 'Two questions of one form have the same key.',
        params: { key: duplicate },
      });
    }
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      this.refuseArchived(form);
      this.refuseSystem(form);
      const draft = await this.db.requestFormVersion.findFirst({
        where: { formId: id, status: 'DRAFT' },
        select: { id: true, revision: true },
      });
      if (!draft || draft.revision !== input.expectedRevision) {
        throw new ConflictError({
          code: 'REQUEST_FORM_EDIT_CONFLICT',
          message: 'The draft was saved by someone else, or published, since it was opened.',
        });
      }
      await this.db.requestFormField.deleteMany({ where: { versionId: draft.id } });
      if (input.fields.length > 0) {
        await this.db.requestFormField.createMany({
          data: input.fields.map((field, index) => {
            const row = fieldRow(field, index);
            return { ...row, versionId: draft.id, type: row.type as never, linkedSource: row.linkedSource as never, config: row.config as never };
          }),
        });
      }
      await this.db.requestFormVersion.update({ where: { id: draft.id }, data: { revision: draft.revision + 1 } });
      await this.db.requestForm.update({ where: { id }, data: { updatedById: actor.id } });
      await this.record(actor, 'REQUEST_FORM_DRAFT_SAVED', id, null, {
        versionId: draft.id,
        revision: draft.revision + 1,
        fieldCount: input.fields.length,
      });
    });
    return this.get(id);
  }

  /** The draft becomes the version new requests fill, and is frozen. Refused while it has nothing to ask or two questions share a key. */
  async publish(id: string, actor: Actor): Promise<RequestFormView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      this.refuseArchived(form);
      this.refuseSystem(form);
      const draft = (await this.db.requestFormVersion.findFirst({
        where: { formId: id, status: 'DRAFT' },
        select: VERSION_SELECT,
      })) as unknown as VersionRow | null;
      if (!draft) {
        throw new ValidationError({
          code: 'REQUEST_FORM_NOT_PUBLISHABLE',
          message: 'There is no draft to publish.',
          details: { issues: [{ code: 'NO_DRAFT' }] },
        });
      }
      const fields = this.fieldsOf(draft);
      if (fields === null) {
        throw new ValidationError({
          code: 'REQUEST_FORM_NOT_PUBLISHABLE',
          message: 'A question of the draft is not valid.',
          details: { issues: [{ code: 'INVALID_FIELD' }] },
        });
      }
      const issues = formPublishIssues(fields);
      if (issues.length > 0) {
        throw new ValidationError({
          code: 'REQUEST_FORM_NOT_PUBLISHABLE',
          message: 'The draft cannot be published yet.',
          details: { issues },
        });
      }
      await this.db.requestFormVersion.update({
        where: { id: draft.id },
        data: { status: 'PUBLISHED', publishedAt: new Date(), publishedById: actor.id },
      });
      await this.db.requestForm.update({ where: { id }, data: { currentVersionId: draft.id, updatedById: actor.id } });
      await this.record(actor, 'REQUEST_FORM_PUBLISHED', id, null, {
        versionId: draft.id,
        versionNumber: draft.versionNumber,
        fieldCount: fields.length,
      });
    });
    return this.get(id);
  }

  /** Switch a form on (offered to citizens and the counter) or off (hidden from new requests; the ones filed stay as they are, F7). */
  async setEnabled(id: string, enabled: boolean, actor: Actor): Promise<RequestFormView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      if (form.enabled === enabled) return;
      if (enabled) {
        const refusal = enableRefusal(form);
        if (refusal) {
          throw new ValidationError({
            code: refusal === 'ARCHIVED' ? 'REQUEST_FORM_NOT_OFFERED' : 'REQUEST_FORM_NOT_PUBLISHABLE',
            message: refusal === 'ARCHIVED' ? 'An archived form is never offered.' : 'Publish the form before switching it on.',
            ...(refusal === 'NOT_PUBLISHED' ? { details: { issues: [{ code: 'NOT_PUBLISHED' }] } } : {}),
          });
        }
      }
      await this.db.requestForm.update({ where: { id }, data: { enabled, updatedById: actor.id } });
      await this.record(actor, enabled ? 'REQUEST_FORM_ENABLED' : 'REQUEST_FORM_DISABLED', id, { enabled: !enabled }, { enabled });
    });
    return this.get(id);
  }

  /** A form that was used is archived, never deleted (F7): switched off and kept, with its requests and their answers. */
  async archive(id: string, actor: Actor): Promise<RequestFormView> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      if (form.archivedAt !== null) return;
      // A built-in form is switched off, never archived: archiving is final, and the type would be gone for good.
      this.refuseSystem(form);
      await this.db.requestForm.update({
        where: { id },
        data: { archivedAt: new Date(), archivedById: actor.id, enabled: false, updatedById: actor.id },
      });
      await this.record(actor, 'REQUEST_FORM_ARCHIVED', id, { enabled: form.enabled }, { enabled: false, archived: true });
    });
    return this.get(id);
  }

  /** Deletes a form nobody ever filed: its questions, its versions, then the form. Refused for a built-in form and for any with requests. */
  async remove(id: string, actor: Actor): Promise<void> {
    await runInTenantTransaction(this.tenantContext, async () => {
      const form = await this.lock(id);
      const requestCount = await this.db.citizenRequest.count({ where: { formId: id } });
      const refusal = deleteRefusal({ systemType: form.systemType as RequestType | null, requestCount });
      if (refusal === 'SYSTEM_FORM') {
        throw new ConflictError({ code: 'REQUEST_FORM_SYSTEM', message: 'A built-in form stands for a request type and is never deleted.' });
      }
      if (refusal === 'HAS_REQUESTS') {
        throw new ConflictError({
          code: 'REQUEST_FORM_HAS_REQUESTS',
          message: 'Requests were filed on this form, so it is archived instead of deleted.',
          params: { count: requestCount },
        });
      }
      await this.db.requestFormField.deleteMany({ where: { version: { formId: id } } });
      await this.db.requestFormVersion.deleteMany({ where: { formId: id } });
      await this.db.requestForm.delete({ where: { id } });
      await this.record(actor, 'REQUEST_FORM_DELETED', id, auditedSettings(form), null);
    });
  }

  // ─────────────────────────────  Helpers  ─────────────────────────────

  /** The form's row, locked until the transaction ends: the one writer at a time of its versions and settings. */
  private async lock(id: string): Promise<FormRow> {
    await this.db.$queryRaw`SELECT 1 FROM ${this.S}"request_forms" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const form = (await this.db.requestForm.findUnique({ where: { id } })) as unknown as FormRow | null;
    if (!form) throw this.notFound();
    return form;
  }

  /** A system form (F1) keeps its type's questions and is never archived or deleted: it is switched on and off. */
  private refuseSystem(form: FormRow): void {
    if (form.systemType !== null) {
      throw new ConflictError({ code: 'REQUEST_FORM_SYSTEM', message: 'A built-in form keeps its own questions and is never archived or deleted.' });
    }
  }

  private refuseArchived(form: FormRow): void {
    if (form.archivedAt !== null) {
      throw new ValidationError({ code: 'REQUEST_FORM_NOT_OFFERED', message: 'An archived form is not edited.' });
    }
  }

  private notFound(): NotFoundError {
    return new NotFoundError({ code: 'REQUEST_FORM_NOT_FOUND', message: 'This request form does not exist.' });
  }

  private async record(actor: Actor, action: string, id: string, before: unknown, after: unknown): Promise<void> {
    await this.audit.recordInTransaction({
      actorId: actor.id,
      actorType: 'STAFF',
      actorRole: actor.role as never,
      action,
      entityType: 'RequestForm',
      entityId: id,
      ...(before ? { before: before as Record<string, unknown> } : {}),
      ...(after ? { after: after as Record<string, unknown> } : {}),
    });
  }

  /** A version's questions, validated; null when a stored row no longer passes (never served half). */
  private fieldsOf(version: VersionRow): RequestFormFieldView[] | null {
    const out: RequestFormFieldView[] = [];
    for (const row of version.fields) {
      const view = fieldView(row as unknown as StoredField);
      if (!view) {
        this.logger.warn(`a question of request form version ${version.id} no longer satisfies its schema`);
        return null;
      }
      out.push(view);
    }
    return out;
  }

  private versionView(version: VersionRow | null): RequestFormVersionView | null {
    if (!version) return null;
    return {
      id: version.id,
      versionNumber: version.versionNumber,
      status: version.status as RequestFormVersionView['status'],
      revision: version.revision,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      fields: this.fieldsOf(version) ?? [],
    };
  }

  private async view(form: FormRow): Promise<RequestFormView> {
    const [current, draft, requestCount] = await Promise.all([
      form.currentVersionId
        ? this.db.requestFormVersion.findUnique({ where: { id: form.currentVersionId }, select: VERSION_SELECT })
        : Promise.resolve(null),
      this.db.requestFormVersion.findFirst({ where: { formId: form.id, status: 'DRAFT' }, select: VERSION_SELECT }),
      this.db.citizenRequest.count({ where: { formId: form.id } }),
    ]);
    return {
      id: form.id,
      nameAr: form.nameAr,
      nameEn: form.nameEn,
      feeAmount: Number(form.feeAmount),
      enabled: form.enabled,
      propertyMode: form.propertyMode as RequestPropertyMode,
      askCapacity: form.askCapacity,
      askPurpose: form.askPurpose,
      statementTemplate: form.statementTemplate,
      systemType: form.systemType as RequestType | null,
      sortOrder: form.sortOrder,
      archivedAt: form.archivedAt?.toISOString() ?? null,
      current: this.versionView(current as unknown as VersionRow | null),
      draft: this.versionView(draft as unknown as VersionRow | null),
      requestCount,
      updatedAt: form.updatedAt.toISOString(),
    };
  }
}
