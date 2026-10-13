import {
  BILL_CANCEL_ROLES as SHARED_BILL_CANCEL_ROLES,
  BULK_SETTLE_ROLES as SHARED_BULK_SETTLE_ROLES,
  CENSUS_WORKLIST_ROLES,
  FEE_SETTLE_ROLES,
  LANDLORD_LINK_ANSWER_ROLES as SHARED_LANDLORD_LINK_ANSWER_ROLES,
  PAYMENT_REVERSE_ROLES as SHARED_PAYMENT_REVERSE_ROLES,
  PAYMENT_REVIEW_MARK_ROLES,
  QUALITY_REVIEWER_ROLES as SHARED_QUALITY_REVIEWER_ROLES,
  REGISTER_EXPORT_ROLES as SHARED_REGISTER_EXPORT_ROLES,
  REGISTER_WRITE_ROLES,
  WORKING_STAFF_ROLES,
  hasStaffRole,
  type StaffRole,
  REQUEST_BILL_ROLES as SHARED_REQUEST_BILL_ROLES,
  REQUEST_HANDLE_ROLES as SHARED_REQUEST_HANDLE_ROLES,
  REQUEST_READ_ROLES as SHARED_REQUEST_READ_ROLES,
  REQUEST_SETTINGS_ROLES as SHARED_REQUEST_SETTINGS_ROLES,
} from '@mechanization/shared-schemas';

/**
 * Who may *act* on screens every staff role can open.
 *
 * `components/admin/nav.ts` decides who reaches a page; a page under
 * `/citizens/**` is reached by every staff role (CODE-4). Some of what those
 * pages offer is narrower on the server, and a control shown to a role the
 * server refuses is a button that can only fail — an auditor pressing «ربط» or
 * «فحص الملف» and getting «تعذّر…» for something they were never allowed to do.
 * These lists hide or swap those controls. The server stays the enforcement.
 *
 * Every list is an **allow-list** taken from the shared role sets the API's
 * `@Roles` are built from (`@mechanization/shared-schemas`, `role-sets.ts`),
 * so a route and its button change together. A deny-list fails open: the next
 * read-only role, or an undefined role on first paint, would get the write
 * controls.
 */

/** Answer a landlord-link proposal: «ربط», «ليس هو», undo, unlink. */
export const LANDLORD_LINK_ANSWER_ROLES: readonly string[] = SHARED_LANDLORD_LINK_ANSWER_ROLES;

/**
 * Open a citizen's record for completion — «فحص الملف», «استكمال البيانات
 * الناقصة» — and write it: create, correct, import. `REGISTER_WRITE_ROLES`.
 */
export const CITIZEN_RECORD_EDIT_ROLES: readonly string[] = REGISTER_WRITE_ROLES;

/** Write the census — buildings, units, occupancies, damage, visits. `REGISTER_WRITE_ROLES`. */
export const CENSUS_WRITE_ROLES: readonly string[] = REGISTER_WRITE_ROLES;

/** Open or update a case. `REGISTER_WRITE_ROLES`, as `CasesController` writes. */
export const CASE_WRITE_ROLES: readonly string[] = REGISTER_WRITE_ROLES;

/**
 * Open an attached identity document — `GET documents/:id/url`. Every working
 * role; not «مشاهد فقط», whose account reads the register on screen.
 */
export const DOCUMENT_VIEW_ROLES: readonly string[] = WORKING_STAFF_ROLES;

/**
 * Send a citizen their رقم مرجعي — the WhatsApp welcome. Every working role:
 * «مشاهد فقط» is never given the credential (the API masks it for that role,
 * `ViewerCredentialMaskInterceptor`), so it has nothing to send.
 */
export const REFERENCE_SEND_ROLES: readonly string[] = WORKING_STAFF_ROLES;

/**
 * Record a payment against a bill — `PATCH fees/payments/:id/settle`, the
 * counter and the round. `FEE_SETTLE_ROLES`, as the route: the collector
 * settles, though it issues no fee (`FEE_ISSUE_ROLES`).
 */
export const PAYMENT_SETTLE_ROLES: readonly string[] = FEE_SETTLE_ROLES;

