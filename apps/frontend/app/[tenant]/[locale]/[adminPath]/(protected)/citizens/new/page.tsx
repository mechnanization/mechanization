'use client';

import { use, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CITIZEN_RESIDENCE } from '@mechanization/shared-schemas';
import { CitizenEditor } from '@/components/admin/citizen-editor';
import { readLinkSeed } from '@/lib/tab-search';

/**
 * Register a citizen from the counter.
 *
 * Sits under `citizens/new` rather than `citizens/[citizenId]` for the obvious
 * reason — there is no id yet — which also means Next resolves `new` as the
 * static segment before the dynamic one, so it can never be read as a citizen
 * whose id happens to be "new".
 *
 * `?fromCaseId=` arrives from the "Register Citizen" action on an open حالة —
 * it seeds the first property card from what that visit already recorded, and
 * resolves the case back to whoever gets created here. See `CitizenEditor`.
 */
export default function NewCitizenPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const searchParams = useSearchParams();
  const fromCaseId = searchParams.get('fromCaseId') ?? undefined;

  /*
    `?buildingId=&unitId=` arrives from a unit in the census matrix — "register
    whoever is in this flat". The building half is what the form locks onto; the
    unit half narrows the tick-list to the flat that was actually tapped.
  */
  const buildingId = searchParams.get('buildingId');
  const lockedCensusTarget = buildingId
    ? { buildingId, unitId: searchParams.get('unitId') ?? undefined }
    : null;

  /*
    `?residence=` arrives with the unit link when the officer has already said
    «مالك غير مقيم» on the unit panel. Anything other than a known value is
    ignored, and the form opens on its ordinary household default.
  */
  const residence = searchParams.get('residence');
  const initialResidence = CITIZEN_RESIDENCE.find((value) => value === residence);

  /*
    The search seed is whatever the officer had typed into the occupant search
    on the unit panel before deciding nobody there was the person — a name or,
    as often, a phone number. The form decides which field it fills
    (`withSeededSearch`).

    Read from tab storage, bound to this exact link (`stashLinkSeed`), not from
    the URL: it was `?name=` until 2026-10-03, which put a person's name in
    browser history and in the host's request log on every reload. Read once,
    on the client — the server render has no storage, and the editor shows
    nothing that depends on it until its own data has loaded.

    Carried so the search is not retyped, and — more to the point — so the
    duplicate check in the form has something to check on the first render.
    The panel's search is only a gate on *a* search having run («asdfgh» opens
    it); the check that «asdfgh» cannot pass is the one here, against the name
    and phone actually being entered.
  */
  const [initialSearch] = useState(() =>
    typeof window === 'undefined'
      ? undefined
      : readLinkSeed(tenant, `${window.location.pathname}${window.location.search}`),
  );

  return (
    <CitizenEditor
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      fromCaseId={fromCaseId}
      lockedCensusTarget={lockedCensusTarget}
      initialResidence={initialResidence}
      initialSearch={initialSearch}
    />
  );
}
