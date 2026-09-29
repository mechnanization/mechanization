import { ConflictError } from '../../common/exceptions';

/**
 * A file folded into another by «دمج ملفين» is a record of what was filed, not
 * a person anything may be written against.
 *
 * It stays in the register — deactivated, searchable by its old reference —
 * so every screen that picks a citizen can still reach it. This is the one
 * check the write paths share: an occupancy, a sale, a case, a bill or an edit
 * aimed at it is refused with the file that stays named, because that is where
 * the officer meant to write. Letting it through would put a flat, a bill or a
 * case on a person nobody bills, sees or can find, and would close the undo
 * window on the merge for good.
 */
export async function assertNotMergedAway(
  db: {
    citizenMerge: {
      findFirst(args: {
        where: { absorbedId: string; undoneAt: null };
        select: { survivor: { select: { id: true; firstName: true; lastName: true; referenceNumber: true } } };
      }): Promise<{ survivor: { id: string; firstName: string; lastName: string; referenceNumber: string | null } } | null>;
    };
  },
  citizenId: string | null | undefined,
): Promise<void> {
  if (!citizenId) return;
  const merge = await db.citizenMerge.findFirst({
    where: { absorbedId: citizenId, undoneAt: null },
    select: { survivor: { select: { id: true, firstName: true, lastName: true, referenceNumber: true } } },
  });
  if (!merge) return;
  const { survivor } = merge;
  throw new ConflictError(
    `هذا الملف مدموج في ملف ${survivor.firstName} ${survivor.lastName}${
      survivor.referenceNumber ? ` (${survivor.referenceNumber})` : ''
    } — استخدم ذلك الملف. للفصل بينهما يتراجع مدير النظام عن الدمج.`,
    { code: 'MERGED_AWAY', survivorId: survivor.id },
  );
}
