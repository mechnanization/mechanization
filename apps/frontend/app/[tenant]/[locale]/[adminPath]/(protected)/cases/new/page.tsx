'use client';

import { use } from 'react';
import { CaseEditor } from '@/components/admin/case-editor';

/**
 * Log a case from the field.
 *
 * Sits under `cases/new` rather than `cases/[caseId]` for the obvious reason
 * — there is no id yet — which also means Next resolves `new` as the static
 * segment before the dynamic one, so it can never be read as a case whose id
 * happens to be "new".
 */
export default function NewCasePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  return <CaseEditor tenant={tenant} locale={locale} adminPath={adminPath} />;
}
