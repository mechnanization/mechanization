'use client';

import { use } from 'react';
import { ScanSearch } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { WORKLIST_ROLES } from '@/lib/staff-roles';
import { param, useUrlState } from '@/lib/use-url-state';
import { WORKLIST_TABS, type WorklistTab } from '@/lib/worklist-tabs';
import { PageHeader } from '@/components/ui/page-header';
import { navLabel } from '@/components/admin/nav';
import { PageTabs } from '@/components/admin/page-tabs';
import { useRoleGate } from '@/components/admin/use-role-gate';
import { ReinspectionsWorklist } from '@/components/admin/worklists/reinspections-worklist';
import { UnsurveyedWorklist } from '@/components/admin/worklists/unsurveyed-worklist';

const TAB_URL = { tab: param.oneOf(WORKLIST_TABS, 'unsurveyed') };

/**
 * «قوائم العمل الميداني» — the visits still owed, as the tabs of one page
 * (NAV-04, decided 2026-11-25, open-decisions §25): «وحدات غير ممسوحة»
 * (`?tab=unsurveyed`, the first) and «بانتظار إعادة الكشف» (`?tab=reinspections`).
 *
 * They were two rows of the sidebar and two pages with the same shape. Each tab
 * keeps its own page, page size and officer filter in the URL under names of
 * its own (`lib/worklist-tabs.ts`), so going to the other tab and back finds
 * them as they were; its search stays in the tab's storage, as before.
 *
 * `WORKLIST_ROLES` (the roles the server serves both lists to) is checked here,
 * not only by the row: `canAccessPath` falls through to the `/buildings` row a
 * role can see, so one outside the set reached the page and read an error. It is
 * sent to the building register instead, with a toast saying why, and neither
 * tab is mounted for it.
 */
export default function FieldWorklistsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const t = useTranslations('fieldWorklists');
  const [{ tab }, setUrl] = useUrlState(TAB_URL);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const gate = useRoleGate(tenant, base, WORKLIST_ROLES, { to: `${base}/buildings`, reason: 'fieldWorklists' });

  // Nothing until the session is read, and nothing for a role the server would only refuse.
  if (gate.allowed !== true) return null;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={ScanSearch} title={navLabel('fieldWorklists', locale)} />
      <PageTabs
        tab={tab}
        onSelect={(id) => setUrl({ tab: id as WorklistTab })}
        locale={locale}
        label={t('tabsLabel')}
        tabs={[
          {
            id: 'unsurveyed',
            label: t('tabs.unsurveyed'),
            panel: <UnsurveyedWorklist tenant={tenant} locale={locale} adminPath={adminPath} />,
          },
          {
            id: 'reinspections',
            label: t('tabs.reinspections'),
            panel: <ReinspectionsWorklist tenant={tenant} locale={locale} adminPath={adminPath} />,
          },
        ]}
      />
    </div>
  );
}
