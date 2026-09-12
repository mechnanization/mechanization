'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
import type mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { AlertTriangle, Crosshair, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { geometryBounds } from '@/lib/map-geometry';

export const FALLBACK_CENTER: [number, number] = [35.2654, 33.2539];
export const SATELLITE_STYLE = 'mapbox://styles/mapbox/satellite-v9';
export const PIN_COLOR = '#F59E0B';
export const MAP_LOAD_TIMEOUT_MS = 12_000;

/**
 * The parcel outlines, fetched once per tenant and shared by every dialog/page open.
 */
export const outlineCache = new Map<string, Promise<FeatureCollection | null>>();

export function loadParcelOutlines(tenant: string): Promise<FeatureCollection | null> {
  const cached = outlineCache.get(tenant);
  if (cached) return cached;

  const slug = encodeURIComponent(tenant);
  const apiBase = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/t/${slug}/cadastre/assets`;

  const request = (async (): Promise<FeatureCollection | null> => {
    for (const url of [
      `/tenants/${slug}/parcel-polygons.geojson`,
      `${apiBase}/parcel-polygons.geojson`,
    ]) {
      try {
        const response = await fetch(url);
        if (response.ok) return (await response.json()) as FeatureCollection;
      } catch {
        // Try the next source; a missing static asset is not an error worth surfacing while the API still serves the same file.
      }
    }
    return null;
  })();

  outlineCache.set(tenant, request);
  return request;
}

export function outlineOf(
  collection: FeatureCollection | null,
  parcelNumber: string,
): Geometry | null {
  if (!collection || !parcelNumber) return null;
  const wanted = parcelNumber.trim();
  const feature = collection.features.find(
    (candidate: Feature) => String(candidate.properties?.parcelNumber ?? '').trim() === wanted,
  );
  return feature?.geometry ?? null;
}

/**
 * A signed floor as the grid's narrow gutter shows it — «الأرضي», «B2», «٣».
 *
 * Basements are `B1`/`B2` in both locales, matching the unit code on the same
 * row (`formatUnitCode` prints `B102`) and every other floor label in the app.
 * See `floorLabel` in `building-unit-forms.tsx` for the full reasoning.
 */
export function floorLabel(floor: number, en: boolean): string {
  if (floor < 0) return `B${Math.abs(floor)}`;
  if (floor === 0) return en ? 'ground' : 'الأرضي';
  return String(floor);
}

/**
 * The parcel outline with one draggable entrance pin on it.
 */
export function ParcelPinPicker({
  outline,
  outlineChecked,
  fallbackCentre,
  pin,
  onPick,
  locale,
  className,
}: {
  outline: Geometry | null;
  /** False until the outline lookup has run — distinguishes "none" from "not yet". */
  outlineChecked: boolean;
  /**
   * Where to point the camera when the parcel has no traced outline.
   */
  fallbackCentre: [number, number] | null;
  pin: [number, number] | null;
  onPick: (point: [number, number]) => boolean;
  locale: string;
  className?: string;
}) {
  const en = locale === 'en';
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{
    map: mapboxgl.Map;
    marker: mapboxgl.Marker;
    /** The last position the form accepted — where a refused drag snaps back to. */
    lastAccepted?: [number, number];
    /** Whether the view has been framed on the pin; see the effect below. */
    framed?: boolean;
  } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  const [ready, setReady] = useState(false);
  /** Why there is no map, when there is no map. */
  const [failure, setFailure] = useState<'token' | 'auth' | 'load' | null>(null);
  /** Bumped by «إعادة المحاولة»; rebuilds the map from scratch. */
  const [attempt, setAttempt] = useState(0);

  const token = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

  useEffect(() => {
    if (!token) {
      setFailure('token');
      return;
    }
    if (!containerRef.current) return;

    let cancelled = false;
    let cleanup: (() => void) | undefined;
    setReady(false);
    setFailure(null);

    void (async () => {
      const mapboxgl = (await import('mapbox-gl')).default;
      if (cancelled || !containerRef.current) return;

      mapboxgl.accessToken = token;

      const map = new mapboxgl.Map({
        container: containerRef.current,
        style: SATELLITE_STYLE,
        center: FALLBACK_CENTER,
        zoom: 15,
        attributionControl: false,
        cooperativeGestures: true,
        locale: en
          ? undefined
          : {
              'NavigationControl.ZoomIn': 'تكبير',
              'NavigationControl.ZoomOut': 'تصغير',
              'ScrollZoomBlocker.CtrlMessage': 'استخدم Ctrl + التمرير لتكبير الخريطة',
              'ScrollZoomBlocker.CmdMessage': 'استخدم ⌘ + التمرير لتكبير الخريطة',
              'TouchPanBlocker.Message': 'استخدم إصبعين لتحريك الخريطة',
            },
      });

      map.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'top-left');

      const marker = new mapboxgl.Marker({ color: PIN_COLOR, draggable: true });

      map.on('click', (event) => {
        const point: [number, number] = [event.lngLat.lng, event.lngLat.lat];
        onPickRef.current(point);
      });

      marker.on('dragend', () => {
        const lngLat = marker.getLngLat();
        const candidate: [number, number] = [lngLat.lng, lngLat.lat];
        const accepted = onPickRef.current(candidate);
        if (!accepted && mapRef.current?.lastAccepted) {
          marker.setLngLat(mapRef.current.lastAccepted);
        }
      });

      const timer = setTimeout(() => {
        if (!cancelled && !map.isStyleLoaded()) setFailure('load');
      }, MAP_LOAD_TIMEOUT_MS);

      map.on('load', () => {
        clearTimeout(timer);
        if (cancelled) return;
        setReady(true);
      });

      map.on('error', (event) => {
        const status = (event as unknown as { status?: number }).status;
        if (status === 401 || status === 403) setFailure('auth');
      });

      // Keep Mapbox pixel-sized to the element
      const observer = new ResizeObserver(() => {
        map.resize();
      });
      observer.observe(containerRef.current);

      mapRef.current = { map, marker };
      cleanup = () => {
        clearTimeout(timer);
        observer.disconnect();
        marker.remove();
        map.remove();
        mapRef.current = null;
      };
    })();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [token, en, attempt]);

  // Paint the parcel outline
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;
    const { map } = handle;

    if (map.getLayer('parcel-outline-line')) map.removeLayer('parcel-outline-line');
    if (map.getLayer('parcel-outline-fill')) map.removeLayer('parcel-outline-fill');
    if (map.getSource('parcel-outline')) map.removeSource('parcel-outline');

    if (outline) {
      map.addSource('parcel-outline', {
        type: 'geojson',
        data: { type: 'Feature', geometry: outline, properties: {} },
      });
      map.addLayer({
        id: 'parcel-outline-fill',
        type: 'fill',
        source: 'parcel-outline',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.18 },
      });
      map.addLayer({
        id: 'parcel-outline-line',
        type: 'line',
        source: 'parcel-outline',
        paint: { 'line-color': '#38bdf8', 'line-width': 2.5 },
      });
    }

    const bounds = geometryBounds(outline);
    if (bounds) {
      map.fitBounds(bounds, { padding: 32, duration: 400, maxZoom: 19 });
      return;
    }

    if (fallbackCentre) map.easeTo({ center: fallbackCentre, zoom: 18, duration: 400 });
  }, [outline, ready, fallbackCentre]);

  // The pin follows the form's state
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;

    if (pin) {
      handle.marker.setLngLat(pin).addTo(handle.map);
      handle.lastAccepted = pin;

      if (!geometryBounds(outline) && !handle.framed) {
        handle.map.easeTo({ center: pin, zoom: 18, duration: 400 });
        handle.framed = true;
      }
    } else {
      handle.marker.remove();
      handle.lastAccepted = undefined;
    }
  }, [pin, ready, outline]);

  const recentre = useCallback(() => {
    const bounds = geometryBounds(outline);
    if (bounds)
      mapRef.current?.map.fitBounds(bounds, { padding: 32, duration: 400, maxZoom: 19 });
  }, [outline]);

  return (
    <div
      className={
        className ??
        'relative h-52 overflow-hidden rounded-lg border sm:h-64 lg:h-[19rem]'
      }
    >
      <div
        ref={containerRef}
        className="h-full w-full"
        aria-label={en ? 'Building entrance map' : 'خريطة مدخل المبنى'}
      />

      {failure ? (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2.5 bg-muted px-4 text-center">
          <AlertTriangle className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
            {failure === 'auth'
              ? en
                ? 'The map key was refused. The building can still be saved — the entrance can be pinned later from the census ledger.'
                : 'رُفض مفتاح الخريطة. يمكن حفظ المبنى رغم ذلك — ويُحدَّد المدخل لاحقاً من سجل المباني.'
              : failure === 'token'
                ? en
                  ? 'The map is unavailable. Coordinates can be added later from the census ledger.'
                  : 'الخريطة غير متاحة. يمكن إضافة الإحداثيات لاحقاً من سجل المباني.'
                : en
                  ? 'The map could not be loaded — check the connection. The building can be saved without a pin.'
                  : 'تعذّر تحميل الخريطة — تحقّق من الاتصال. يمكن حفظ المبنى دون دبوس.'}
          </p>
          {failure === 'token' ? null : (
            <Button variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
              <RefreshCw className="size-3.5" aria-hidden />
              {en ? 'Try again' : 'إعادة المحاولة'}
            </Button>
          )}
        </div>
      ) : !ready ? (
        <div className="absolute inset-0 flex items-center justify-center gap-2 bg-muted/40 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {en ? 'Preparing the map…' : 'جاري تهيئة الخريطة…'}
        </div>
      ) : null}

      {ready && !failure && outlineChecked && !outline ? (
        <p className="absolute inset-x-2 bottom-2 rounded-md bg-background/90 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur-sm">
          <Crosshair className="me-1 inline size-3" aria-hidden />
          {en
            ? 'This parcel has no traced outline, so the pin cannot be checked against it.'
            : 'لا يوجد مخطط مرسوم لهذا العقار، لذا يتعذّر التحقق من موقع الدبوس ضمنه.'}
        </p>
      ) : null}

      {ready && !failure && outline ? (
        <button
          type="button"
          onClick={recentre}
          className="absolute bottom-2 end-2 inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1.5 text-[11px] font-medium text-foreground shadow-sm ring-1 ring-border backdrop-blur-sm transition-colors hover:bg-background"
        >
          <Crosshair className="size-3.5" aria-hidden />
          {en ? 'Recentre on parcel' : 'إعادة التوسيط على العقار'}
        </button>
      ) : null}
    </div>
  );
}

