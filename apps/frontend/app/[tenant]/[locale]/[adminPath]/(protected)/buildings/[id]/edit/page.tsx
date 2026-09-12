'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { BuildingEditor } from '@/components/admin/building-editor';

/**
 * Correcting a building on the same wizard that creates one.
 *
 * A page rather than the modal dialog it replaces: an edit asks the same three
 * questions a creation does — where the entrance is, what the structure is, and
 * which flats are inside it — and the unit matrix in particular needs the room.
 * Floors and units are added here, against the matrix the building already has.
 *
 * Query params:
 * `?step=units` opens straight on the unit matrix, which is what «توليد
 * المصفوفة» on an empty shell is asking for.
 */
export default function EditBuildingPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; id: string }>;
}) {
  const { tenant, locale, adminPath, id } = use(params);
  const searchParams = useSearchParams();

  return (
    <BuildingEditor
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      buildingId={id}
      initialStep={searchParams.get('step') === 'units' ? 2 : 0}
    />
  );
}
