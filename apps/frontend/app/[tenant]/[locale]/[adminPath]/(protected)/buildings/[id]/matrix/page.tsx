'use client';

import { use, useCallback } from 'react';
import { BuildingUnitMatrixView } from '@/components/admin/building-unit-matrix-view';
import { param, useUrlState } from '@/lib/use-url-state';

/**
 * `?unit=<uuid>` — the unit being inspected, so a reload or the back button
 * from a citizen's file returns to it. A row id, never anything that names
 * the people in it. Only the selection: the action form open under it
 * (occupy, vacate, damage…) is never in the URL, so a refresh or a shared
 * link cannot reopen a form that writes.
 */
const MATRIX_URL = { unit: param.id() };

/**
 * The ledger's full-page unit matrix — units laid out the way they were
 * painted in the creation wizard, with the same register/case/vacant/damage/
 * visit actions the slide-over drawer offers. The drawer itself stays live
 * for the map and cases pages, which open it in place rather than navigating
 * away from a map position or a case list scroll.
 */
export default function BuildingUnitMatrixPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; id: string }>;
}) {
  const { tenant, locale, adminPath, id } = use(params);
  const [{ unit }, setUrl] = useUrlState(MATRIX_URL);
  const selectUnit = useCallback(
    (unitId: string | null) => setUrl({ unit: unitId ?? '' }),
    [setUrl],
  );

  return (
    <BuildingUnitMatrixView
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      buildingId={id}
      selectedUnitId={unit || null}
      onSelectUnit={selectUnit}
    />
  );
}
