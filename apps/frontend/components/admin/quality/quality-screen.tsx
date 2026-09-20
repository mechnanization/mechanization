'use client';

import type { LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useStaffSession } from '@/lib/use-staff-session';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Who may open any of the four «مراجعة الجودة» screens.
 *
 * The same list `QualityController` enforces with `REVIEWER_ROLES`. Stated here
 * as well because the sidebar and the route guard have to agree with the
 * server — a row offered to a role the endpoint refuses is a link the portal
 * hands somebody so it can 403 them.
 */
export const QUALITY_REVIEWER_ROLES: readonly string[] = [
  'SUPER_ADMIN',
  'AUDITOR',
  'ADMINISTRATIVE_OFFICER',
];

/**
 * The chrome every quality screen shares: the session, the role gate, and a
 * heading.
 *
 * These were four tabs of one page and are four pages now, which would
 * otherwise be the same twenty lines of session-reading and redirecting copied
 * four times — and a copy that forgets the role check is a screen that renders
 * for an officer until its first request comes back 403.
 *
 * The token arrives through a function child rather than context: each screen
 * needs it for exactly one query, and a provider for a single string is
 * ceremony.
 */
export function QualityScreen({
  tenant,
  locale,
  adminPath,
  icon,
  title,
  subtitle,
  children,
}: {
  tenant: string;
  locale: string;
  adminPath: string;
  icon: LucideIcon;
  title: string;
  subtitle: string;
  children: (context: { token: string; base: string; locale: string }) => React.ReactNode;
}): React.JSX.Element {
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const { token, user } = useStaffSession(tenant, base);

  /*
    An officer's own side of this — records sent back to them, re-checks they
    may do — lives on «أرباحي والمسح الميداني». Sending them there rather than
    showing an empty screen is the difference between "not yours" and "nothing
    here".
  */
  useEffect(() => {
    if (!user) return;
    if (!QUALITY_REVIEWER_ROLES.includes(user.role)) {
      router.replace(`${base}/inspector/profile`);
    }
  }, [user, base, router]);

  const allowed = user !== null && QUALITY_REVIEWER_ROLES.includes(user.role);

  if (!token || !allowed) {
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

  return (
    <div className="w-full space-y-5 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={icon} title={title} subtitle={subtitle} />
      {children({ token, base, locale })}
    </div>
  );
}
