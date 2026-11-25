'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { QUALITY_CHECK_ROLES } from '@mechanization/shared-schemas';
import { getOfficerQuality } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { param, useUrlState } from '@/lib/use-url-state';
import { PageTabs } from '@/components/admin/page-tabs';
import { CHECKS_URL, ChecksPanel } from '@/components/admin/quality/checks-panel';
import { FINDINGS_URL, FindingsList } from '@/components/admin/quality/findings-list';
import { OfficerQuality } from '@/components/admin/quality/officer-quality';
import { REVIEW_QUEUE_URL, ReviewQueue } from '@/components/admin/quality/review-queue';

/** The four screens of «الجودة», as `?tab=` names them. The first is where the old `/quality` landed. */
export const QUALITY_TABS = ['reviews', 'findings', 'checks', 'officers'] as const;
export type QualityTab = (typeof QUALITY_TABS)[number];

const TAB_URL = { tab: param.oneOf(QUALITY_TABS, 'reviews') };

/**
 * Every parameter a panel keeps in the URL, which a change of tab clears.
 *
 * The panels were pages of their own and two of them page their table with
 * `?page=` and `?limit=`, so the second tab would open on the first's page 3.
 * Taken from the panels' own schemas, so a new filter is cleared without anyone
 * remembering to list it here.
 */
export const QUALITY_PANEL_KEYS: readonly string[] = [
  ...new Set(['page', 'limit', ...Object.keys(REVIEW_QUEUE_URL), ...Object.keys(FINDINGS_URL), ...Object.keys(CHECKS_URL)]),
];

/**
 * «الجودة» (NAV-03, NAV-11): the four screens of quality review as tabs of one
 * page, where they were four rows of the sidebar and four pages with the same
 * frame. The first is «اعتماد السجلات» — the one with a queue, where a reviewer
 * spends the morning — and the open tab is `?tab=`, so a link names one.
 * The old addresses (`/quality/reviews` …) forward here.
 *
 * Every panel reads only once there is a token, which `QualityScreen` hands
 * over after the reviewer role is checked.
 */
export function QualityTabs({
  tenant,
  base,
  locale,
  token,
  role,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string;
  role: string;
}): React.JSX.Element {
  const t = useTranslations('quality');
  const [{ tab }, setUrl] = useUrlState(TAB_URL);

  return (
    <PageTabs
      tab={tab}
      onSelect={(id) => setUrl({ tab: id as QualityTab }, { clear: QUALITY_PANEL_KEYS })}
      locale={locale}
      label={t('tabsLabel')}
      tabs={[
        {
          id: 'reviews',
          label: t('tabs.reviews'),
          panel: <ReviewsBody tenant={tenant} base={base} locale={locale} token={token} />,
        },
        {
          id: 'findings',
          label: t('tabs.findings'),
          panel: <FindingsList tenant={tenant} base={base} locale={locale} token={token} role={role} />,
        },
        {
          id: 'checks',
          label: t('tabs.checks'),
          panel: <ChecksBody tenant={tenant} base={base} locale={locale} token={token} />,
        },
        {
          id: 'officers',
          label: t('tabs.officers'),
          panel: <OfficerQuality tenant={tenant} base={base} locale={locale} token={token} />,
        },
      ]}
    />
  );
}

/**
 * Split out so the officer list is fetched only once this tab is open and has a
 * token — the names its «الموظف الذي سجَّل» filter offers.
 *
 * From the quality endpoint rather than `GET /staff`, which is SUPER_ADMIN's
 * alone: an AUDITOR may review records and would otherwise be handed an empty
 * select by a 403.
 */
function ReviewsBody({
  tenant,
  base,
  locale,
  token,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string;
}): React.JSX.Element {
  const staff = useStaffQuery({
    // The key «حسب الموظف» uses for the same unfiltered call, so the two
    // screens share one response instead of each paying for the scans behind it.
    queryKey: ['quality-officers', tenant, 'all'],
    queryFn: (tok, signal) => getOfficerQuality(tenant, tok, {}, signal),
    tenant,
    base,
    token,
    errorMessage: '',
  });

  const officers = useMemo(
    () => (staff.data?.officers ?? []).map((person) => ({ id: person.id, name: person.name })),
    [staff.data],
  );

  return <ReviewQueue tenant={tenant} base={base} locale={locale} token={token} officers={officers} />;
}

/** Whom a re-check can be handed to: the server refuses anyone else. */
function ChecksBody({
  tenant,
  base,
  locale,
  token,
}: {
  tenant: string;
  base: string;
  locale: string;
  token: string;
}): React.JSX.Element {
  const staff = useStaffQuery({
    queryKey: ['quality-officers', tenant, 'all'],
    queryFn: (tok, signal) => getOfficerQuality(tenant, tok, {}, signal),
    tenant,
    base,
    token,
    errorMessage: '',
  });

  const checkers = useMemo(
    () =>
      (staff.data?.officers ?? [])
        .filter(
          (person) =>
            person.isActive && (QUALITY_CHECK_ROLES as readonly string[]).includes(person.role ?? ''),
        )
        .map((person) => ({ id: person.id, name: person.name })),
    [staff.data],
  );

  return (
    <ChecksPanel tenant={tenant} base={base} locale={locale} token={token} canReview officers={checkers} />
  );
}
