import { SEES_ALL_STAFF_WORK, STAFF_ROLE, type StaffRole } from './enums';

/**
 * Who may call what: the named role sets every `@Roles(...)` in the API is
 * built from, and that the dashboard mirrors to hide a control the server
 * would refuse.
 *
 * One copy for both apps. Each list used to be a literal re-typed on every
 * route that needed it — the all-staff list eighteen times — so adding a role
 * meant editing dozens of decorators, and missing one was an authorisation bug
 * nobody would see until the role tried the screen. A set named here reaches
 * the route and the button together.
 *
 * `@Roles('SUPER_ADMIN')` stays a literal: it names one role, not a list.
 * The server's `@Roles` is the enforcement; a screen that reads these only
 * decides what to show.
 */

/** Every staff role. The register, the census, cases and zones are read by all of them. */
export const EVERY_STAFF_ROLE: readonly StaffRole[] = STAFF_ROLE;

/**
 * Every role that works the system — all of them but «مشاهد فقط» (VIEWER),
 * the municipality leader's account, which reads and does nothing. The
 * identity documents, the quality worklists and the admin configuration are
 * working tools, not reading.
 */
export const WORKING_STAFF_ROLES: readonly StaffRole[] = STAFF_ROLE.filter((role) => role !== 'VIEWER');

/**
 * The roles that write the register and the census: citizen files (create,
 * correct, complete, archive), buildings, units, occupancies, damage readings,
 * visits and cases.
 */
export const REGISTER_WRITE_ROLES = [
  'SUPER_ADMIN',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ADMINISTRATIVE_OFFICER',
] as const satisfies readonly StaffRole[];

/** Answer a landlord-link proposal: «ربط», «ليس هو», undo, unlink. */
export const LANDLORD_LINK_ANSWER_ROLES = [
  'SUPER_ADMIN',
  'FIELD_INSPECTOR',
  'ADMINISTRATIVE_OFFICER',
] as const satisfies readonly StaffRole[];

/** The landlord-link totals on the register's summary. */
export const LANDLORD_SUMMARY_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
  'VIEWER',
] as const satisfies readonly StaffRole[];

/** The register's own administration: zones. */
export const REGISTER_ADMIN_ROLES = [
  'SUPER_ADMIN',
  'ADMINISTRATIVE_OFFICER',
] as const satisfies readonly StaffRole[];

/**
 * The collection worklists — «وحدات غير ممسوحة», «بانتظار إعادة الكشف».
 *
 * The roles that put work on them (the register's writers), plus the ones that
 * see everyone's (`SEES_ALL_STAFF_WORK`). An accountant does neither, and a
 * list that is always empty for them is not a screen to offer.
 */
export const CENSUS_WORKLIST_ROLES: readonly StaffRole[] = STAFF_ROLE.filter(
  (role) =>
    (REGISTER_WRITE_ROLES as readonly string[]).includes(role) ||
    (SEES_ALL_STAFF_WORK as readonly string[]).includes(role),
);

/** Decide a quality review: the queue, approve, return, findings, sampling. */
export const QUALITY_REVIEWER_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'ADMINISTRATIVE_OFFICER',
] as const satisfies readonly StaffRole[];

/* Complete a quality check in the field: `QUALITY_CHECK_ROLES`, in `quality.schema.ts`. */

/** See whether a record has an open quality return — everyone who files or reviews one. */
export const QUALITY_RETURN_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ADMINISTRATIVE_OFFICER',
] as const satisfies readonly StaffRole[];

/** The fee ledger: notices, payments, transactions and the summary. */
export const FEE_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'COLLECTOR',
  'ACCOUNTANT',
  'ADMINISTRATIVE_OFFICER',
  'VIEWER',
] as const satisfies readonly StaffRole[];

/** Issue a fee, charge one citizen, settle at the counter. */
export const FEE_ISSUE_ROLES = [
  'SUPER_ADMIN',
  'COLLECTOR',
  'ACCOUNTANT',
] as const satisfies readonly StaffRole[];

/** The fee settings, notices' active flag, the recurring run and payment review. */
export const FEE_ADMIN_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT'] as const satisfies readonly StaffRole[];

/**
 * «تسديد الفواتير المحددة»: several of one citizen's bills in one press
 * (docs/finance.md §3.7). The finance roles only, per the phase-4 brief —
 * narrower than `FEE_ISSUE_ROLES`, so a collector still settles the same bills
 * one at a time. Its own set because it is its own audience: the dialog reads
 * the treasury's balances to check the change, which a collector cannot.
 */
export const BULK_SETTLE_ROLES = ['SUPER_ADMIN', 'ACCOUNTANT'] as const satisfies readonly StaffRole[];

/** Read the payments waiting for verification and the bills a correction affects. */
export const PAYMENT_REVIEW_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'ACCOUNTANT',
  'VIEWER',
] as const satisfies readonly StaffRole[];

/** Mark verified payments as seen. */
export const PAYMENT_REVIEW_MARK_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'ACCOUNTANT',
] as const satisfies readonly StaffRole[];

/** The dashboard's counters and analytics. */
export const DASHBOARD_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'VIEWER',
] as const satisfies readonly StaffRole[];

/**
 * The bulk register export, `dashboard/export.csv` — the one action that moves
 * every citizen's details off the system and onto someone's laptop.
 * Deliberately not VIEWER: the leader's account reads on screen and takes
 * nothing away (decision, 2026-10-05).
 */
export const REGISTER_EXPORT_ROLES = ['SUPER_ADMIN', 'AUDITOR'] as const satisfies readonly StaffRole[];

/** The audit trail. */
export const AUDIT_READ_ROLES = ['SUPER_ADMIN', 'AUDITOR'] as const satisfies readonly StaffRole[];

/** The census map's layers. Every role but the accountant, whose work has no map. */
export const MAP_READ_ROLES = [
  'SUPER_ADMIN',
  'AUDITOR',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ADMINISTRATIVE_OFFICER',
  'VIEWER',
] as const satisfies readonly StaffRole[];

/** A field inspector's earnings profile. */
export const INSPECTOR_PROFILE_ROLES = ['SUPER_ADMIN', 'FIELD_INSPECTOR'] as const satisfies readonly StaffRole[];

/** Whether `role` is one of `roles`. Null and unknown roles are not. */
export function hasStaffRole(roles: readonly string[], role: string | null | undefined): boolean {
  return role != null && roles.includes(role);
}