/**
 * «تسجيل دفعة نقدية» — cash into the safe at the counter, the citizen file's
 * cash page, which always sends `CASH`. Narrower than `PAYMENT_SETTLE_ROLES`:
 * a collector records the cash he takes as his own collection, or a Whish
 * transfer, and the server refuses him `CASH` (`COLLECTOR_CANNOT_SELECT_METHOD`,
 * finance audit B1, decision D13). That rule lives in `FeesService.settleInPerson`, not
 * in a `@Roles` — the route is `FEE_ISSUE_ROLES` — so there is no shared set to
 * take; this mirrors it. A collector is sent to the counter settle page, which
 * offers him those two methods.
 */
export const CASH_COUNTER_ROLES: readonly string[] = [
  'SUPER_ADMIN',
  'ACCOUNTANT',
] as const satisfies readonly StaffRole[];

/**
 * «تسديد الفواتير المحددة» — tick several of one citizen's bills and settle
 * them in one press, `POST fees/payments/bulk-settle`. `BULK_SETTLE_ROLES`, as
 * the route: the finance roles only, so a collector still settles the same
 * bills one at a time with «تسجيل دفعة».
 */
export const BULK_SETTLE_ROLES: readonly string[] = SHARED_BULK_SETTLE_ROLES;

/**
 * «إلغاء الفاتورة» — withdraw a bill nothing was paid on, `POST
 * fees/payments/:id/cancel` (finance audit B3). `BILL_CANCEL_ROLES`, as the
 * route: the manager alone.
 */
export const BILL_CANCEL_ROLES: readonly string[] = SHARED_BILL_CANCEL_ROLES;

/**
 * المعاملات والإفادات (docs/municipal-requests-plan.md), as the routes: read the
 * queue, a request and its papers (not «مشاهد فقط»: the papers are identity
 * copies); handle one (file at the counter, approve, reject, hand over, cancel);
 * raise its fee as a bill; and set which types are offered and their fees.
 */
export const REQUEST_READ_ROLES: readonly string[] = SHARED_REQUEST_READ_ROLES;
export const REQUEST_HANDLE_ROLES: readonly string[] = SHARED_REQUEST_HANDLE_ROLES;
export const REQUEST_BILL_ROLES: readonly string[] = SHARED_REQUEST_BILL_ROLES;
export const REQUEST_SETTINGS_ROLES: readonly string[] = SHARED_REQUEST_SETTINGS_ROLES;

/**
 * Send a citizen a copy of a consolidated receipt over WhatsApp. Every working
 * role, the audience the single receipt's «إرسال عبر واتساب» already has;
 * «مشاهد فقط» reads and prints a receipt, and sends nothing. The message carries
 * no رقم مرجعي (`lib/bulk-receipt-message.ts`), so this is not
 * `REFERENCE_SEND_ROLES`, though today it is the same list.
 */
export const RECEIPT_SEND_ROLES: readonly string[] = WORKING_STAFF_ROLES;

/**
 * «عكس الوصل» on a bill's receipts — `POST fees/transactions/:id/reverse`.
 * `PAYMENT_REVERSE_ROLES`, as the route: the manager alone.
 */
export const PAYMENT_REVERSE_ROLES: readonly string[] = SHARED_PAYMENT_REVERSE_ROLES;

/** The register export, `dashboard/export.csv`. Not «مشاهد فقط». */
export const REGISTER_EXPORT_ROLES: readonly string[] = SHARED_REGISTER_EXPORT_ROLES;

/** «وحدات غير ممسوحة» and «بانتظار إعادة الكشف». */
export const WORKLIST_ROLES: readonly string[] = CENSUS_WORKLIST_ROLES;

/**
 * The pending-payments bell, which reads the queue and marks it seen —
 * `PAYMENT_REVIEW_MARK_ROLES`. «مشاهد فقط» reads the queue on the fees page but
 * cannot mark it, so it gets no bell rather than one whose buttons only fail.
 */
export const PAYMENT_REVIEW_ROLES: readonly string[] = PAYMENT_REVIEW_MARK_ROLES;

/** The quality screens — decide a review. `QualityController` enforces the same list. */
export const QUALITY_REVIEWER_ROLES: readonly string[] = SHARED_QUALITY_REVIEWER_ROLES;

export function hasRole(roles: readonly string[], role: string | null | undefined): boolean {
  return hasStaffRole(roles, role);
}
