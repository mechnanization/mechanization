'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadSession } from './session';

export interface StaffSessionUser {
  id: string;
  role: string;
  name: string;
}

/**
 * The signed-in staff member, read once on mount.
 *
 * `useStaffQuery` already waits for a token before it fires, but it never
 * produces one — every admin screen was opening with the same effect: read the
 * session out of storage, bounce to the login page if it is missing or belongs
 * to a citizen, then hold the token and the claims in two `useState`s. Three
 * screens share the inspector earnings feature alone, and a copy of this that
 * forgets the `kind !== 'STAFF'` check is a citizen session rendering a staff
 * page until the first request comes back 403.
 *
 * Both values are null until the effect has run, which on the first paint is
 * indistinguishable from "not signed in" — callers show their skeleton while
 * `token` is null rather than treating it as a refusal.
 */
export function useStaffSession(
  tenant: string,
  /** `/{tenant}/{locale}/{adminPath}` — what the login redirect hangs off. */
  base: string,
): { token: string | null; user: StaffSessionUser | null } {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<StaffSessionUser | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setUser({
      id: session.user.id,
      role: session.user.role ?? '',
      name: session.user.name,
    });
  }, [tenant, base, router]);

  return { token, user };
}
