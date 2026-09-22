'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import 'mapbox-gl/dist/mapbox-gl.css';
import type mapboxgl from 'mapbox-gl';
import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { AlertTriangle, Crosshair, Loader2, Pointer, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { geometryBounds, pointInGeometry } from '@/lib/map-geometry';

export const FALLBACK_CENTER: [number, number] = [35.2654, 33.2539];
export const SATELLITE_STYLE = 'mapbox://styles/mapbox/satellite-v9';
export const PIN_COLOR = '#F59E0B';
export const MAP_LOAD_TIMEOUT_MS = 12_000;

/**
 * Below this a sector's numbers mostly collide, and Mapbox drops the losers.
 *
 * One level lower than the staff map's 16, because that map numbers the whole
 * cadastre and this one only the sector being searched: a large قطاع can be
 * framed below 16, and the staff map's threshold would open it unnumbered.
 */
const PARCEL_LABEL_MIN_ZOOM = 15;

/**
 * The map's two notes — compact, and never in the way of a tap. See where they
 * are rendered for why they sit top-right.
 */
const MAP_NOTE_CLASS =
  'pointer-events-none absolute right-2 top-2 inline-flex max-w-[calc(100%-3.75rem)] items-center gap-1.5 rounded-full bg-background/90 px-2.5 py-1 text-xs font-medium leading-snug text-foreground shadow-sm ring-1 ring-border backdrop-blur-sm animate-in fade-in';

/**
 * Every layer this map draws, bottom to top.
 *
 * Three effects own them and re-run on unrelated schedules — the sector when
 * one is chosen, the parcel on every lookup, the numbers on both — and
 * `addLayer` with no `beforeId` stacks on top of whatever is there already. So
 * the order is stated once here rather than left to whichever effect ran last:
 * re-resolving a parcel would otherwise bury every number under its fill, and a
 * sector chosen after the parcel would draw its lines across the chosen outline.
 */
const LAYER_ORDER = [
  'zone-outline-fill',
  'zone-parcels-line',
  'parcel-outline-fill',
  'parcel-outline-line',
  'parcel-labels',
  'parcel-label-selected',
] as const;

/** `map.addLayer`, slotted beneath whichever of the layers above it is already drawn. */
function addLayerInOrder(
  map: mapboxgl.Map,
  layer: Parameters<mapboxgl.Map['addLayer']>[0] & { id: (typeof LAYER_ORDER)[number] },
): void {
  const above = LAYER_ORDER.slice(LAYER_ORDER.indexOf(layer.id) + 1);
  map.addLayer(layer, above.find((id) => map.getLayer(id)));
}

/**
 * The parcel outlines, fetched once per tenant and shared by every dialog/page open.
 */
export const outlineCache = new Map<string, Promise<FeatureCollection | null>>();

/** The parcel label points, cached the same way. */
export const labelPointCache = new Map<string, Promise<FeatureCollection | null>>();

function loadCadastreAsset(
  cache: Map<string, Promise<FeatureCollection | null>>,
  tenant: string,
  file: string,
): Promise<FeatureCollection | null> {
  const cached = cache.get(tenant);
  if (cached) return cached;

  const slug = encodeURIComponent(tenant);
  const apiBase = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api/v1'}/t/${slug}/cadastre/assets`;

  const request = (async (): Promise<FeatureCollection | null> => {
    for (const url of [`/tenants/${slug}/${file}`, `${apiBase}/${file}`]) {
      try {
        const response = await fetch(url);
        if (response.ok) return (await response.json()) as FeatureCollection;
      } catch {
        // Try the next source; a missing static asset is not an error worth surfacing while the API still serves the same file.
      }
    }
    return null;
  })();

  cache.set(tenant, request);
  return request;
}

export function loadParcelOutlines(tenant: string): Promise<FeatureCollection | null> {
  return loadCadastreAsset(outlineCache, tenant, 'parcel-polygons.geojson');
}

/**
 * Where each parcel's number is printed — one point per عقار, from the same
 * cadastre import as the outlines.
 *
 * The cadastre's own positions rather than a centre computed from the outline.
 * They are what the staff map and the zone editor draw, so a number sits in the
 * same spot on all three; and in this import every one of the 1,800 that has an
 * outline falls inside it. A bounding-box centre can land outside an L-shaped
 * parcel, and a polygon labelled by Mapbox itself can repeat its number where
 * the parcel crosses a tile edge.
 */
export function loadParcelLabelPoints(tenant: string): Promise<FeatureCollection | null> {
  return loadCadastreAsset(labelPointCache, tenant, 'parcels.geojson');
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
  parcelLabels = null,
  parcelNumber = null,
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
  /**
   * The label points of the parcels worth numbering — `loadParcelLabelPoints`,
   * narrowed by the caller to the sector and the resolved parcel.
   *
   * The outlines alone say where the boundaries are; the numbers are what let
   * an officer check the parcel under their finger against the deed in their
   * hand before they tap, rather than reading the answer back afterwards.
   */
  parcelLabels?: FeatureCollection | null;
  /** The parcel the outline belongs to, whose number is drawn over the rest. */
  parcelNumber?: string | null;
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

    Kept *below* the parcel layers in z-order (see `LAYER_ORDER`) for the same
    reason it is drawn faintly: the selected parcel has to stay legible on top of
    its neighbours.
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
      addLayerInOrder(map, {
        id: 'zone-outline-fill',
        type: 'fill',
        source: 'zone-outline',
        paint: { 'fill-color': colour, 'fill-opacity': 0.12 },
      });
    }

    if (zoneParcels) {
      map.addSource('zone-parcels', { type: 'geojson', data: zoneParcels });
      addLayerInOrder(map, {
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
      addLayerInOrder(map, {
        id: 'parcel-outline-fill',
        type: 'fill',
        source: 'parcel-outline',
        paint: { 'fill-color': '#38bdf8', 'fill-opacity': 0.18 },
      });
      addLayerInOrder(map, {
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

  /*
    The parcel numbers — every numbered parcel's, and the resolved one's above
    the rest.

    One source split into two layers by filter, so resolving a parcel changes a
    filter rather than rebuilding the source: the other numbers keep their
    placement instead of fading out and back in on every pin drop.

    The resolved number is a layer of its own so it can be larger and cannot
    lose a collision. Mapbox places the topmost symbol layer first, and
    `text-allow-overlap` keeps it even where a neighbour's number was about to
    sit — the neighbour is the one dropped.

    White on a dark halo, the staff map's satellite treatment; the resolved one
    takes its halo from the sky of its own outline.
  */
  useEffect(() => {
    const handle = mapRef.current;
    if (!handle || !ready) return;
    const { map } = handle;

    const data: FeatureCollection = parcelLabels ?? { type: 'FeatureCollection', features: [] };
    const source = map.getSource('parcel-labels') as mapboxgl.GeoJSONSource | undefined;

    if (source) {
      source.setData(data);
    } else {
      map.addSource('parcel-labels', { type: 'geojson', data });
      addLayerInOrder(map, {
        id: 'parcel-labels',
        type: 'symbol',
        source: 'parcel-labels',
        minzoom: PARCEL_LABEL_MIN_ZOOM,
        layout: {
          'text-field': ['to-string', ['get', 'parcelNumber']],
          'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 10, 19, 14],
          'text-padding': 1,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0, 0, 0, 0.8)',
          'text-halo-width': 1.5,
        },
      });
      addLayerInOrder(map, {
        id: 'parcel-label-selected',
        type: 'symbol',
        source: 'parcel-labels',
        layout: {
          'text-field': ['to-string', ['get', 'parcelNumber']],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 15, 12, 19, 18],
          'text-allow-overlap': true,
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': '#0369a1',
          'text-halo-width': 2,
        },
      });
    }

    // `to-string` because a cadastre export may carry the number as a JSON
    // number, and an expression comparing a number to a string is simply false.
    const selected = parcelNumber?.trim() ?? '';
    map.setFilter('parcel-labels', ['!=', ['to-string', ['get', 'parcelNumber']], selected]);
    map.setFilter('parcel-label-selected', ['==', ['to-string', ['get', 'parcelNumber']], selected]);
  }, [parcelLabels, parcelNumber, ready]);

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
        Two different absences, two different notes.

        «لا يوجد مخطط» is about a parcel the officer has already named, and it
        is a caveat: the pin will be accepted but nothing can check it. The
        sector prompt is about a parcel they have *not* named yet, and it is an
        instruction — so it goes the moment there is a pin, because an
        instruction for a step already taken is the kind of caption people learn
        to stop reading. The step's own hint above the map carries the long form.

        A pill in the top-right corner rather than a bar across the bottom. The
        bar spanned the whole map and covered the same strip of parcels the
        officer was trying to tap; the pill is as wide as its words, and
        `pointer-events-none` so a tap on the ground beneath it still lands.

        Every overlay here is placed with *physical* offsets, not `start`/`end`.
        Mapbox pins its wordmark bottom-left and its zoom buttons top-left
        whichever way the page reads, so on this RTL form `end-2` put the
        recentre button directly on the wordmark. `right-*` / `left-*` are the
        only offsets that mean the same thing in both directions, which is what
        is needed against controls that do not flip. Top-right is the one corner
        the library leaves free.
      */}
      {ready && !failure && outlineChecked && !outline ? (
        <p role="status" className={MAP_NOTE_CLASS}>
          <AlertTriangle className="size-3.5 shrink-0 text-warning" aria-hidden />
          {en
            ? 'No outline for this parcel — the pin can’t be checked'
            : 'لا مخطط لهذا العقار — يتعذّر التحقق من الدبوس'}
        </p>
      ) : ready && !failure && !outline && zoneOutline && !pin ? (
        <p role="status" className={MAP_NOTE_CLASS}>
          <Pointer className="size-3.5 shrink-0 text-primary" aria-hidden />
          {en ? 'Tap the building inside the sector' : 'انقر على المبنى داخل القطاع'}
        </p>
      ) : null}

      {ready && !failure && (outline || zoneOutline) ? (
        <button
          type="button"
          onClick={recentre}
          className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-md bg-background/90 px-2 py-1.5 text-xs font-medium text-foreground shadow-sm ring-1 ring-border backdrop-blur-sm transition-colors hover:bg-background"
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

