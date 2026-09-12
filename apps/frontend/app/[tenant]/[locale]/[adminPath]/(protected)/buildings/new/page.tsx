'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { BuildingEditor } from '@/components/admin/building-editor';

/**
 * Dedicated page for creating a new building structure.
 *
 * Sits under `buildings/new` rather than opening a modal dialog, offering a
 * professional, responsive, and distraction-free workflow with interactive
 * parcel map pin picker, unit matrix blueprint generator, and duplicate detection.
 *
 * Query params:
 * `?parcelNumber=` can optionally pre-populate the parcel number field.
 */
export default function NewBuildingPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const searchParams = useSearchParams();
  const initialParcelNumber = searchParams.get('parcelNumber') ?? undefined;

  return (
    <BuildingEditor
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      initialParcelNumber={initialParcelNumber}
    />
  );
}

