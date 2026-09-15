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
    TENANCY_ENDED: ['إنهاء إيجار', 'Tenancy ended'],

    // ── buildings and their units ──
    BUILDING_CREATED: ['إنشاء مبنى', 'Building created'],
    BUILDING_UPDATED: ['تعديل مبنى', 'Building updated'],
    BUILDING_CODE_RECOMPUTED: ['إعادة احتساب رمز المبنى', 'Building code recomputed'],
    UNIT_UPDATED: ['تعديل وحدة', 'Unit updated'],
    UNIT_VISIT_LOGGED: ['تسجيل زيارة وحدة', 'Unit visit logged'],
    UNIT_VACANCY_CONFIRMED: ['تأكيد شغور وحدة', 'Vacancy confirmed'],
    UNIT_STATUS_AFTER_TENANCY: ['حالة الوحدة بعد الإيجار', 'Unit status after tenancy'],
    OCCUPANCY_RECORDED: ['تسجيل إشغال', 'Occupancy recorded'],
    OCCUPANCY_ENDED: ['إنهاء إشغال', 'Occupancy ended'],

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
    TOTP_ENROLLED: ['تسجيل تحقق ثنائي', '2FA enrollment'],
    TOTP_CONFIRMED: ['تأكيد التحقق الثنائي', '2FA confirmed'],
    DATA_REPAIR: ['إصلاح بيانات', 'Data repair'],
  };

  const pair = map[action];
  if (!pair) return action;
  return en ? pair[1] : pair[0];
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
