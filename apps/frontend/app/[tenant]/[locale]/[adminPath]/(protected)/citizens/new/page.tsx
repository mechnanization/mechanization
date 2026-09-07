'use client';

import { use } from 'react';
import { useSearchParams } from 'next/navigation';
import { CitizenEditor } from '@/components/admin/citizen-editor';

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
  const fromCaseId = useSearchParams().get('fromCaseId') ?? undefined;
  return (
    <CitizenEditor tenant={tenant} locale={locale} adminPath={adminPath} fromCaseId={fromCaseId} />
  );
}
