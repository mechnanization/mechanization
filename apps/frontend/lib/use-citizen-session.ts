'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiRequestError } from './api-client';
import { clearSession, loadSession } from './session';

/**
 * The signed-in citizen's token on a portal page, the way «ملفّي» reads it: a
 * staff session or none sends the visitor to the front door, which is the one
 * way in (no second sign-in form on an inner page). Null until the session has
 * been read on the client.
 *
 * `endIfSignedOut` is for a read or a write that came back 401: the session has
 * ended (expired, revoked), so it is cleared and the visitor goes back to the
 * front door. It answers whether it did, so the caller stops there.
 */
export function useCitizenSession(tenant: string, base: string): {
  token: string | null;
  /** The signed-in citizen's id, with the token; what a per-citizen key scope is named by. */
  citizenId: string | null;
  endIfSignedOut: (caught: unknown) => boolean;
} {
  const router = useRouter();
  const [signedIn, setSignedIn] = useState<{ token: string; citizenId: string } | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (session?.user.kind === 'CITIZEN') setSignedIn({ token: session.accessToken, citizenId: session.user.id });
    else router.replace(base);
  }, [tenant, base, router]);

  const endIfSignedOut = useCallback(
    (caught: unknown): boolean => {
      if (!(caught instanceof ApiRequestError) || caught.status !== 401) return false;
      clearSession(tenant);
      router.replace(base);
      return true;
    },
    [tenant, base, router],
  );

  return { token: signedIn?.token ?? null, citizenId: signedIn?.citizenId ?? null, endIfSignedOut };
}
