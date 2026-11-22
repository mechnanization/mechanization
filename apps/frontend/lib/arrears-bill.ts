import type { BillArrearsView, getLabels } from '@mechanization/shared-schemas';

/**
 * An old debt's bill on every screen that shows a bill (old debts task 10,
 * docs/old-debts-plan.md §7): the rules the screens share, pure, so they are
 * tested without a browser. The server decides what an «ARR-» bill is
 * (`arrears` on the bill's view, null on any other); nothing here infers it
 * from the number or the title.
 */

type Labels = ReturnType<typeof getLabels>;

/** A bill's view that may carry an old debt's line. Absent on a reply from an older API. */
export interface MaybeArrearsBill {
  arrears?: BillArrearsView | null;
}

/** True when the bill is an old debt, as the server says. */
export function isArrearsBill(bill: MaybeArrearsBill): bill is { arrears: BillArrearsView } {
  return Boolean(bill.arrears);
}

/**
 * The fee's name: the description the accountant wrote for «رسم آخر», else the
 * label of the code. A code the contract does not know yet (the column is text,
 * so the municipality's final list needs no migration) is shown as it is.
 */
export function arrearsFeeName(arrears: BillArrearsView, labels: Labels): string {
  if (arrears.feeType === 'OTHER' && arrears.feeTypeNote?.trim()) return arrears.feeTypeNote.trim();
  const known = labels.arrearsFeeType as Record<string, string>;
  return known[arrears.feeType] ?? arrears.feeType;
}

/** A penalty is a line of its own, carried over from the old books (decision 6). */
export function isArrearsPenalty(arrears: BillArrearsView): boolean {
  return arrears.component === 'PENALTY';
}

/**
 * The bills of a list split into the current ones and the old debts, each in
 * the order given (the server's: status, then due date). A list with no old
 * debt returns the same bills in `current`, so a screen can group only when
 * `arrears` has something in it.
 */
export function splitArrears<T extends MaybeArrearsBill>(bills: readonly T[]): { current: T[]; arrears: T[] } {
  const current: T[] = [];
  const arrears: T[] = [];
  for (const bill of bills) (isArrearsBill(bill) ? arrears : current).push(bill);
  return { current, arrears };
}

/**
 * Old-debt bills grouped by the debt's year, the oldest year first: the order a
 * settlement pays them in (`arrears-settlement-order.spec.ts`). Within a year
 * the bills keep the order given, so a principal and its penalty stay as the
 * server listed them. Bills with no old-debt line are left out; split first.
 */
export function groupArrearsByYear<T extends MaybeArrearsBill>(bills: readonly T[]): Array<{ year: number; bills: T[] }> {
  const byYear = new Map<number, T[]>();
  for (const bill of bills) {
    if (!bill.arrears) continue;
    const year = bill.arrears.year;
    const group = byYear.get(year);
    if (group) group.push(bill);
    else byYear.set(year, [bill]);
  }
  return [...byYear.entries()].sort(([a], [b]) => a - b).map(([year, grouped]) => ({ year, bills: grouped }));
}
