'use client';

import { use, useMemo } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { getOfficerQuality } from '@/lib/quality-api';
import { useStaffQuery } from '@/lib/use-staff-query';
import { QualityScreen } from '@/components/admin/quality/quality-screen';
import { ReviewQueue } from '@/components/admin/quality/review-queue';

/**
 * «السجلات» — records waiting for a second pair of eyes.
 *
 * Its own page rather than a tab, because it is where a reviewer spends the
 * morning: a tab cannot be linked to from a notification, cannot be opened in
 * a second window beside «المواطنون», and puts three screens' worth of queries
 * behind one address.
 */
export default function QualityReviewsPage({
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
      icon={ClipboardCheck}
      title={en ? 'Records to review' : 'السجلات'}
      subtitle={
        en
          ? 'What the field filed, waiting on a decision — approve it, or send it back with a reason.'
          : 'ما سجَّله الميدان بانتظار قرار — اعتماده، أو إعادته إلى الموظف مع السبب.'
      }
    >
      {({ token, base }) => (
        <ReviewsBody tenant={tenant} base={base} locale={locale} token={token} />
      )}
    </QualityScreen>
  );
}

/**
 * Split out so the officer list is fetched only once this screen is allowed
 * and has a token — the names its «الموظف الذي سجَّل» filter offers.
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
