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
