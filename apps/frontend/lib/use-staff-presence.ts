'use client';

import { useMemo } from 'react';
import { isStaffOnline } from '@mechanization/shared-schemas';
import { getStaffPresence } from './api-client';
import { useStaffQuery } from './use-staff-query';

/**
 * «متصل الآن» / «آخر ظهور» for the staff page — a light read polled once a
 * minute, apart from the roster.
 *
 * The roster computes every inspector's earnings over every filing they made;
 * re-reading it on a timer to learn who is online was the cost this replaces.
 * The presence read is a background request (it does not keep the admin
 * reading it «متصل»), and it carries the server's clock: `now()` is that clock
 * moved on by the time since it arrived, so neither the online label
 * (`isStaffOnline`) nor «منذ ٥ دقائق» depends on the browser's clock being
 * right. The minute matches the server's stamp interval, and the re-render it
 * causes is what moves the relative labels along.
 */
export function useStaffPresence(input: { tenant: string; base: string; token: string | null; errorMessage: string }) {
  const query = useStaffQuery({
    queryKey: ['staff', input.tenant, 'presence'],
    queryFn: (accessToken, signal) => getStaffPresence(input.tenant, accessToken, signal),
    tenant: input.tenant,
    base: input.base,
    token: input.token,
    errorMessage: input.errorMessage,
    refreshMs: 60_000,
  });

  return useMemo(() => {
    const data = query.data;
    const receivedAt = Date.now();
    const serverNow = data ? Date.parse(data.now) : receivedAt;
    const seen = new Map((data?.items ?? []).map((item) => [item.id, item.lastSeenAt]));
    const now = () => serverNow + (Date.now() - receivedAt);
    return {
      /** «آخر ظهور» for one account, or null when never seen (or not yet read). */
      lastSeen: (id: string): string | null => seen.get(id) ?? null,
      /** Whether this account counts as at the system now, on the server's clock. */
      isOnline: (id: string): boolean => isStaffOnline(seen.get(id) ?? null, now()),
      now,
    };
  }, [query.data]);
}
