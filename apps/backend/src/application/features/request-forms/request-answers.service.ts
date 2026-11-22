import { Injectable, Logger } from '@nestjs/common';
import {
  emptyLinkedFields,
  fileFields,
  linkedValueFor,
  parseAnswers,
  type OfferedRequestField,
  type OfferedRequestForm,
  type ParsedRequestAnswer,
  type RequestAttachmentType,
  type RequestFormFieldView,
  type RequestFormPrefill,
  type RequestPropertyMode,
  type RequestType,
} from '@mechanization/shared-schemas';
import { Prisma } from '../../../generated/tenant-client';
import { TenantContextService } from '../../../infrastructure/context/tenant-context.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/exceptions';
import { fieldView, type StoredField } from './request-form.plan';
import {
  CITIZEN_FILE_SELECT,
  citizenFileValues,
  normaliseOwnFields,
  sameTypedAnswers,
  type NormalisedOwnFields,
  type RequestOwnFields,
} from './request-answers.plan';

/** What a request on a form is filed with: the body's own words, before any check. */
export interface FormSubmissionInput extends RequestOwnFields {
  formId: string;
  formVersionId?: string;
  answers: Record<string, unknown>;
}

/** A request on a form, judged and ready to write. */
export interface ResolvedFormSubmission extends NormalisedOwnFields {
  formId: string;
  formVersionId: string;
  /** The built-in type a system form stands for (F1), else `OTHER`: what `citizen_requests.requestType` holds. */
  requestType: RequestType;
  formNameAr: string;
  fee: number;
  answers: ParsedRequestAnswer[];
  fieldIds: Map<string, string>;
}

/** Where a paper for a question goes (`paperTarget`). */
export interface PaperTarget {
  fieldId: string;
  type: RequestAttachmentType;
  maxFiles: number;
  accept: readonly string[];
  label: string;
}

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

/**
 * The request side of the request forms (migration 0113, docs/request-forms-plan.md §4–§5): which forms a citizen or a clerk is
 * offered, a request's answers judged and written with it, the questions' papers, and what a retried press compares.
 *
 * `CitizenRequestsService` only delegates here: its `submit` calls `resolveSubmission` inside its own transaction (the retry
 * key's lock, the one-open check and the «REQ-» number stay where they are) and `writeAnswers` after it has the request's id.
 * Every judgement is the shared `parseAnswers`, the one validator the screens also run; an answer is citizen PII and is never in
 * an error, a log line or an audit row.
 */
@Injectable()
export class RequestAnswersService {
  private readonly logger = new Logger(RequestAnswersService.name);

  constructor(private readonly tenantContext: TenantContextService) {}

  private get db() {
    return this.tenantContext.prisma;
  }

  // ─────────────────────────────  What is offered  ─────────────────────────────

  /**
   * The forms that are switched on, not archived and published, with their questions. For a citizen, each linked question
   * carries the file's value (their own, never another's), or null when the file holds nothing and the request would be refused.
   */
  async offeredForms(citizenId?: string): Promise<OfferedRequestForm[]> {
    const forms = await this.db.requestForm.findMany({
      where: { enabled: true, archivedAt: null, currentVersionId: { not: null } },
      orderBy: [{ sortOrder: 'asc' }, { nameAr: 'asc' }],
      select: {
        id: true,
        nameAr: true,
        nameEn: true,
        feeAmount: true,
        propertyMode: true,
        askCapacity: true,
        askPurpose: true,
        currentVersion: { select: { id: true, fields: { select: FIELD_SELECT, orderBy: { position: 'asc' } } } },
      },
    });
    const file = citizenId ? await this.citizenFile(citizenId) : null;
    const offered: OfferedRequestForm[] = [];
    for (const form of forms) {
      const version = form.currentVersion;
      if (!version) continue;
      const fields = this.readFields(version.id, version.fields as unknown as StoredField[]);
      if (!fields) continue;
      offered.push({
        id: form.id,
        versionId: version.id,
        nameAr: form.nameAr,
        nameEn: form.nameEn,
        feeAmount: Number(form.feeAmount),
        propertyMode: form.propertyMode as RequestPropertyMode,
        askCapacity: form.askCapacity,
        askPurpose: form.askPurpose,
        fields: fields.map((field): OfferedRequestField =>
          file && field.linkedSource !== null
            ? { ...field, linkedValue: linkedValueFor(field.linkedSource, citizenFileValues(file)) }
            : field,
        ),
      });
    }
    return offered;
  }

