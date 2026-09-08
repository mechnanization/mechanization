'use client';

import { use } from 'react';
import { CaseEditor } from '@/components/admin/case-editor';

/** Correct a case already logged. Same form as `cases/new`, seeded. */
export default function EditCasePage({
  params,
}: {
  params: Promise<{
    tenant: string;
    locale: string;
    adminPath: string;
    caseId: string;
  }>;
}) {
  const { tenant, locale, adminPath, caseId } = use(params);
  return <CaseEditor tenant={tenant} locale={locale} adminPath={adminPath} caseId={caseId} />;
}
