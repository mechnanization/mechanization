import { getLabels } from '@mechanization/shared-schemas';

/**
 * What an audit action is called, in words a clerk recognises.
 *
 * The audit page carried its own map of nineteen actions, written when those
 * were the nineteen that existed. The register has recorded twenty-five
 * distinct actions since, and the missing ones — `BUILDING_CREATED`,
 * `LANDLORD_LINKED`, `OCCUPANCY_RECORDED` among them — fell through to their
 * raw constant. «OCCUPANCY_RECORDED» on an Arabic screen is not a label, it is
 * an apology.
 *
 * So the map lives here instead, beside nothing, and both the whole-portal
 * trail and a single record's history read from it.
 *
 * An unknown action still falls back to its own code rather than to something
 * vague like «إجراء». A code somebody can search the source for beats a word
 * that tells them nothing.
 */
export function auditActionLabel(action: string, locale: string): string {
  const en = locale === 'en';
  const map: Record<string, [ar: string, en: string]> = {
    // ── the register ──
    REGISTRATION_SUBMITTED: ['تقديم طلب', 'Submission'],
    REGISTRATION_RESUBMITTED: ['إعادة تقديم بعد التصحيح', 'Resubmission'],
    STATUS_CHANGE: ['تغيير حالة', 'Status change'],
    CITIZEN_CREATED: ['تسجيل مواطن', 'Citizen registered'],
    CITIZEN_UPDATED: ['تعديل بيانات مواطن', 'Citizen updated'],
    CITIZEN_DELETED: ['حذف مواطن', 'Citizen deleted'],
    CITIZEN_DEACTIVATED: ['إلغاء تفعيل مواطن', 'Citizen deactivated'],
    HOUSEHOLD_LINKED: ['ربط أسرة', 'Household linked'],
    LANDLORD_LINKED: ['ربط مالك بمستأجر', 'Owner linked'],
    LANDLORD_LINK_UPDATED: ['تعديل ربط المالك', 'Owner link updated'],
    LANDLORD_UNLINKED: ['إلغاء ربط المالك', 'Owner unlinked'],
    LANDLORD_MATCH_DISMISSED: ['استبعاد تطابق مالك', 'Owner match dismissed'],
    LANDLORD_MATCH_RESTORED: ['إعادة تطابق مالك', 'Owner match restored'],
    LANDLORD_TENANCY_ENDED: ['إنهاء إيجار من بطاقة المالك', 'Tenancy ended from owner card'],
    TENANCY_ENDED: ['إنهاء إيجار', 'Tenancy ended'],

    // ── buildings and their units ──
    BUILDING_CREATED: ['إنشاء مبنى', 'Building created'],
    BUILDING_UPDATED: ['تعديل مبنى', 'Building updated'],
    BUILDING_DELETED: ['حذف مبنى', 'Building deleted'],
    BUILDING_UNITS_GENERATED: ['توليد وحدات المبنى', 'Units generated'],
    BUILDING_CODE_RECOMPUTED: ['إعادة احتساب رمز المبنى', 'Building code recomputed'],
    UNIT_UPDATED: ['تعديل وحدة', 'Unit updated'],
    UNIT_DELETED: ['حذف وحدة', 'Unit deleted'],
    UNIT_VISIT_LOGGED: ['تسجيل زيارة وحدة', 'Unit visit logged'],
    UNIT_VACANCY_CONFIRMED: ['تأكيد شغور وحدة', 'Vacancy confirmed'],
    UNIT_VACANCY_ENDED: ['إلغاء تأكيد الشغور', 'Vacancy confirmation undone'],
    UNIT_STATUS_AFTER_TENANCY: ['حالة الوحدة بعد الإيجار', 'Unit status after tenancy'],
    OCCUPANCY_RECORDED: ['تسجيل إشغال', 'Occupancy recorded'],
    OCCUPANCY_ENDED: ['إنهاء إشغال', 'Occupancy ended'],

    // ── cases and money ──
    CASE_CREATED: ['فتح حالة', 'Case opened'],
    CASE_RESOLVED: ['إقفال حالة', 'Case resolved'],
    CASE_RESOLVED_WITH_CITIZEN: ['إقفال حالة بربط مواطن', 'Case resolved with citizen'],
    CASE_DELETED: ['حذف حالة', 'Case deleted'],
    PAYMENT_DECLARED: ['تصريح بدفعة', 'Payment declared'],
    INSPECTOR_PAYOUT_RECORDED: ['تسجيل مستحقات مساح', 'Inspector payout recorded'],

    // ── land ──
    ZONE_CREATED: ['إنشاء قطاع', 'Create sector'],
    ZONE_UPDATED: ['تعديل قطاع', 'Update sector'],
    ZONE_DELETED: ['حذف قطاع', 'Delete sector'],
    CADASTRE_IMPORT: ['استيراد خريطة', 'Cadastre import'],

    // ── the portal itself ──
    LOGIN: ['تسجيل دخول', 'Login'],
    DOCUMENT_VIEW: ['فتح مرفق', 'View document'],
    CSV_EXPORT: ['تصدير CSV', 'Export CSV'],
    SETTINGS_UPDATED: ['تعديل إعدادات البلدية', 'Settings updated'],
    STAFF_CREATED: ['إنشاء حساب موظف', 'Create staff'],
    STAFF_UPDATED: ['تعديل حساب موظف', 'Update staff'],
    STAFF_DEACTIVATED: ['إلغاء تفعيل موظف', 'Deactivate staff'],
    STAFF_REACTIVATED: ['إعادة تفعيل موظف', 'Reactivate staff'],
    STAFF_DELETED: ['حذف حساب موظف', 'Delete staff'],
    STAFF_EMAIL_CHANGED: ['تغيير بريد موظف', 'Staff email changed'],
    STAFF_PASSWORD_CHANGED: ['تغيير كلمة مرور موظف', 'Staff password changed'],
    TOTP_ENROLLED: ['تسجيل تحقق ثنائي', '2FA enrollment'],
    TOTP_CONFIRMED: ['تأكيد التحقق الثنائي', '2FA confirmed'],
    TOTP_DISABLED: ['تعطيل التحقق الثنائي', '2FA disabled'],
    DATA_REPAIR: ['إصلاح بيانات', 'Data repair'],
    REGISTER_RESTORED: ['استعادة السجل من نسخة', 'Register restored from snapshot'],
  };

  const pair = map[action];
  if (!pair) return action;
  return en ? pair[1] : pair[0];
}

