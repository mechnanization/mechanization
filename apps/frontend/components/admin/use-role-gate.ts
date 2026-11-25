'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { hasRole } from '@/lib/staff-roles';
import { useStaffSession } from '@/lib/use-staff-session';
import { useToast } from '@/components/ui/toast';

/** The `access` message that says why a page is not for the role (`messages.access`). */
export type TurnedAwayReason = 'registerCitizen' | 'feeCorrections' | 'fieldWorklists';

/**
 * A page turning away a role it is not for (NAV-02, NAV-07, and the field worklists, NAV-04).
 *
 * A path under no row opens to every role (`canAccessPath`), so when a row
 * leaves the sidebar the page has to say who it is for itself, as `CaseEditor`
 * does. This is that, once: the staff session, `allowed` while it is read
 * (`null`) and after (`true` or `false`), and for a role outside `roles` a
 * toast saying why and a `router.replace` to `to`, once. `token` is null unless
 * the role is allowed, so a page that reads with it asks nothing for a role the
 * server would refuse. The server stays the enforcement.
 */
export function useRoleGate(
  tenant: string,
  base: string,
  roles: readonly string[],
  turnedAway: { to: string; reason: TurnedAwayReason },
): { allowed: boolean | null; token: string | null; role: string | null } {
  const router = useRouter();
  const toast = useToast();
  const t = useTranslations('access');
  const staff = useStaffSession(tenant, base);
  const allowed = staff.user === null ? null : hasRole(roles, staff.user.role);
  const sent = useRef(false);
  const { to, reason } = turnedAway;

  useEffect(() => {
    if (allowed !== false || sent.current) return;
    sent.current = true;
    toast.info(t('title'), { description: t(reason) });
    router.replace(to);
  }, [allowed, reason, router, t, to, toast]);

  return { allowed, token: allowed ? staff.token : null, role: staff.user?.role ?? null };
}