  /** The counter: what the chosen citizen's file holds for each linked question of the form. */
  async prefill(formId: string, citizenId: string): Promise<RequestFormPrefill> {
    const form = (await this.offeredForms(citizenId)).find((candidate) => candidate.id === formId);
    if (!form) throw new NotFoundError({ code: 'REQUEST_FORM_NOT_FOUND', message: 'This request form is not offered.' });
    const linkedValues: Record<string, string | null> = {};
    for (const field of form.fields) {
      if (field.linkedSource !== null) linkedValues[field.key] = field.linkedValue ?? null;
    }
    return { formId, citizenId, linkedValues };
  }

  // ─────────────────────────────  Filing  ─────────────────────────────

  /**
   * Judges a request on a form: the form is offered and the screen's version is its current one, the request's own fields fit
   * what the form asks, the citizen's file fills every linked question (F4), and every typed answer passes `parseAnswers`.
   * Throws the coded refusal; `details.issues` names fields and codes, never a value.
   */
  async resolveSubmission(input: FormSubmissionInput, citizenId: string): Promise<ResolvedFormSubmission> {
    const loaded = await this.loadOffered(input.formId);
    if (input.formVersionId && input.formVersionId !== loaded.versionId) {
      throw new ConflictError({
        code: 'REQUEST_FORM_VERSION_STALE',
        message: 'The form was republished after the screen loaded.',
      });
    }
    const own = normaliseOwnFields(loaded.form, input);
    if (own.propertyMissing) {
      throw new ValidationError({ code: 'REQUEST_PROPERTY_REQUIRED', message: 'This request names a property.' });
    }
    const file = await this.citizenFile(citizenId);
    const fileValues = file ? citizenFileValues(file) : {};
    const empty = emptyLinkedFields(loaded.fields, fileValues);
    if (empty.length > 0) {
      throw new ValidationError({
        code: 'REQUEST_FORM_LINKED_FIELD_EMPTY',
        message: 'The citizen file does not hold a value a question of this form copies from it.',
        params: { field: empty[0]!.labelAr },
        details: { fieldKeys: empty.map((field) => field.key) },
      });
    }
    const parsed = parseAnswers(loaded.fields, input.answers, fileValues);
    const issues = [...own.issues, ...(parsed.ok ? [] : parsed.issues)];
    if (issues.length > 0) {
      throw new ValidationError({ code: 'REQUEST_ANSWERS_INVALID', message: 'Some answers are missing or not valid.', details: { issues } });
    }
    return {
      ...own,
      formId: loaded.form.id,
      formVersionId: loaded.versionId,
      requestType: (loaded.form.systemType ?? 'OTHER') as RequestType,
      formNameAr: loaded.form.nameAr,
      fee: loaded.form.fee,
      answers: parsed.ok ? parsed.answers : [],
      fieldIds: new Map(loaded.fields.map((field) => [field.key, (field as RequestFormFieldView).id])),
    };
  }

  /** The answers' rows, written once with the request (`citizen_request_answers_guard`: never changed after). */
  async writeAnswers(requestId: string, resolved: ResolvedFormSubmission): Promise<void> {
    if (resolved.answers.length === 0) return;
    await this.db.citizenRequestAnswer.createMany({
      data: resolved.answers.map((answer) => ({
        requestId,
        fieldId: resolved.fieldIds.get(answer.fieldKey)!,
        value: answer.value as Prisma.InputJsonValue,
        origin: answer.origin,
      })),
    });
  }

