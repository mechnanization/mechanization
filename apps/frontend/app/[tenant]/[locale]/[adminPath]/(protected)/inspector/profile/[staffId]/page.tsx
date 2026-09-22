'use client';

import { use } from 'react';
import { InspectorProfileDetail } from '@/components/admin/inspector-profile-detail';
import { useStaffSession } from '@/lib/use-staff-session';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * One inspector's dashboard, reached from the earnings roster or from the
 * staff directory's per-row shortcut.
 *
 * Who may open it is the server's decision, not this file's:
 * `inspectors/:id/profile` admits a SUPER_ADMIN or the inspector asking about
 * themselves and refuses everyone else. Guessing a colleague's id here gets a
 * 403, which is the answer.
 */
export default function InspectorProfilePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string; staffId: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath, staffId } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const { token, user } = useStaffSession(tenant, base);

  if (!token || !user) {
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

  return (
    <InspectorProfileDetail
      tenant={tenant}
      locale={locale}
      base={base}
      token={token}
      currentUser={user}
      staffId={staffId}
    />
  );
}
