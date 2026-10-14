import { CASE_FIELD_MAP } from '@mechanization/shared-schemas';
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

/** The fields that belong to one نوع العقار (`CASE_FIELD_MAP`); the rest apply to every case. */
const TYPE_FIELDS = ['buildingName', 'floor', 'side', 'landType', 'tentLocation'] as const;

/**
 * The form after نوع العقار is changed to `propertyType` (`''` is «غير معروف»).
 *
 * A field the new type does not carry is emptied, so a «الطابق ٣» typed under
 * BUILDING never rides along under LAND, and the save then clears it
 * (`caseUpdatePayload`). A field the new type carries too keeps its value: a
 * follow-up case logged from the census matrix has «اسم المبنى» and no type,
 * and choosing BUILDING for it used to blank the name — hidden until then — and
 * clear it on the server.
 */
export function valuesForPropertyType(previous: CaseFormValues, propertyType: string): CaseFormValues {
  const shown: readonly string[] = CASE_FIELD_MAP[propertyType as keyof typeof CASE_FIELD_MAP] ?? [];
  const next: CaseFormValues = { ...previous, propertyType };
  for (const field of TYPE_FIELDS) {
    if (!shown.includes(field)) next[field] = '';
  }
  return next;
}

/**
 * The PATCH of a corrected حالة.
 *
 * Every field is sent, an emptied one as `null`. Built like the create body, an
 * emptied field was left out of the PATCH, and the server leaves an omitted
 * field as it is — so a field could never be cleared, and changing نوع العقار
 * blanked «الطابق» on screen while it stayed on the case. «غير معروف» for نوع
 * العقار or نوع الأرض is sent as `null` too, so the type is cleared with the
 * fields that hung on it rather than left behind them.
 */
export function caseUpdatePayload(values: CaseFormValues): CaseUpdateInput {
  const body: CaseUpdateInput = { notes: values.notes.trim() };
  for (const field of PLACE_FIELDS) body[field] = values[field].trim() || null;
  body.propertyType = values.propertyType || null;
  body.landType = values.landType || null;
  return body;
}
