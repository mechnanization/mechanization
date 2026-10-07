import { isCoOwned, type OwnerBillingRule } from '@mechanization/shared-schemas';
import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';

/**
 * «توزيع الرسم على المالكين» for the flats among these that have several current
 * owners — what `ownerShareOf` needs to divide a flat between them (migration
 * 0075). A flat with one owner is left out: it is billed whole, as it always
 * was, and carries nothing to divide.
 *
 * Read per billing batch, beside `unitsUnderReview` and `uninhabitableUnitIds`,
 * and for the same reason: the rule needs **every** owner of a flat, not just
 * the one being assessed, and the other owners are usually in a different
 * batch or not targeted by the notice at all.
 */
export async function ownerBillingRules(
  db: Pick<TenantPrismaClient, 'unit'>,
  unitIds: readonly string[],
): Promise<Map<string, OwnerBillingRule>> {
  if (unitIds.length === 0) return new Map();
  const units = await db.unit.findMany({
    where: { id: { in: [...unitIds] } },
    select: {
      id: true,
      ownerBillingMode: true,
      responsibleOwnerId: true,
      occupancies: {
        where: { toDate: null, role: 'OWNER' },
        orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }],
        select: { citizenId: true, shares: true },
      },
    },
  });

  const rules = new Map<string, OwnerBillingRule>();
  for (const unit of units) {
    const rule: OwnerBillingRule = {
      mode: unit.ownerBillingMode,
      responsibleOwnerId: unit.responsibleOwnerId,
      owners: unit.occupancies.map((spell) => ({ citizenId: spell.citizenId, shares: spell.shares })),
    };
    if (isCoOwned(rule)) rules.set(unit.id, rule);
  }
  return rules;
}
