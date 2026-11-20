import { isCoOwned, ownerSharesPreview, usableShares, type OwnerBillingRule } from '@mechanization/shared-schemas';
import type { PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';

/**
 * Why a co-owned flat's saved method is not what billing carries out — what
 * «ملاحظات الجودة» warns about (`OWNER_BILLING_BLOCKED`) before a bill finds it.
 *
 *  - `SHARES_MISSING` — «حسب الأسهم» with `missing` of the `owners` lacking
 *    usable أسهم. Billing refuses every co-owner's bill as unassessable, the
 *    way it refuses a flat with no area. Reached when an owner spell is
 *    recorded after the choice was saved, without أسهم.
 *  - `RESPONSIBLE_NOT_OWNER` — «مالك مسؤول» naming someone with no current
 *    OWNER spell on an open file. Billing splits the flat equally instead.
 *  - `RESPONSIBLE_NOT_BILLED` — «مالك مسؤول» naming an owner whose own file no
 *    longer claims the flat, so billing would charge them nothing for it (finding
 *    F13, task B13). Read only when the rule was checked (`checkResponsibleOwners`).
 *    Billing splits the flat equally instead.
 */
export type OwnerBillingBlock =
  | { reason: 'SHARES_MISSING'; owners: number; missing: number }
  | { reason: 'RESPONSIBLE_NOT_OWNER'; owners: number }
  | { reason: 'RESPONSIBLE_NOT_BILLED'; owners: number };

/**
 * The block on this flat's saved method, if any, read through the rule billing
 * applies (`ownerSharesPreview`) — never a second statement of it. Null for a
 * flat with one owner, where no method applies, and for one billing can carry out.
 */
export function ownerBillingBlock(rule: OwnerBillingRule): OwnerBillingBlock | null {
  if (!isCoOwned(rule)) return null;
  const preview = ownerSharesPreview(rule);
  const owners = preview.owners.length;
  if (preview.effective.fallback === 'RESPONSIBLE_NOT_OWNER') return { reason: 'RESPONSIBLE_NOT_OWNER', owners };
  if (preview.effective.fallback === 'RESPONSIBLE_NOT_BILLED') return { reason: 'RESPONSIBLE_NOT_BILLED', owners };
  if (preview.owners.some((owner) => owner.outcome.kind === 'UNDECIDABLE')) {
    return {
      reason: 'SHARES_MISSING',
      owners,
      missing: preview.owners.filter((owner) => !usableShares(owner.shares)).length,
    };
  }
  return null;
}

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
 * Marks each «مالك مسؤول» rule with whether its responsible owner's own file
 * claims the flat as owner (`responsibleBilled`), so the rule falls back to the
 * equal split when it does not (finding F13 of the 2026-11-14 billing audit,
 * task B13).
 *
 * The choice is checked when it is saved (`OwnerBillingService`), and a file
 * can stop claiming the flat after that — a later filing that did not restate
 * it, a card ended — while the OWNER spell stays. Then the others paid nothing
 * because «مالك مسؤول» pays, and he was not billed because his file holds
 * nothing: the flat was billed to nobody, period after period. `claimsOf` is
 * billing's own reading of a file (`FeesService.ownerClaims`), never a second
 * statement of it. One read per responsible owner, however many of their flats
 * the rules hold; a rule whose responsible owner is no longer an owner falls
 * back already (`RESPONSIBLE_NOT_OWNER`) and is left alone.
 */
export async function checkResponsibleOwners(
  rules: Map<string, OwnerBillingRule>,
  claimsOf: (citizenId: string) => Promise<ReadonlySet<string>>,
): Promise<void> {
  const flatsByOwner = new Map<string, string[]>();
  for (const [unitId, rule] of rules) {
    const responsible = rule.responsibleOwnerId;
    if (rule.mode !== 'RESPONSIBLE_OWNER' || !responsible) continue;
    if (!rule.owners.some((owner) => owner.citizenId === responsible)) continue;
    flatsByOwner.set(responsible, [...(flatsByOwner.get(responsible) ?? []), unitId]);
  }
  for (const [ownerId, unitIds] of flatsByOwner) {
    const claimed = await claimsOf(ownerId);
    for (const unitId of unitIds) {
      rules.set(unitId, { ...rules.get(unitId)!, responsibleBilled: claimed.has(unitId) });
    }
  }
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
