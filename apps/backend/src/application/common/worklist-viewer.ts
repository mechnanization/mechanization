import { seesAllStaffWork } from '@mechanization/shared-schemas';

/**
 * Who is asking for a collection worklist — «يتطلب مراجعة», «وحدات غير
 * ممسوحة» — and so whose work it shows. Absent means everyone's: the internal
 * callers that are not a person's screen.
 */
export interface WorklistViewer {
  id: string;
  role: string;
}

/**
 * The staff member a viewer's worklist is narrowed to, or null for everyone's.
 * Admins and the roles that look across everyone's work (`seesAllStaffWork`)
 * see it all; everyone else sees their own.
 */
export function worklistOwner(viewer?: WorklistViewer): string | null {
  return viewer && !seesAllStaffWork(viewer.role) ? viewer.id : null;
}
