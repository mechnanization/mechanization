'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { defaultPathFor } from '@/components/admin/nav';
import { useStaffSession } from '@/lib/use-staff-session';
import { Skeleton } from '@/components/ui/skeleton';

export default function AdminIndexPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const { user } = useStaffSession(tenant, base);

  useEffect(() => {
    // `replace`: this URL is a signpost, not a destination. Leaving it in
    // history means Back lands on a page that immediately forwards again.
    if (user) router.replace(`${base}${defaultPathFor(user.role)}`);
  }, [user, base, router]);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <Skeleton className="size-10 rounded-xl" />
        <div className="space-y-1.5">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
      </div>
      <div className="space-y-4">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-[28rem] w-full rounded-xl" />
      </div>
    </div>
  );
}
