'use client';

import { use } from 'react';
import { ShieldQuestion } from 'lucide-react';
import { QualityScreen } from '@/components/admin/quality/quality-screen';
import { FindingsList } from '@/components/admin/quality/findings-list';

/**
 * «ملاحظات الجودة» — what the register itself can tell is probably wrong.
 *
 * Recomputed on every read, so a finding disappears the moment the record is
 * fixed. The only thing stored against a finding is «تم الحل» and the reason
 * somebody gave for it.
 *
 * Three views behind this one route — the queue, one finding's detail, and two
 * conflicting records side by side. `FindingsList` says why they are views
 * rather than three routes.
 */
export default function QualityFindingsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath } = use(params);
  const en = locale === 'en';

  return (
    <QualityScreen
      tenant={tenant}
      locale={locale}
      adminPath={adminPath}
      icon={ShieldQuestion}
      title={en ? 'Quality findings' : 'ملاحظات الجودة'}
      subtitle={
        en
          ? 'Duplicate records, copied numbers and contradictions the register can find on its own.'
          : 'سجلات مكرَّرة وأرقام منقولة وتناقضات يستطيع السجل أن يجدها بنفسه.'
      }
    >
      {({ token, base, role }) => (
        <FindingsList tenant={tenant} base={base} locale={locale} token={token} role={role} />
      )}
    </QualityScreen>
  );
}
