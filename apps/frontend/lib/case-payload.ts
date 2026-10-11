import type { CaseClearableField, CaseUpdateInput, CaseWriteInput } from './api-client';

/** The case form's fields as typed: every one a string, `''` for unanswered. */
export interface CaseFormValues {
  notes: string;
  propertyNumber: string;
  neighborhood: string;
  propertyType: string;
  buildingName: string;
  floor: string;
  side: string;
  landType: string;
  tentLocation: string;
}

/** The free-text place fields: typed by hand, and cleared by a PATCH with `null`. */
const PLACE_FIELDS: readonly CaseClearableField[] = [
  'propertyNumber',
  'neighborhood',
  'buildingName',
  'floor',
  'side',
  'tentLocation',
];

/**
 * The body of a new حالة: what was typed, trimmed, and a field left empty
 * left out — `createCaseSchema` takes no `null`, and there is nothing to clear.
 */
export function caseCreatePayload(values: CaseFormValues): CaseWriteInput {
  const body: CaseWriteInput = { notes: values.notes.trim() };
  for (const field of PLACE_FIELDS) {
    const value = values[field].trim();
    if (value) body[field] = value;
  }
  if (values.propertyType) body.propertyType = values.propertyType;
  if (values.landType) body.landType = values.landType;
  return body;
}

/**
 * The PATCH of a corrected حالة.
 *
 * Every place field is sent, an emptied one as `null`. Built like the create
 * body, an emptied field was left out of the PATCH, and the server leaves an
 * omitted field as it is — so a field could never be cleared, and changing
 * نوع العقار blanked «الطابق» on screen while it stayed on the case.
 *
 * `propertyType` and `landType` are sent only when chosen: the schema cannot
 * clear them, so a land type left from an earlier نوع العقار stays on file.
 */
export function caseUpdatePayload(values: CaseFormValues): CaseUpdateInput {
  const body: CaseUpdateInput = { notes: values.notes.trim() };
  for (const field of PLACE_FIELDS) body[field] = values[field].trim() || null;
  if (values.propertyType) body.propertyType = values.propertyType;
  if (values.landType) body.landType = values.landType;
  return body;
}
