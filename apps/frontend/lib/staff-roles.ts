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
 * Each list mirrors one controller's `@Roles` and says which. Change them
 * together.
 */

/**
 * Answer a landlord-link proposal: «ربط», «ليس هو», undo, unlink.
 * Mirrors `@Roles` on `POST landlord-links/:id/confirm`, `…/dismiss`,
 * `…/restore` and `DELETE landlord-links/:id` in `citizen.controller.ts`.
 */
export const LANDLORD_LINK_ANSWER_ROLES: readonly string[] = [
  'SUPER_ADMIN',
  'FIELD_INSPECTOR',
  'ADMINISTRATIVE_OFFICER',
];

/**
 * Open a citizen's record for completion — «فحص الملف», «استكمال البيانات
 * الناقصة». Mirrors `@Roles` on `GET citizens/:id/form` and
 * `PATCH citizens/:id` in `citizen.controller.ts`.
 */
export const CITIZEN_RECORD_EDIT_ROLES: readonly string[] = [
  'SUPER_ADMIN',
  'FIELD_INSPECTOR',
  'COLLECTOR',
  'ADMINISTRATIVE_OFFICER',
];

/**
 * «حذف الملف نهائياً» — erase a citizen nothing points at. Mirrors `@Roles`
 * on `DELETE citizens/:id` in `citizen.controller.ts`.
 */
export const CITIZEN_DELETE_ROLES: readonly string[] = ['SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER'];

export function hasRole(roles: readonly string[], role: string | null | undefined): boolean {
  return role ? roles.includes(role) : false;
}