  /**
   * A retry under a used key is the same request when the form, its version, the request's own fields and every typed answer
   * are the same. Linked answers are the file's snapshot and are not compared: the file may have been completed since.
   */
  async sameSubmission(
    row: {
      id: string;
      citizenId: string;
      formId: string | null;
      formVersionId: string | null;
      applicantCapacity: string | null;
      propertyEntryId: string | null;
      buildingUnitId: string | null;
      purpose: string | null;
    },
    input: FormSubmissionInput,
  ): Promise<boolean> {
    if (row.formId !== input.formId || !row.formVersionId) return false;
    if (input.formVersionId && input.formVersionId !== row.formVersionId) return false;
    const form = await this.db.requestForm.findUnique({
      where: { id: row.formId },
      select: { propertyMode: true, askCapacity: true, askPurpose: true },
    });
    if (!form) return false;
    const own = normaliseOwnFields(
      { propertyMode: form.propertyMode as RequestPropertyMode, askCapacity: form.askCapacity, askPurpose: form.askPurpose },
      input,
    );
    if (
      own.issues.length > 0 ||
      (row.applicantCapacity ?? null) !== own.applicantCapacity ||
      (row.propertyEntryId ?? null) !== own.propertyEntryId ||
      (row.buildingUnitId ?? null) !== own.buildingUnitId ||
      (row.purpose ?? null) !== own.purpose
    ) {
      return false;
    }
    const fields = await this.readVersion(row.formVersionId);
    if (!fields) return false;
    const file = await this.citizenFile(row.citizenId);
    const parsed = parseAnswers(fields, input.answers, file ? citizenFileValues(file) : {});
    // A linked question the file can no longer fill is no difference in what the person typed.
    const typed = parsed.ok ? parsed.answers : [];
    if (!parsed.ok && parsed.issues.some((issue) => issue.code !== 'LINKED_FIELD_EMPTY')) return false;
    const stored = await this.db.citizenRequestAnswer.findMany({
      where: { requestId: row.id },
      select: { value: true, origin: true, field: { select: { key: true } } },
    });
    return sameTypedAnswers(
      stored.map((answer) => ({ fieldKey: answer.field.key, value: answer.value, origin: answer.origin as 'ANSWERED' | 'FROM_FILE' })),
      parsed.ok ? typed : this.typedOnly(fields, input.answers),
    );
  }

  /** The typed answers of a body when the file leaves a linked question empty: parsed with that question set aside. */
  private typedOnly(fields: RequestFormFieldView[], raw: Record<string, unknown>): ParsedRequestAnswer[] {
    const answerable = fields.filter((field) => field.linkedSource === null);
    const result = parseAnswers(answerable, raw, {});
    return result.ok ? result.answers : [];
  }

  // ─────────────────────────────  The papers  ─────────────────────────────

  /** The question a paper answers, with the rules for it; refuses a key the request's version has no file question for. */
  async paperTarget(requestId: string, fieldKey: string, citizenId?: string): Promise<PaperTarget> {
    const request = await this.db.citizenRequest.findFirst({
      where: { id: requestId, ...(citizenId ? { citizenId } : {}) },
      select: { formVersionId: true },
    });
    if (!request) throw new NotFoundError({ code: 'REQUEST_NOT_FOUND', message: `Request ${requestId} was not found` });
    const fields = request.formVersionId ? await this.readVersion(request.formVersionId) : null;
    const field = fields ? fileFields(fields).find((candidate) => candidate.key === fieldKey) : undefined;
    if (!field) {
      throw new ValidationError({
        code: 'REQUEST_ANSWERS_INVALID',
        message: 'This request has no file question with that key.',
        details: { issues: [{ fieldKey, code: 'UNKNOWN_FIELD' }] },
      });
    }
    const id = (field as RequestFormFieldView).id;
    return { fieldId: id, type: field.config.attachmentType, maxFiles: field.config.maxFiles, accept: field.config.accept, label: field.labelAr };
  }

  /** The kind of file fits what the question accepts. */
  assertPaperKind(target: PaperTarget, mimeType: string): void {
    if (!target.accept.includes(mimeType)) {
      throw new ValidationError({
        code: 'REQUEST_ATTACHMENT_UNSUPPORTED',
        message: 'This question does not accept that kind of file.',
      });
    }
  }

