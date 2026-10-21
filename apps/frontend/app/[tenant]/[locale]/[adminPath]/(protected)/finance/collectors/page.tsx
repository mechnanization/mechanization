'use client';

import { use } from 'react';
import { useTranslations } from 'next-intl';
import { HandCoins } from 'lucide-react';
import { useStaffSession } from '@/lib/use-staff-session';
import { CollectorCustodyPanel } from '@/components/admin/finance/collector-custody-panel';
import { PageHeader } from '@/components/ui/page-header';

/**
 * «الجباة والتحصيل» — what each collector is still carrying, and receiving it
 * into the safe.
 *
 * Apart from «الخزينة» on purpose: money in a collector's pocket is not the
 * treasury's until it is counted and handed in, so it does not sit on the page
 * of balances. This is where the accountant works the end of a round.
 *
 * Reading is `TREASURY_READ_ROLES` (the `/finance/collectors` nav row and
 * `GET /treasury/transfers/custody` both enforce it). Receiving is
 * `TREASURY_WORK_ROLES`, checked inside the panel against the user's role and
 * by `POST /treasury/transfers/custody/receive`. Each collector's receipts open
 * at `/finance/collectors/:collectorId`.
 */
export default function CollectorsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.collectors');
  const { token, user } = useStaffSession(tenant, base);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={HandCoins} title={t('title')} />
      <CollectorCustodyPanel
        tenant={tenant}
        base={base}
        token={token}
        locale={locale}
        role={user?.role}
        actorId={user?.id}
      />
    </div>
  );
}
