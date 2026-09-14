'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
import type mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { AlertTriangle, Crosshair, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { geometryBounds, pointInGeometry } from '@/lib/map-geometry';

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
 * Which عقار a point falls in, or null where the cadastre has no answer.
 *
 * The inverse of `outlineOf`, and what lets the building wizard ask for the
 * location before the parcel number instead of after it. An officer standing at
 * a door knows where they are; the رقم العقار is a fact about the *map*, and
 * making them produce it before they may look at the map is asking them to
 * index the cadastre from memory.
 *
 * Returns null rather than a nearest guess, and the distinction is the whole
 * value of the lookup: about 1.4% of this cadastre's parcels could not be closed
 * by the tracer and have no polygon at all, and the gaps between traced parcels
 * are real. A "closest parcel" would put a building on its neighbour's عقار —
 * which is a title claim — so an unresolved point simply leaves the field for
 * the officer to fill in, exactly as before.
 *
 * Linear over the collection, deliberately. It runs on a pin drop, not on a
 * drag frame, and a spatial index built per mount would cost more than it saves
 * on a municipality's few thousand polygons.
 */
export function parcelAt(
  collection: FeatureCollection | null,
  point: [number, number],
): string | null {
  if (!collection) return null;
  for (const feature of collection.features) {
    const parcelNumber = String(feature.properties?.parcelNumber ?? '').trim();
    if (!parcelNumber) continue;
    if (pointInGeometry(point, feature.geometry)) return parcelNumber;
  }
  return null;
}

/**
 * Just the parcels of one zone, as a collection the map can paint in one source.
 *
 * Filtered here rather than by a Mapbox filter expression so the caller can
 * also frame the camera on the result — `geometryBounds` needs the geometries,
 * not a style rule.
 */
export function parcelsOf(
  collection: FeatureCollection | null,
  parcelNumbers: readonly string[],
): FeatureCollection | null {
  if (!collection || parcelNumbers.length === 0) return null;
  const wanted = new Set(parcelNumbers.map((value) => value.trim()));
  const features = collection.features.filter((candidate: Feature) =>
    wanted.has(String(candidate.properties?.parcelNumber ?? '').trim()),
  );
  return features.length > 0 ? { type: 'FeatureCollection', features } : null;
}

/**
 * Several parcels as one `MultiPolygon` — the sector's footprint.
 *
 * What the camera frames on and what the wash is painted from, for a قطاع the
 * officer has selected but not yet narrowed to a parcel.
 *
 * Not a true union. `ZonesService` dissolves properly with turf and serves the
 * result from `/zones/geojson`, and this is deliberately *not* that: the
 * cadastre polygons are already on this device (every parcel lookup in this
 * editor needs them), so building a footprint from them costs no request and
 * cannot be a second answer that disagrees with the first. Unioned edges would
 * only matter if the interior boundaries were unwanted — and here they are the
 * point, because the officer is choosing between them.
 */
export function footprintOf(collection: FeatureCollection | null): Geometry | null {
  if (!collection) return null;

  const polygons: number[][][][] = [];
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (geometry?.type === 'Polygon') polygons.push(geometry.coordinates);
    else if (geometry?.type === 'MultiPolygon') polygons.push(...geometry.coordinates);
  }

  return polygons.length > 0 ? { type: 'MultiPolygon', coordinates: polygons } : null;
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
 * The parcel outline with one draggable entrance pin on it — and, before there
 * is a parcel, the قطاع it will be found in.
 *
 * ## Two ways in, because officers arrive knowing two different things
 *
 * The original one: the officer knows the رقم العقار, types it, and the parcel
 * is framed for them to pin the entrance inside. Unchanged.
 *
 * The one the zone layer adds: the officer knows *where they are standing* and
 * not the number. They pick their قطاع, the sector is framed with its member
 * parcels drawn on it, and the point they tap resolves to a parcel through
 * `parcelAt`. A رقم العقار is a fact about the map; requiring it before the map
 * may be looked at was asking them to index the cadastre from memory.
 *
 * The two layers never both matter: once a parcel is resolved it is the subject
 * and the sector is context, so the parcel outline is drawn over the zone and
 * the camera follows the parcel.
 */
export function ParcelPinPicker({
  outline,
  outlineChecked,
  fallbackCentre,
  zoneOutline = null,
  zoneParcels = null,
  zoneColor,
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
  /**
   * The dissolved قطاع the officer selected, framed while no parcel is chosen.
   *
   * Context rather than a target: nothing is ever pinned "to a zone". It exists
   * so the map opens somewhere recognisable instead of on the municipality's
   * bounding box, which at this zoom is a grey rectangle.
   */
  zoneOutline?: Geometry | null;
  /**
   * That zone's member parcels, drawn as thin outlines on top of it.
   *
   * What makes the sector *choosable* rather than merely framed: the officer is
   * picking a point that will resolve to one of these, and boundaries they
   * cannot see are boundaries they cannot aim between. Drawn under the selected
   * parcel's own outline, so the chosen one still reads as chosen.
   */
  zoneParcels?: FeatureCollection | null;
  /** The sector's own colour, so the map and the zone legend agree. */
  zoneColor?: string;
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
    /**
     * The sector the camera has already been framed on, by `zoneKey`.
     *
     * A marker rather than a boolean, so switching sectors frames the new one
     * while clearing the parcel field does not re-frame the old one.
     */
    zoneFramed?: string | null;
  } | null>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;

  /**
   * Identifies the sector currently painted, for the "frame it once" guard.
   *
   * Derived from the geometry rather than taken as an id prop: the caller may
   * legitimately pass a different outline for the same sector (the zone was
   * edited and re-dissolved), and that is a re-frame worth doing.
   */
  const zoneKey = zoneOutline ? JSON.stringify(geometryBounds(zoneOutline)) : null;

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

  /*
    The sector: its dissolved outline, and the parcels inside it.

    Its own effect rather than a branch of the parcel one below, because the two
    change on entirely different schedules — a zone is chosen once at the top of
    the wizard and a parcel is re-resolved on every keystroke and every pin drop.
    Folded together, every parcel lookup would tear down and rebuild hundreds of
    zone polygons.

    Added *before* the parcel layers in z-order for the same reason it is drawn
    faintly: the selected parcel has to stay legible on top of its neighbours.
  */
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;
    const { map } = handle;

    for (const id of ['zone-parcels-line', 'zone-outline-fill']) {
      if (map.getLayer(id)) map.removeLayer(id);
    }
    for (const id of ['zone-parcels', 'zone-outline']) {
      if (map.getSource(id)) map.removeSource(id);
    }

    const colour = zoneColor || '#a78bfa';

    if (zoneOutline) {
      map.addSource('zone-outline', {
        type: 'geojson',
        data: { type: 'Feature', geometry: zoneOutline, properties: {} },
      });
      /*
        A wash and no stroke of its own.

        The footprint is the *union* of the sector's parcels, so a line layer on
        it would trace every one of their boundaries — the same edges
        `zone-parcels-line` already draws, doubled and heavier. The wash says
        "inside the sector"; the thin lines say "and these are the parcels".
      */
      map.addLayer({
        id: 'zone-outline-fill',
        type: 'fill',
        source: 'zone-outline',
        paint: { 'fill-color': colour, 'fill-opacity': 0.12 },
      });
    }

    if (zoneParcels) {
      map.addSource('zone-parcels', { type: 'geojson', data: zoneParcels });
      map.addLayer({
        id: 'zone-parcels-line',
        type: 'line',
        source: 'zone-parcels',
        paint: { 'line-color': colour, 'line-width': 0.8, 'line-opacity': 0.7 },
      });
    }
  }, [zoneOutline, zoneParcels, zoneColor, ready]);

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

    if (fallbackCentre) {
      map.easeTo({ center: fallbackCentre, zoom: 18, duration: 400 });
      return;
    }

    /*
      No parcel yet — frame the sector, once.

      Guarded by `zoneFramed` because this effect also re-runs when the *parcel*
      clears, which is what happens the moment an officer empties the field to
      retype it. Re-framing there would yank the camera back out to the whole
      sector mid-correction, undoing whatever they had zoomed to. The key is the
      zone itself, so choosing a different sector frames the new one.
    */
    const zoneBounds = geometryBounds(zoneOutline);
    if (zoneBounds && handle.zoneFramed !== zoneKey) {
      handle.zoneFramed = zoneKey;
      map.fitBounds(zoneBounds, { padding: 24, duration: 500, maxZoom: 17 });
    }
  }, [outline, ready, fallbackCentre, zoneOutline, zoneKey]);

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
    if (bounds) {
      mapRef.current?.map.fitBounds(bounds, { padding: 32, duration: 400, maxZoom: 19 });
      return;
    }
    // No parcel chosen yet: the button re-frames the sector instead, which is
    // the only thing on screen at that point and the thing an officer who has
    // panned away is looking for.
    const zoneBounds = geometryBounds(zoneOutline);
    if (zoneBounds)
      mapRef.current?.map.fitBounds(zoneBounds, { padding: 24, duration: 400, maxZoom: 17 });
  }, [outline, zoneOutline]);

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

      {/*
        Two different absences, two different sentences.

        «لا يوجد مخطط» is about a parcel the officer has already named, and it
        is a caveat: the pin will be accepted but nothing can check it. The
        sector prompt below is about a parcel they have *not* named yet, and it
        is an instruction. Saying either in the other's situation would be
        confusing in the way that makes people stop reading map captions.
      */}
      {ready && !failure && outlineChecked && !outline ? (
        <p className="absolute inset-x-2 bottom-2 rounded-md bg-background/90 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur-sm">
          <Crosshair className="me-1 inline size-3" aria-hidden />
          {en
            ? 'This parcel has no traced outline, so the pin cannot be checked against it.'
            : 'لا يوجد مخطط مرسوم لهذا العقار، لذا يتعذّر التحقق من موقع الدبوس ضمنه.'}
        </p>
      ) : ready && !failure && !outline && zoneOutline ? (
        <p className="absolute inset-x-2 bottom-2 rounded-md bg-background/90 px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground shadow-sm backdrop-blur-sm">
          <Crosshair className="me-1 inline size-3" aria-hidden />
          {en
            ? 'Tap the building’s location inside the sector — the parcel number is read off the map.'
            : 'انقر على موقع المبنى داخل القطاع — ويُقرأ رقم العقار من الخريطة.'}
        </p>
      ) : null}

      {ready && !failure && (outline || zoneOutline) ? (
        <button
          type="button"
          onClick={recentre}
          className="absolute bottom-2 end-2 inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1.5 text-[11px] font-medium text-foreground shadow-sm ring-1 ring-border backdrop-blur-sm transition-colors hover:bg-background"
        >
          <Crosshair className="size-3.5" aria-hidden />
          {outline
            ? en
              ? 'Recentre on parcel'
              : 'إعادة التوسيط على العقار'
            : en
              ? 'Recentre on sector'
              : 'إعادة التوسيط على القطاع'}
        </button>
      ) : null}
    </div>
  );
}

