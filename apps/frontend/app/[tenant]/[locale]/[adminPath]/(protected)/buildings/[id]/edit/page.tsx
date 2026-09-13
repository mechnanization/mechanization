'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { BuildingEditor } from '@/components/admin/building-editor';

/**
 * Correcting a building on the same wizard that creates one.
 *
 * A page rather than the modal dialog it replaces: an edit asks the same
 * questions a creation does — where the entrance is, what the structure is, and
 * which flats are inside it — and the unit matrix in particular needs the room.
 *
 * Query params:
 *
 * `?step=units` opens straight on the unit matrix, which is what «توليد
 * المصفوفة» on an empty shell and «تعديل مصفوفة الوحدات» on a populated one are
 * both asking for.
 *
 * `?scope=info` is the other half of that split: «تعديل معلومات المبنى» edits
 * the shell — the entrance, the name, the type, the status — and leaves the
 * matrix alone. The two were one button, and merging them meant an officer
 * correcting a misspelled building name walked through the unit matrix to get
 * to the save, with every unit on it loaded into a form that diffs on save. The
 * shortest path to fixing a name should not pass through the flats.
 */
export default function EditBuildingPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; id: string }>;
}) {
  const { tenant, locale, adminPath, id } = use(params);
  const searchParams = useSearchParams();
  const onMatrix = searchParams.get('step') === 'units';

  return (
    <BuildingEditor
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      buildingId={id}
      initialStep={onMatrix ? 2 : 0}
      // `?step=units` wins: asking for the matrix and for info-only at once is
      // a contradiction, and the explicit step is the more specific request.
      scope={!onMatrix && searchParams.get('scope') === 'info' ? 'info' : 'all'}
    />
  );
}
