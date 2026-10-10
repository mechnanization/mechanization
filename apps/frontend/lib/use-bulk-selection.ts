'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  reconcileSelection,
  toggleBill,
  togglePage,
  type SelectedBill,
} from './bulk-settle';

const NONE: readonly SelectedBill[] = [];

/**
 * The bills ticked for «تسديد الفواتير المحددة» on one screen, and the ways to
 * change them. The rules (one citizen, at most `BULK_SETTLE_MAX_BILLS`, which
 * rows may be ticked) are `lib/bulk-settle.ts`'s; this only holds the state.
 *
 * Held by the page, not by the list: on /fees it outlives a page turn, and on
 * the citizen file the sticky bar and the dialog sit at the page's root, outside
 * the folding section the list is drawn in.
 */
export function useBulkSelection() {
  const [bills, setBills] = useState<readonly SelectedBill[]>(NONE);

  const toggle = useCallback((bill: SelectedBill) => setBills((current) => toggleBill(current, bill)), []);
  const toggleRows = useCallback(
    (rows: readonly SelectedBill[]) => setBills((current) => togglePage(current, rows)),
    [],
  );
  const remove = useCallback(
    (id: string) => setBills((current) => current.filter((bill) => bill.id !== id)),
    [],
  );
  const clear = useCallback(() => setBills(NONE), []);
  const reconcile = useCallback(
    (fresh: ReadonlyArray<{ bill: SelectedBill; settleable: boolean }>) =>
      setBills((current) => reconcileSelection(current, fresh)),
    [],
  );

  return useMemo(
    () => ({ bills, toggle, toggleRows, remove, clear, reconcile }),
    [bills, toggle, toggleRows, remove, clear, reconcile],
  );
}

export type BulkSelection = ReturnType<typeof useBulkSelection>;
