import { Prisma, type PrismaClient as TenantPrismaClient } from '../../../generated/tenant-client';
import { ConflictError } from '../../common/exceptions';

/**
 * «معفاة من الرسوم» in SQL — the twin of `isFeeExemptOn` in shared-schemas
 * (migration 0104; decision 1 of 2026-11-16): the unit carries an exemption
 * and its last day, if any, is not before `day`. Change the two together.
 *
 * `unit` is the alias of a `units` row; `day` a bound `YYYY-MM-DD`.
 */
export function feeExemptSql(unit: Prisma.Sql, day: string): Prisma.Sql {
  return Prisma.sql`(${unit}."feeExemption" IS NOT NULL AND (${unit}."feeExemptionValidUntil" IS NULL OR ${unit}."feeExemptionValidUntil" >= ${day}::date))`;
}

/**
 * The first day of the billing period `periodKey` names (`periodKeyFor` in
 * `fees.service.ts`): the day billing asks `isFeeExemptOn` of, so a unit exempt
 * on it is exempt for the whole period. A one-off notice has one period,
 * `ONCE`, which starts the day its bill is raised (`raisedOn`).
 */
export function billingDayOfPeriod(periodKey: string, raisedOn: string): string {
  const monthly = /^(\d{4})-(\d{2})$/.exec(periodKey);
  if (monthly) return `${monthly[1]}-${monthly[2]}-01`;
  const halfYear = /^(\d{4})-H([12])$/.exec(periodKey);
  if (halfYear) return `${halfYear[1]}-${halfYear[2] === '1' ? '01' : '07'}-01`;
  if (/^\d{4}$/.test(periodKey)) return `${periodKey}-01-01`;
  return raisedOn;
}

/**
 * Refuses a delete that would erase an exemption history: `unit_fee_exemptions`
 * keys onto `units` with RESTRICT (0104), and the database's own refusal would
 * reach the caller as a 500 (docs/gotchas.md, "A new RESTRICT key turns an
 * existing delete into a 500"). Every path that deletes a unit or a building
 * asks it before it writes: the unit and building deletes, «حذف تصحيحي» and
 * «دمج كدوبلكس». A lifted exemption is history too: the unit is corrected, not
 * deleted.
 */
export async function assertNoFeeExemptionHistory(
  db: Pick<TenantPrismaClient, 'unitFeeExemption'>,
  where: { unitIds: readonly string[] } | { buildingId: string },
): Promise<void> {
  const found = await db.unitFeeExemption.findFirst({
    where: 'buildingId' in where ? { unit: { buildingId: where.buildingId } } : { unitId: { in: [...where.unitIds] } },
    orderBy: [{ grantedAt: 'asc' }],
    select: { unit: { select: { unitCode: true } } },
  });
  if (found) {
    throw new ConflictError({
      code: 'UNIT_HAS_FEE_EXEMPTION_HISTORY',
      message: 'This unit has a fee exemption history, which a delete would erase.',
      params: { unitCode: found.unit.unitCode },
    });
  }
}
