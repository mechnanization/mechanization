'use client';

import { use, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import {
  ApiRequestError,
  getRegisteredParcels,

  logApiError,

} from '@/lib/api-client';
import type { RegisteredParcel, Session } from '@/lib/api-client';
import { clearSession, loadSession } from '@/lib/session';
import { Button } from '@/components/ui/button';

/**
 * Mapbox GL JS plus a megabyte of cadastre GeoJSON, loaded only when a staff
 * member opens this route — never on the citizen wizard, which is the bundle
 * that actually matters.
 */
const FullscreenMap = dynamic(
  () => import('@/components/admin/fullscreen-map').then((m) => m.FullscreenMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        Loading map…
      </div>
    ),
  },
);

/**
 * `flex h-full flex-col`: a header in normal flow, the map filling exactly
 * the remainder via `flex-1`. `h-full` rather than `h-screen` because this
 * page now renders inside the admin sidebar layout's own `h-screen` flex
 * row — sizing to the viewport a second time here would just add a nested
 * scrollbar instead of filling the space the layout already gave it.
 */
export default function FullscreenMapPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [session, setSession] = useState<Session | null>(null);
  const [parcels, setParcels] = useState<RegisteredParcel[]>([]);
  const [error, setError] = useState<string | null>(null);

  /**
   * Arriving from a citizen's profile ("عرض على الخريطة") carries where to
   * point the map: `parcel` when the property is a registered one (the common
   * case — flies in and opens the same drawer a marker click would), `lat`/
   * `lng` as a fallback the map can still pin even if the property number
   * doesn't resolve to a registered parcel.
   *
   * `useSearchParams` rather than reading `window.location.search` once on
   * mount: this page is one route (`/map`), so going from one citizen's pin
   * straight to another's — or back to the plain map and in again — changes
   * only the query string, which does not always remount this component. A
   * mount-only read went stale exactly in that case; this hook re-renders
   * whenever the query string itself changes, mount or not.
   */
  const searchParams = useSearchParams();
  const focus = useMemo(() => {
    const parcelNumber = searchParams.get('parcel') ?? undefined;
    const lat = searchParams.get('lat');
    const lng = searchParams.get('lng');
    if (!parcelNumber && !(lat && lng)) return null;
    return {
      parcelNumber,
      lat: lat ? Number(lat) : undefined,
      lng: lng ? Number(lng) : undefined,
    };
  }, [searchParams]);

  /** Bumped after a cadastre import in settings would change the layers. */
  const [refreshToken] = useState(0);

  const token = session?.accessToken ?? null;

  useEffect(() => {
    const existing = loadSession(tenant);
    if (!existing || existing.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setSession(existing);
  }, [tenant, base, router]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    getRegisteredParcels(tenant, token)
      .then((response) => {
        if (!cancelled) setParcels(response.parcels);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.status === 401) {
          clearSession(tenant);
          router.replace(`${base}/login`);
          return;
        }
        setError(locale === 'en' ? 'Failed to load map data.' : 'تعذّر تحميل بيانات الخريطة.');
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, base, router, locale]);

  return (
    <div className="flex h-full flex-col">
      <div className="relative flex-1">
        {!token ? null : error ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-4">
            <p role="alert" className="text-destructive">
              {error}
            </p>
            <Button variant="outline" onClick={() => router.push(`${base}/dashboard`)}>
              {locale === 'en' ? 'Back to Dashboard' : 'رجوع إلى اللوحة'}
            </Button>
          </div>
        ) : (
          <FullscreenMap
            tenant={tenant}
            token={token}
            parcels={parcels}
            citizenHref={(citizenId) => `${base}/citizens/${citizenId}`}
            registerHref={(buildingId, unitId) =>
              `${base}/citizens/new?buildingId=${encodeURIComponent(buildingId)}&unitId=${encodeURIComponent(unitId)}`
            }
            refreshToken={refreshToken}
            focusParcelNumber={focus?.parcelNumber}
            focusLat={focus?.lat}
            focusLng={focus?.lng}
            locale={locale}
          />
        )}
      </div>
    </div>
  );
}
