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
    CITIZEN_REACTIVATED: ['إعادة تفعيل مواطن', 'Citizen reactivated'],
    HOUSEHOLD_LINKED: ['ربط أسرة', 'Household linked'],
    LANDLORD_LINKED: ['ربط مالك بمستأجر', 'Owner linked'],
    LANDLORD_UNLINKED: ['إلغاء ربط مالك', 'Owner unlinked'],
    LANDLORD_LINK_UPDATED: ['تحديث ربط مالك', 'Owner link updated'],
    LANDLORD_MATCH_DISMISSED: ['رفض مطابقة مالك', 'Owner match dismissed'],
    LANDLORD_MATCH_RESTORED: ['استعادة مطابقة مالك', 'Owner match restored'],
    LANDLORD_TENANCY_ENDED: ['إنهاء إيجار لدى المالك', 'Tenancy ended on owner'],
    TENANCY_ENDED: ['إنهاء إيجار', 'Tenancy ended'],

    // ── quality review ──
    RECORD_APPROVED: ['اعتماد سجل', 'Record approved'],
    RECORD_RETURNED: ['إعادة سجل للموظف', 'Record returned'],
    RECORD_CORRECTED: ['تصحيح سجل مُعاد', 'Returned record corrected'],
    QUALITY_CHECK_DONE: ['تحقق ميداني من سجل', 'Field re-check done'],
    QUALITY_CHECK_ASSIGNED: ['إسناد تحقق ميداني', 'Re-check assigned'],
    QUALITY_SAMPLE_DRAWN: ['سحب عيّنة للتحقق', 'Re-check sample drawn'],
    QUALITY_FINDING_DISMISSED: ['ملاحظة جودة: ليست مشكلة', 'Finding dismissed'],
    QUALITY_FINDING_RESTORED: ['إعادة فتح ملاحظة جودة', 'Finding restored'],

    // ── hand corrections ──
    DATA_CORRECTION: ['تصحيح يدوي للبيانات', 'Manual data correction'],
    DATA_CORRECTION_DELETE: ['حذف يدوي ضمن تصحيح', 'Manual deletion (correction)'],

    // ── buildings and their units ──
    BUILDING_CREATED: ['إنشاء مبنى', 'Building created'],
    BUILDING_UPDATED: ['تعديل مبنى', 'Building updated'],
    BUILDING_DELETED: ['حذف مبنى', 'Building deleted'],
    BUILDING_UNITS_GENERATED: ['إنشاء وحدات المبنى', 'Units generated'],
    BUILDING_CODE_RECOMPUTED: ['إعادة احتساب رمز المبنى', 'Building code recomputed'],
    UNIT_ADDED: ['إضافة وحدة', 'Unit added'],
    UNIT_UPDATED: ['تعديل وحدة', 'Unit updated'],
    UNIT_DELETED: ['حذف وحدة', 'Unit deleted'],
    UNIT_VISIT_LOGGED: ['تسجيل زيارة وحدة', 'Unit visit logged'],
    UNIT_VACANCY_CONFIRMED: ['تأكيد شغور وحدة', 'Vacancy confirmed'],
    UNIT_VACANCY_ENDED: ['إلغاء تأكيد الشغور', 'Vacancy lifted'],
    CASE_CREATED: ['فتح حالة', 'Case opened'],
    CASE_UPDATED: ['تعديل حالة', 'Case updated'],
    CASE_RESOLVED: ['حل حالة', 'Case resolved'],
    CASE_RESOLVED_WITH_CITIZEN: ['حل حالة بتسجيل مواطن', 'Case resolved with a citizen'],
    CASE_DELETED: ['حذف حالة', 'Case deleted'],
    UNIT_STATUS_AFTER_TENANCY: ['حالة الوحدة بعد الإيجار', 'Unit status after tenancy'],
    OCCUPANCY_RECORDED: ['تسجيل إشغال', 'Occupancy recorded'],
    OCCUPANCY_ENDED: ['إنهاء إشغال', 'Occupancy ended'],

    // ── land ──
    ZONE_CREATED: ['إنشاء قطاع', 'Create sector'],
    ZONE_UPDATED: ['تعديل قطاع', 'Update sector'],
    ZONE_DELETED: ['حذف قطاع', 'Delete sector'],
    CADASTRE_IMPORT: ['استيراد خريطة', 'Cadastre import'],

    // ── money ──
    FEE_ISSUED: ['إصدار رسم', 'Fee issued'],
    FEE_RECURRING_ISSUED: ['إصدار رسم دوري', 'Recurring fee issued'],
    PAYMENT_DECLARED: ['تصريح بدفعة', 'Payment declared'],
    PAYMENT_CONFIRMED: ['تأكيد دفعة', 'Payment confirmed'],
    PAYMENT_REJECTED: ['رفض دفعة', 'Payment rejected'],
    INSPECTOR_PAYOUT_RECORDED: ['تسجيل دفعة لمفتش', 'Inspector payout recorded'],

    // ── the portal itself ──
    LOGIN: ['تسجيل دخول', 'Login'],
    REGISTER_RESTORED: ['استعادة سجل البلدية من نسخة احتياطية', 'Register restored from backup'],
    STAFF_EMAIL_CHANGED: ['تغيير بريد موظف', 'Staff email changed'],
    STAFF_PASSWORD_CHANGED: ['تغيير كلمة مرور موظف', 'Staff password changed'],
    TOTP_DISABLED: ['إيقاف التحقق الثنائي', '2FA disabled'],
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
  case: 'Case',
} as const;

/** What kind of record an entry is about, in words — for the filter and the fallback target. */
export function auditEntityLabel(entityType: string, locale: string): string {
  const en = locale === 'en';
  const map: Record<string, [ar: string, en: string]> = {
    User: ['مواطن أو موظف', 'Citizen or staff'],
    Building: ['مبنى', 'Building'],
    Registration: ['طلب تسجيل', 'Registration'],
    Case: ['حالة ميدانية', 'Field case'],
    Zone: ['قطاع', 'Sector'],
    Parcel: ['المسح العقاري', 'Cadastre'],
    Document: ['مرفق', 'Document'],
    FeeNotice: ['رسم', 'Fee notice'],
    Payment: ['دفعة', 'Payment'],
    SystemSettings: ['إعدادات البلدية', 'Settings'],
    Tenant: ['سجل البلدية', 'Register'],
    DataQuality: ['مراجعة الجودة', 'Quality review'],
  };
  const pair = map[entityType];
  return pair ? (en ? pair[1] : pair[0]) : entityType;
}
