'use client';

import { use } from 'react';
import { UsersRound } from 'lucide-react';
import { QualityScreen } from '@/components/admin/quality/quality-screen';
import { OfficerQuality } from '@/components/admin/quality/officer-quality';

/**
 * «حسب الموظف» — the work beside its quality, and nothing about pay.
 *
 * Deliberately not a score. Each figure names something a reader can open, and
 * the only one that is evidence rather than a proxy — how often a re-check on
 * the ground found something different — reads largest.
 *
 * An officer sees their own row on «أرباحي والمسح الميداني»; this page is the
 * oversight view and is held to the reviewer roles.
 */
export default function QualityOfficersPage({
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
      icon={UsersRound}
      title={en ? 'Quality by officer' : 'الجودة حسب الموظف'}
      subtitle={
        en
          ? 'How each officer’s filings are faring — returned records, open findings, and what re-checks found.'
          : 'كيف تسير سجلات كل موظف — ما أُعيد منها، وملاحظات الجودة عليها، وما وجده التحقق الميداني.'
      }
    >
      {({ token, base }) => (
        <OfficerQuality tenant={tenant} base={base} locale={locale} token={token} />
      )}
    </QualityScreen>
  );
}
