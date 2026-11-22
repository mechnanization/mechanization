import {
  REQUEST_FORM_MAX_FIELDS,
  requestFormFieldSchema,
  type RequestFormFieldDefinition,
  type RequestFormFieldView,
  type RequestType,
} from '@mechanization/shared-schemas';

/**
 * What the request form service decides, with no database: how a question is stored and read back, and when a form may be
 * deleted. Pure so each rule has a test that can fail only for its own reason (`request-form.plan.spec.ts`).
 */

/** A question as `request_form_fields` stores it (everything but the ids and the version). */
export interface FieldRow {
  key: string;
  position: number;
  type: RequestFormFieldDefinition['type'];
  labelAr: string;
  labelEn: string | null;
  helpAr: string | null;
  helpEn: string | null;
  config: Record<string, unknown>;
  linkedSource: RequestFormFieldDefinition['linkedSource'];
}

/** The row for a question at a position in its version. The array's order is the position: 0 to 39. */
export function fieldRow(field: RequestFormFieldDefinition, position: number): FieldRow {
  if (!Number.isInteger(position) || position < 0 || position >= REQUEST_FORM_MAX_FIELDS) {
    throw new RangeError(`a form takes ${REQUEST_FORM_MAX_FIELDS} questions: position ${position} is outside it`);
  }
  return {
    key: field.key,
    position,
    type: field.type,
    labelAr: field.labelAr,
    labelEn: field.labelEn ?? null,
    helpAr: field.helpAr ?? null,
    helpEn: field.helpEn ?? null,
    config: field.config as Record<string, unknown>,
    linkedSource: field.linkedSource,
  };
}

/** A stored question, read back through the same schema that wrote it. */
export interface StoredField extends FieldRow {
  id: string;
}

/**
 * The question as a screen reads it, or null when the stored row no longer satisfies the schema — a row written before a
 * rule tightened. The caller never serves a question it cannot validate against: it says so and skips the form.
 */
export function fieldView(row: StoredField): RequestFormFieldView | null {
  const parsed = requestFormFieldSchema.safeParse({
    key: row.key,
    type: row.type,
    labelAr: row.labelAr,
    labelEn: row.labelEn ?? undefined,
    helpAr: row.helpAr ?? undefined,
    helpEn: row.helpEn ?? undefined,
    config: row.config,
    linkedSource: row.linkedSource,
  });
  if (!parsed.success) return null;
  return { ...parsed.data, id: row.id, position: row.position };
}

/** Why a form is not deleted: a built-in one stands for a request type, and any form that has requests is kept (F7). */
export type DeleteRefusal = 'SYSTEM_FORM' | 'HAS_REQUESTS';

export function deleteRefusal(form: { systemType: RequestType | null; requestCount: number }): DeleteRefusal | null {
  if (form.systemType !== null) return 'SYSTEM_FORM';
  if (form.requestCount > 0) return 'HAS_REQUESTS';
  return null;
}

/** The first key that two questions share, or null. A refusal the schema makes too; the service asks again before it writes. */
export function firstDuplicateKey(fields: ReadonlyArray<{ key: string }>): string | null {
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.key)) return field.key;
    seen.add(field.key);
  }
  return null;
}

/**
 * Whether switching a form on is allowed: it needs a published version to offer, and an archived form is never offered.
 * `ARCHIVED` is told apart so the screen can say the form is gone, not unfinished.
 */
export type EnableRefusal = 'ARCHIVED' | 'NOT_PUBLISHED';

export function enableRefusal(form: { archivedAt: Date | null; currentVersionId: string | null }): EnableRefusal | null {
  if (form.archivedAt !== null) return 'ARCHIVED';
  if (form.currentVersionId === null) return 'NOT_PUBLISHED';
  return null;
}
