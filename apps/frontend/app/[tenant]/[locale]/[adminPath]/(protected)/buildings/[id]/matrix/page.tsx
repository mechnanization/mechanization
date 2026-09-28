'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
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
  /*
    Where the end page hands the officer back: the flat they were working on,
    and — after a sale answered «نعم، أضف المالك الجديد» — the add-person form
    already open on «مالك». Both are starting points, not state the URL keeps
    in step afterwards.
  */
  const query = useSearchParams();

  return (
    <BuildingUnitMatrixView
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      buildingId={id}
      initialUnitId={query.get('unit')}
      initialAddOwner={query.get('addOwner') === '1'}
    />
  );
}
