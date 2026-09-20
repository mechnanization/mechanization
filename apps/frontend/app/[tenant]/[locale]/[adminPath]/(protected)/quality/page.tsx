'use client';

import { use, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * «مراجعة الجودة» was one page with four tabs; it is four pages now.
 *
 * This address stays as a forward rather than a 404. It is what the sidebar
 * pointed at until this change, so it is in browser histories and in at least
 * one bookmark, and a link that silently became nothing is worse than one that
 * still lands somewhere sensible.
 *
 * «السجلات» is the destination because it is the one with a queue: the other
 * three are things you go and look at, that one is work waiting to be done.
 */
export default function QualityIndexPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}): React.JSX.Element {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();

  useEffect(() => {
    // `replace`, so Back does not land on the address that just forwarded.
    router.replace(`/${tenant}/${locale}/${adminPath}/quality/reviews`);
  }, [tenant, locale, adminPath, router]);

  return (
    <div className="w-full space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <div className="flex items-center gap-3">
        <Skeleton className="size-11 rounded-xl" />
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}
