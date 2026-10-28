import { formatUnitCode, type SharedUnitBillView } from '@mechanization/shared-schemas';
import type { Prisma } from '../../../generated/tenant-client';

/**
 * What a list reads to describe a shared unit bill (0099, decision D5): the
 * unit, its building and how many debtors the bill has. A shared bill has no
 * one citizen (`citizenId` NULL), so every read that names a bill's citizen
 * includes this beside it and shows the unit instead.
 */
export const SHARED_BILL_INCLUDE = {
  unit: { select: { id: true, floor: true, sequence: true, building: { select: { code: true } } } },
  _count: { select: { debtors: true } },
} satisfies Prisma.CitizenPaymentInclude;

type SharedBillRow = Prisma.CitizenPaymentGetPayload<{ include: typeof SHARED_BILL_INCLUDE }>;

/**
 * The bills a person owes: their own, and every shared unit bill they are a
 * debtor on (0099, D5) — a shared bill is owed by each of its debtors until one
 * of them pays it. Put in an `AND` beside other conditions, never spread into a
 * `where` that may carry its own `OR`.
 */
export function billsOwedBy(citizenId: string): Prisma.CitizenPaymentWhereInput {
  return { OR: [{ citizenId }, { debtors: { some: { citizenId } } }] };
}

/**
 * The debtor a shared unit bill's unit names «مالك مسؤول» (0075), or null.
 *
 * D5 still bills every owner the full amount on one bill, whatever the unit's
 * co-owner method; the responsible owner is only who the counter offers first
 * as its payer (the user's decision, 2026-10-27). Under that mode only —
 * `responsibleOwnerId` is set with it alone (CHECK
 * units_responsible_owner_needs_mode), and a person no longer an owner is no
 * debtor, so is never offered.
 */
export function responsibleDebtorId(
  unit: { ownerBillingMode: string | null; responsibleOwnerId: string | null } | null,
): string | null {
  return unit?.ownerBillingMode === 'RESPONSIBLE_OWNER' ? unit.responsibleOwnerId : null;
}

/** The shared unit a bill is for, or null on a citizen's own bill. */
export function sharedUnitView(row: Pick<SharedBillRow, 'unit' | '_count'>): SharedUnitBillView | null {
  if (!row.unit) return null;
  return {
    unitId: row.unit.id,
    unitCode: formatUnitCode(row.unit.floor, row.unit.sequence),
    buildingCode: row.unit.building.code,
    debtorCount: row._count.debtors,
  };
}
