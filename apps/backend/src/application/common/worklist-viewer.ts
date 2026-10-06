import { WORKLIST_UNASSIGNED, seesAllStaffWork } from '@mechanization/shared-schemas';
import { Prisma } from '../../generated/tenant-client';

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

/**
 * The SQL narrowing of a worklist to whose work it shows, on `column` — the
 * staff id the work belongs to (who filed the record, who added the building,
 * who recorded the reading).
 *
 * An officer sees their own, whatever is asked (`worklistOwner`). A role that
 * sees everyone's may narrow to one officer, or to `UNASSIGNED` — work whose
 * officer was never recorded, is archived («الأرشيف») or deleted — so a
 * leaver's open work does not drop out of every list but the admin's
 * unfiltered one.
 */
export function worklistOwnerFilter(
  S: Prisma.Sql,
  column: Prisma.Sql,
  owner: string | undefined,
  viewer?: WorklistViewer,
): Prisma.Sql {
  const mine = worklistOwner(viewer);
  if (mine) return Prisma.sql`AND ${column} = ${mine}::uuid`;
  if (!owner) return Prisma.empty;
  if (owner === WORKLIST_UNASSIGNED) {
    return Prisma.sql`AND NOT EXISTS (
      SELECT 1 FROM ${S}users staff
       WHERE staff.id = ${column} AND staff.kind = 'STAFF'
         AND staff."isActive" AND staff."deletedAt" IS NULL
    )`;
  }
  return Prisma.sql`AND ${column} = ${owner}::uuid`;
}