  /** Papers already filed for a question, to hold the question's own limit. */
  async papersFiledFor(requestId: string, fieldId: string): Promise<number> {
    return this.db.citizenRequestAttachment.count({ where: { requestId, fieldId } });
  }

  /**
   * Every file question holds a paper (F4: every field is required). Refused with the first one missing; `details.fieldKeys`
   * names all. Asked when the fee is raised and when the request is approved, because a free form has no bill.
   */
  async assertPapers(requestId: string): Promise<void> {
    const request = await this.db.citizenRequest.findUnique({
      where: { id: requestId },
      select: { formVersionId: true, attachments: { select: { fieldId: true } } },
    });
    if (!request?.formVersionId) return;
    const fields = await this.readVersion(request.formVersionId);
    if (!fields) return;
    const held = new Set(request.attachments.map((attachment) => attachment.fieldId));
    const missing = fileFields(fields).filter((field) => !held.has((field as RequestFormFieldView).id));
    if (missing.length > 0) {
      throw new ValidationError({
        code: 'REQUEST_FORM_FILE_REQUIRED',
        message: 'A file question of this form holds no paper.',
        params: { field: missing[0]!.labelAr },
        details: { fieldKeys: missing.map((field) => field.key) },
      });
    }
  }

  /** What a form charges now. Not versioned (F2): the fee in force when the bill is raised (D1). */
  async feeOf(formId: string): Promise<number> {
    const form = await this.db.requestForm.findUnique({ where: { id: formId }, select: { feeAmount: true } });
    return form ? Number(form.feeAmount) : 0;
  }

  // ─────────────────────────────  Reading  ─────────────────────────────

  private async loadOffered(formId: string): Promise<{
    form: { id: string; nameAr: string; systemType: string | null; fee: number } & {
      propertyMode: RequestPropertyMode;
      askCapacity: boolean;
      askPurpose: boolean;
    };
    versionId: string;
    fields: RequestFormFieldView[];
  }> {
    const form = await this.db.requestForm.findUnique({
      where: { id: formId },
      select: {
        id: true,
        nameAr: true,
        systemType: true,
        feeAmount: true,
        enabled: true,
        archivedAt: true,
        propertyMode: true,
        askCapacity: true,
        askPurpose: true,
        currentVersionId: true,
      },
    });
    if (!form) throw new NotFoundError({ code: 'REQUEST_FORM_NOT_FOUND', message: 'This request form does not exist.' });
    if (!form.enabled || form.archivedAt !== null || !form.currentVersionId) {
      throw new ValidationError({ code: 'REQUEST_FORM_NOT_OFFERED', message: 'This request form is not offered.' });
    }
    const fields = await this.readVersion(form.currentVersionId);
    if (!fields) throw new ValidationError({ code: 'REQUEST_FORM_NOT_OFFERED', message: 'This request form is not offered.' });
    return {
      form: {
        id: form.id,
        nameAr: form.nameAr,
        systemType: form.systemType,
        fee: Number(form.feeAmount),
        propertyMode: form.propertyMode as RequestPropertyMode,
        askCapacity: form.askCapacity,
        askPurpose: form.askPurpose,
      },
      versionId: form.currentVersionId,
      fields,
    };
  }

  private async readVersion(versionId: string): Promise<RequestFormFieldView[] | null> {
    const rows = await this.db.requestFormField.findMany({
      where: { versionId },
      select: FIELD_SELECT,
      orderBy: { position: 'asc' },
    });
    return this.readFields(versionId, rows as unknown as StoredField[]);
  }

  /** The questions, validated again through the schema that wrote them; null when any no longer passes (never served half). */
  private readFields(versionId: string, rows: StoredField[]): RequestFormFieldView[] | null {
    const fields: RequestFormFieldView[] = [];
    for (const row of rows) {
      const view = fieldView(row);
      if (!view) {
        this.logger.warn(`a question of request form version ${versionId} no longer satisfies its schema`);
        return null;
      }
      fields.push(view);
    }
    return fields;
  }

  private citizenFile(citizenId: string) {
    return this.db.user.findFirst({ where: { id: citizenId, kind: 'CITIZEN', deletedAt: null }, select: CITIZEN_FILE_SELECT });
  }
}