/** One field that differs between an entry's `before` and its `after`. */
export type AuditChange = { field: string; from: unknown; to: unknown };

/**
 * Bookkeeping the register writes on every row, which nobody audits.
 *
 * A timestamp that moves because the row was written is not a change somebody
 * made; listing it under «تعديل بيانات مواطن» buries the one field that was.
 */
const AUDIT_NOISE = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'tenantSlug',
  'searchTerms',
  'tokenVersion',
]);

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * What actually changed, field by field.
 *
 * `audit_log_entries` has carried `before` and `after` on every row since the
 * table existed, and no screen has ever rendered them: the trail showed that
 * «تعديل بيانات مواطن» happened, never what it did. An officer asking «مين غيّر
 * رقم الهاتف؟» could see that somebody edited the record and had to diff two
 * exports by hand to learn the rest.
 *
 * Compared with `JSON.stringify`, which is exactly right for values that are
 * scalars, dates-as-strings or small arrays — the shapes this column actually
 * holds — and wrong only for key order inside a nested object, where a false
 * positive costs one extra line in a list somebody is reading anyway.
 */
export function auditChanges(before: unknown, after: unknown): AuditChange[] {
  const from = asRecord(before);
  const to = asRecord(after);
  const fields = [...new Set([...Object.keys(from), ...Object.keys(to)])].sort();

  return fields
    .filter((field) => !AUDIT_NOISE.has(field))
    .map((field) => ({ field, from: from[field], to: to[field] }))
    .filter((change) => JSON.stringify(change.from ?? null) !== JSON.stringify(change.to ?? null));
}

/** «phone» → «الهاتف», reusing the map the citizen form and ملفّي already read. */
export function auditFieldLabel(field: string, locale: string): string {
  return getLabels(locale).citizenField?.[field] ?? field;
}

/**
 * A stored value as one short line.
 *
 * `null` is «—» and not an empty cell, because «من — إلى ٧٠…» is the shape of a
 * field being filled in for the first time, and a blank there reads as a
 * rendering fault. Long values are cut: this is a trail, not the record.
 */
export function auditValueText(value: unknown, locale: string): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') {
    return locale === 'en' ? (value ? 'yes' : 'no') : value ? 'نعم' : 'لا';
  }
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/**
 * Which `entityType` a screen should ask for.
 *
 * Worth stating because it is not guessable: a citizen's own trail is filed
 * under `User`, not `Citizen`. `users` holds staff and citizens both, and the
 * audit log names the table rather than the kind — so «ربط مالك بمستأجر» on a
 * citizen sits under `User` beside that citizen's id.
 */
export const AUDIT_ENTITY = {
  citizen: 'User',
  building: 'Building',
  registration: 'Registration',
  zone: 'Zone',
} as const;
