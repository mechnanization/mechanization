'use client';

import { use } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { QualityScreen } from '@/components/admin/quality/quality-screen';
import { QualityTabs } from '@/components/admin/quality/quality-tabs';

/**
 * «الجودة» — what the register can tell is probably wrong, and the second pair
 * of eyes on what officers record: four screens as the tabs of one page
 * (NAV-03, decided 2026-11-25, open-decisions §25).
 *
 * «اعتماد السجلات» (`?tab=reviews`, the first) is the queue a reviewer works;
 * «الملاحظات» what the register itself says is wrong, recomputed on every read;
 * «التحقق الميداني» a share of each officer's records re-checked on the ground;
 * «حسب الموظف» the work beside its quality, and nothing about pay. They were
 * four rows and four pages under `/quality/…`, which forward here with their
 * query strings kept. `QualityScreen` is the one role gate (`QUALITY_REVIEWER_ROLES`):
 * an officer's own side of it is on «أرباحي والمسح الميداني».
 */
export default function QualityPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath } = use(params);
  const t = useTranslations('quality');

  return (
    <QualityScreen tenant={tenant} locale={locale} adminPath={adminPath} icon={ClipboardCheck} title={t('title')}>
      {({ token, base, role }) => (
        <QualityTabs tenant={tenant} base={base} locale={locale} token={token} role={role} />
      )}
    </QualityScreen>
  );
}
