import { arabicOrLatinName, getLabels, internationalPhone } from '@mechanization/shared-schemas';
import type { CitizenFormData, CitizenProfile } from '@/lib/api-client';
import type { CitizenEditableField } from '@/lib/citizen-field-edit';
import { formatDate } from '@/lib/dates';
import { row, type CompareRow } from './compare-table';

/** The rows of one name, as the three parts the register stores. */
export const NAME_FIELDS: readonly CitizenEditableField[] = ['firstName', 'middleName', 'lastName'];

export type EditableRow = 'name' | 'motherName' | 'phone';

export const ROW_FIELDS: Record<EditableRow, readonly CitizenEditableField[]> = {
  name: NAME_FIELDS,
  motherName: ['motherName'],
  phone: ['phone'],
};

/** Whether a blank was deliberate — an officer's «غير مؤكَّد» on this very field. */
function isExcused(form: CitizenFormData, field: CitizenEditableField): boolean {
  return (form.flags ?? []).some((flag) => flag.path === `personal.${field}` || flag.path === `contact.${field}`);
}

/**
 * The one field's worth of validation this screen does before it asks the
 * server.
 *
 * The *same* schemas the form and the server use — not a second set of rules
 * that agree today. A name is `arabicOrLatinName`, a phone is
 * `internationalPhone`, and the parsed output is what gets sent, so «٧٠ ١٢٣ ٤٥٦»
 * is stored the way every other phone on the register is.
 */
export function validateField(
  field: CitizenEditableField,
  value: string,
  form: CitizenFormData,
): { ok: true; value: string } | { ok: false; message: string } {
  const raw = value.trim();
  if (!raw) {
    // A blank an officer explicitly marked «غير مؤكَّد» is a legitimate state of
    // the record; a blank nobody accounted for is not one this screen creates.
    return isExcused(form, field)
      ? { ok: true, value: '' }
      : { ok: false, message: 'هذا الحقل مطلوب' };
  }
  const schema = field === 'phone' ? internationalPhone : arabicOrLatinName;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'قيمة غير صالحة' };
  }
  return { ok: true, value: parsed.data };
}

export function citizenRows(
  a: CitizenProfile,
  b: CitizenProfile,
  locale: string,
  /** `qualityCompare.rows`: the words for the facts that are not a form field's. */
  t: (key: string) => string,
): CompareRow[] {
  const labels = getLabels(locale);
  const field = labels.citizenField;
  // A phone is the same phone however it was typed.
  const digits = (value: unknown) => String(value ?? '').replace(/\D/g, '');

  const household = (person: CitizenProfile) =>
    person.actualHouseholdMembers == null && person.totalRegisteredMembers == null
      ? null
      : `${person.actualHouseholdMembers ?? '—'} / ${person.totalRegisteredMembers ?? '—'}`;

  const properties = (person: CitizenProfile) =>
    person.registrations.reduce((total, registration) => total + registration.properties.length, 0);

  const enumValue = (map: Record<string, string>, value: string | null) =>
    value ? (map[value] ?? value) : null;

  return [
    row('name', t('fullName'), a.fullName, b.fullName),
    row('motherName', field.motherName, a.motherName, b.motherName),
    row('phone', field.phone, a.phone, b.phone, digits),
    row('whatsapp', field.whatsapp, a.whatsapp, b.whatsapp, digits),
    row('reference', t('reference'), a.referenceNumber, b.referenceNumber),
    row('civilRecord', field.civilRecordNumber, a.civilRecordNumber, b.civilRecordNumber),
    row(
      'residence',
      t('fileType'),
      enumValue(labels.citizenResidence as Record<string, string>, a.residence ?? null),
      enumValue(labels.citizenResidence as Record<string, string>, b.residence ?? null),
    ),
    row(
      'gender',
      field.gender,
      enumValue(labels.gender as Record<string, string>, a.gender),
      enumValue(labels.gender as Record<string, string>, b.gender),
    ),
    row('nationality', field.nationality, a.nationality, b.nationality),
    row(
      'residentStatus',
      field.residentStatus,
      enumValue(labels.residentStatus as Record<string, string>, a.residentStatus),
      enumValue(labels.residentStatus as Record<string, string>, b.residentStatus),
    ),
    row(
      'maritalStatus',
      field.maritalStatus,
      enumValue(labels.maritalStatus as Record<string, string>, a.maritalStatus),
      enumValue(labels.maritalStatus as Record<string, string>, b.maritalStatus),
    ),
    row(
      'household',
      t('household'),
      household(a),
      household(b),
    ),
    row('properties', t('properties'), properties(a), properties(b)),
    row(
      'registeredAt',
      t('registeredAt'),
      formatDate(a.registeredAt),
      formatDate(b.registeredAt),
    ),
    row(
      'active',
      t('recordState'),
      a.isActive ? t('active') : t('deactivated'),
      b.isActive ? t('active') : t('deactivated'),
    ),
  ];
}
