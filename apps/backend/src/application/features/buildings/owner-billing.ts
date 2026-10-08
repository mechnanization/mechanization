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
 *
 * **Only owners whose file is open count** (`activeOwnerSpells`). An archived
 * file («أرشفة الملف», `isActive` false) is never billed — `resolveTargets`
 * skips it — so counting it would leave its part of the flat billed to nobody,
 * and naming it «المالك المسؤول» would exempt every other owner while billing
 * no one (review of 2026-10-08). Its part falls to the owners who are billed.
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
      occupancies: activeOwnerSpells({ citizenId: true, shares: true }),
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

/**
 * The flat's current OWNER spells held by an open file — the owners billing can
 * charge. One definition for the loader above and `OwnerBillingService`, so the
 * choice an officer saves and the bill it produces count the same owners.
 */
export function activeOwnerSpells<S extends Record<string, true>>(select: S) {
  return {
    where: { toDate: null, role: 'OWNER' as const, citizen: { isActive: true } },
    orderBy: [{ fromDate: 'asc' as const }, { createdAt: 'asc' as const }],
    select,
  };
}
