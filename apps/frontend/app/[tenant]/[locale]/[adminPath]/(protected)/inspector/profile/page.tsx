'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { InspectorEarningsRoster } from '@/components/admin/inspector-earnings-roster';
import { InspectorProfileDetail } from '@/components/admin/inspector-profile-detail';
import { useStaffSession } from '@/lib/use-staff-session';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «أرباحي والمسح الميداني» — two screens behind one nav row, because the
 * question the page answers depends on who opened it.
 *
 * A SUPER_ADMIN is here to settle up, and that is a comparison: every
 * inspector's earnings, what has been paid, what is still owed, with the
 * payout and the ledger one click from each row. Everybody else can only ever
 * see their own figures — `GET /staff` is SUPER_ADMIN-only, so a roster for a
 * field inspector would be a 403 on their own landing page — and they get the
 * dashboard this route has always shown them.
 *
 * The split is on the role rather than on the URL so neither audience has to
 * learn a second address for the row they already click.
 */
export default function InspectorEarningsPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams?: Promise<{ inspectorId?: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath } = use(params);
  const inspectorId = (searchParams ? use(searchParams) : undefined)?.inspectorId;

  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const { token, user } = useStaffSession(tenant, base);

  /*
    `?inspectorId=` was how this page used to select whose dashboard to show,
    and those links are in people's history and in at least one bookmark. It
    is a path segment now — a dashboard is a page, not a filter — so the old
    shape is forwarded rather than quietly ignored. `replace`, so Back does not
    land on the URL that just redirected.
  */
  useEffect(() => {
    if (!inspectorId) return;
    router.replace(`${base}/inspector/profile/${inspectorId}`);
  }, [inspectorId, base, router]);

  if (!token || !user || inspectorId) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-52 rounded-xl" />
      </div>
    );
  }

  if (user.role === 'SUPER_ADMIN') {
    return (
      <InspectorEarningsRoster tenant={tenant} locale={locale} base={base} token={token} />
    );
  }

  return (
    <InspectorProfileDetail
      tenant={tenant}
      locale={locale}
      base={base}
      token={token}
      currentUser={user}
    />
  );
}
