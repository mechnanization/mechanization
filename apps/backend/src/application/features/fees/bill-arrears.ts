/**
 * An «ARR-» bill's line, as a bill's views carry it (old debts task 10,
 * docs/old-debts-plan.md §7–§8). Beside `bill-write-off.ts`, the other view
 * every bill read carries since 0107.
 *
 * The bill holds the only link (`citizen_payments.arrearsLineId`), so each read
 * that lists bills joins the line through `ARREARS_LINE_SELECT` and maps it
 * with `arrearsView`.
 */

import type { ArrearsFeeType, BillArrearsView } from '@mechanization/shared-schemas';

/** What a bill read selects of its line, under `arrearsLine`. */
export const ARREARS_LINE_SELECT = {
  select: {
    year: true,
    feeType: true,
    feeTypeNote: true,
    component: true,
    propertyNumber: true,
    unitCode: true,
    oldReference: true,
  },
} as const;

type ArrearsLineRow = {
  year: number;
  feeType: string;
  feeTypeNote: string | null;
  component: 'PRINCIPAL' | 'PENALTY';
  propertyNumber: string;
  unitCode: string | null;
  oldReference: string | null;
};

/**
 * A staff-read line as the portal may see it: the old books' reference cleared.
 * `CitizenController.mySummary` passes the staff profile's bills on, so this is
 * what stands between a citizen and the municipality's own bookkeeping.
 */
export function citizenArrears(view: BillArrearsView | null): BillArrearsView | null {
  return view ? { ...view, oldReference: null } : null;
}

/**
 * The line of a bill row, or null on a bill that is not an old debt.
 *
 * `audience` is a required word, not a default: the old books' reference is
 * the municipality's own bookkeeping, so the portal's readers say `'CITIZEN'`
 * and get it nulled, and a new reader has to choose.
 */
export function arrearsView(
  row: { arrearsLine?: ArrearsLineRow | null },
  audience: 'STAFF' | 'CITIZEN',
): BillArrearsView | null {
  const line = row.arrearsLine;
  if (!line) return null;
  return {
    year: line.year,
    // Text in the column (a new code needs no migration); the contract names the codes it knows.
    feeType: line.feeType as ArrearsFeeType,
    feeTypeNote: line.feeTypeNote,
    component: line.component,
    propertyNumber: line.propertyNumber,
    unitCode: line.unitCode,
    oldReference: audience === 'STAFF' ? line.oldReference : null,
  };
}
