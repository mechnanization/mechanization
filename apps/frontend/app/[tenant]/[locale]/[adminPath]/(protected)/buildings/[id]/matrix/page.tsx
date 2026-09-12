'use client';

import { use } from 'react';
import { BuildingUnitMatrixView } from '@/components/admin/building-unit-matrix-view';

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

  return (
    <BuildingUnitMatrixView tenant={tenant} locale={locale} adminPath={adminPath} buildingId={id} />
  );
}
