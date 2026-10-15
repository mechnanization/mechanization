'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { Polygon } from 'geojson';
import { Loader2, MousePointerClick, SquareDashedMousePointer } from 'lucide-react';
import { fetchCadastreAsset } from '@/lib/cadastre-assets';
import { MapLayerControl } from './map-layer-control';
import {
  basemapById,
  ensureRtlTextPlugin,
  styleFor,
  type BasemapId,
  DEFAULT_BASEMAP,
} from './map-styles';

mapboxgl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

const FALLBACK_CENTER: [number, number] = [35.2654, 33.2539];
const FALLBACK_ZOOM = 13.5;
const PARCEL_LABEL_MIN_ZOOM = 16;

/** Amber, reserved exclusively for "selected" so nothing else competes with it. */
const SELECTED_COLOR = '#F59E0B';

const SOURCE = {
  parcels: 'zone-editor-parcels',
  labels: 'zone-editor-labels',
} as const;

const LAYER = {
  parcelFill: 'zone-parcel-fill',
  parcelLine: 'zone-parcel-line',
  parcelLabels: 'zone-parcel-labels',
} as const;

/** Membership of the zone being edited, plus every parcel already spoken for. */
export interface ZoneEditorAssignments {
  /** Parcel number → colour of the zone that owns it, excluding this one. */
  takenByOtherZone: Record<string, string>;
}

export interface ZoneEditorMapProps {
  tenant: string;
  /** The session token: a cadastre layer the portal has no copy of comes from the API. */
  token: string;
  selected: string[];
  onSelectedChange: (next: string[]) => void;
  assignments: ZoneEditorAssignments;
  /** Surfaces a message to the page's toast area — selection is silent otherwise. */
  onNotice: (message: string) => void;
  locale?: string;
}

export function ZoneEditorMap({
  tenant,
  token,
  selected,
  onSelectedChange,
  assignments,
  onNotice,
  locale = 'ar',
}: ZoneEditorMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const hoveredRef = useRef<string | null>(null);

  const appliedBasemapRef = useRef<BasemapId>(DEFAULT_BASEMAP);

  const [basemap, setBasemap] = useState<BasemapId>(DEFAULT_BASEMAP);
  const [ready, setReady] = useState(false);
  const [boxSelecting, setBoxSelecting] = useState(false);

  const dark = basemapById(basemap).dark;

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const assignmentsRef = useRef(assignments);
  assignmentsRef.current = assignments;
  const onSelectedChangeRef = useRef(onSelectedChange);
  onSelectedChangeRef.current = onSelectedChange;
  const onNoticeRef = useRef(onNotice);
  onNoticeRef.current = onNotice;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggleParcels = useCallback((parcelNumbers: string[], mode: 'toggle' | 'add') => {
    if (parcelNumbers.length === 0) return;

    const taken = assignmentsRef.current.takenByOtherZone;
    const current = new Set(selectedRef.current);

    const blocked = parcelNumbers.filter((n) => taken[n]);
    const allowed = parcelNumbers.filter((n) => !taken[n]);

    if (mode === 'toggle' && allowed.length === 1) {
      const only = allowed[0];
      if (current.has(only)) current.delete(only);
      else current.add(only);
    } else {
      for (const parcelNumber of allowed) current.add(parcelNumber);
    }

    if (blocked.length > 0) {
      onNoticeRef.current(
        blocked.length === 1
          ? (locale === 'en'
              ? `Parcel #${blocked[0]} is already assigned to another sector`
              : `العقار رقم ${blocked[0]} مضاف بالفعل إلى قطاع آخر`)
          : (locale === 'en'
              ? `${blocked.length} parcels were excluded because they belong to other sectors`
              : `تم استبعاد ${blocked.length} عقار لأنها مضافة إلى قطاعات أخرى`),
      );
    }

    onSelectedChangeRef.current([...current]);
  }, [locale]);

  // ── Layers ─────────────────────────────────────────────────────────
  const attachLayers = useCallback(
    async (map: mapboxgl.Map, force = false) => {
      const [polygons, labels] = await Promise.all([
        fetchCadastreAsset(tenant, tokenRef.current, 'parcel-polygons.geojson'),
        fetchCadastreAsset(tenant, tokenRef.current, 'parcels.geojson'),
      ]);

      if (!mapRef.current || mapRef.current !== map) return;

      if (force) {
        for (const id of Object.values(LAYER)) if (map.getLayer(id)) map.removeLayer(id);
        for (const id of Object.values(SOURCE)) if (map.getSource(id)) map.removeSource(id);
      }

      if (polygons && !map.getSource(SOURCE.parcels)) {
        // `promoteId` makes the parcel number the feature id, which is what
        // `setFeatureState` keys on — without it every hover/selection update
        // would need a numeric index the data does not carry.
        map.addSource(SOURCE.parcels, {
          type: 'geojson',
          data: polygons,
          promoteId: 'parcelNumber',
        });

        map.addLayer({
          id: LAYER.parcelFill,
          type: 'fill',
          source: SOURCE.parcels,
          paint: {
            // `to-color` is load-bearing: a feature-state lookup is untyped, and
            // `fill-color` rejects it outright rather than coercing — which
            // fails the whole style, not just this one paint property.
            'fill-color': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              SELECTED_COLOR,
              ['to-boolean', ['feature-state', 'zoneColor']],
              ['to-color', ['feature-state', 'zoneColor']],
              dark ? '#38bdf8' : '#0f766e',
            ],
            'fill-opacity': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              0.55,
              ['to-boolean', ['feature-state', 'zoneColor']],
              0.35,
              ['boolean', ['feature-state', 'hover'], false],
              0.3,
              0.12,
            ],
          },
        });

        map.addLayer({
          id: LAYER.parcelLine,
          type: 'line',
          source: SOURCE.parcels,
          paint: {
            'line-color': [
              'case',
              ['boolean', ['feature-state', 'selected'], false],
              SELECTED_COLOR,
              dark ? '#7dd3fc' : '#0f766e',
            ],
            // `interpolate` has to be the outermost expression — Mapbox rejects a
            // `zoom` interpolation nested inside a `case`, and rejecting it fails
            // the whole layer, not just this property. So the zoom ramp wraps the
            // selected/unselected choice rather than sitting inside one branch.
            'line-width': [
              'interpolate',
              ['linear'],
              ['zoom'],
              13,
              ['case', ['boolean', ['feature-state', 'selected'], false], 1.8, 0.4],
              18,
              ['case', ['boolean', ['feature-state', 'selected'], false], 3, 1.2],
            ],
          },
        });
      }

      if (labels && !map.getSource(SOURCE.labels)) {
        map.addSource(SOURCE.labels, { type: 'geojson', data: labels });
        map.addLayer({
          id: LAYER.parcelLabels,
          type: 'symbol',
          source: SOURCE.labels,
          minzoom: PARCEL_LABEL_MIN_ZOOM,
          layout: {
            'text-field': ['get', 'parcelNumber'],
            'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 16, 10, 19, 15],
            'text-allow-overlap': false,
          },
          paint: {
            'text-color': dark ? '#ffffff' : '#0f172a',
            'text-halo-color': dark ? 'rgba(0,0,0,0.85)' : '#ffffff',
            'text-halo-width': 1.6,
          },
        });
      }

      // Open on the whole cadastre: the editor's job is to carve it up, so the
      // starting view is the thing being carved rather than an arbitrary centre.
      if (polygons?.features?.length) {
        const bounds = new mapboxgl.LngLatBounds();
        for (const feature of polygons.features) {
          const geometry = feature.geometry as Polygon;
          if (geometry?.type !== 'Polygon') continue;
          for (const position of geometry.coordinates[0]) {
            bounds.extend(position as [number, number]);
          }
        }
        if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 64, duration: 0 });
      }

      setReady(Boolean(polygons));
    },
    [tenant, dark],
  );

  /**
   * Every call into `attachLayers` goes through here.
   *
   * `attachLayers` is `async`, so a style caught mid-swap rejects the promise
   * instead of throwing where a `try` could see it, and the rejection surfaces
   * as an unhandled error.
   *
   * The wait is on `style.load` — the single event fired once a replacement
   * style is in place — not `styledata`, which fires repeatedly *during* a load
   * and so exhausted a retry chain before the style was ever ready, leaving the
   * parcels undrawn after a basemap switch. Polling `isStyleLoaded()` is no
   * better: it reads false while an already-usable style's tiles stream in,
   * which over satellite imagery means effectively never.
   */
  const attachLayersSafely = useCallback(
    (map: mapboxgl.Map, force = false): void => {
      void attachLayers(map, force).catch(() => {
        map.once('style.load', () => {
          if (mapRef.current === map) void attachLayers(map, force).catch(() => {});
        });
      });
    },
    [attachLayers],
  );

  // ── Map lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensureRtlTextPlugin();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: styleFor(DEFAULT_BASEMAP),
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      // The box-select gesture below owns shift+drag, which Mapbox otherwise
      // binds to its own zoom-to-box.
      boxZoom: false,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'top-left');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    // Matches the style just constructed, so the basemap effect below sees
    // "nothing changed" instead of swapping it out from under a loading style.
    appliedBasemapRef.current = DEFAULT_BASEMAP;

    map.on('load', () => attachLayersSafely(map));
    mapRef.current = map;

    return () => {
      mapRef.current = null;
      try {
        map.remove();
      } catch {
        // Torn down mid-setup by StrictMode's dev-only double invoke.
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Resize with the container ──────────────────────────────────────
  // Same fix as FullscreenMap: Mapbox's canvas keeps its last pixel size
  // until told otherwise, so a sidebar collapse that widens this container
  // otherwise leaves the map cut off or surrounded by blank space.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => mapRef.current?.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Click, hover and box select ────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const setHover = (parcelNumber: string | null) => {
      if (hoveredRef.current === parcelNumber) return;
      if (hoveredRef.current) {
        map.setFeatureState(
          { source: SOURCE.parcels, id: hoveredRef.current },
          { hover: false },
        );
      }
      if (parcelNumber) {
        map.setFeatureState({ source: SOURCE.parcels, id: parcelNumber }, { hover: true });
      }
      hoveredRef.current = parcelNumber;
    };

    const onMove = (event: mapboxgl.MapLayerMouseEvent) => {
      const parcelNumber = event.features?.[0]?.properties?.parcelNumber;
      map.getCanvas().style.cursor = parcelNumber ? 'pointer' : '';
      setHover(typeof parcelNumber === 'string' ? parcelNumber : null);
    };

    const onLeave = () => {
      map.getCanvas().style.cursor = '';
      setHover(null);
    };

    const onClick = (event: mapboxgl.MapLayerMouseEvent) => {
      const parcelNumber = event.features?.[0]?.properties?.parcelNumber;
      if (typeof parcelNumber === 'string') toggleParcels([parcelNumber], 'toggle');
    };

    map.on('mousemove', LAYER.parcelFill, onMove);
    map.on('mouseleave', LAYER.parcelFill, onLeave);
    map.on('click', LAYER.parcelFill, onClick);

    // ── Shift+drag rectangle ──
    // Drawn as a plain absolutely-positioned div over the canvas rather than as
    // a map layer: it lives in screen space for the length of one gesture and
    // never needs to survive a pan, zoom or style change.
    const canvas = map.getCanvasContainer();
    let start: mapboxgl.Point | null = null;
    let box: HTMLDivElement | null = null;

    const asPoint = (event: MouseEvent): mapboxgl.Point => {
      const rect = canvas.getBoundingClientRect();
      return new mapboxgl.Point(event.clientX - rect.left, event.clientY - rect.top);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (!event.shiftKey || event.button !== 0) return;
      // Dragging the map while drawing a box would move the ground under the
      // rectangle, so the pan handler is suspended for the gesture.
      map.dragPan.disable();
      start = asPoint(event);
      setBoxSelecting(true);
    };

    const onMouseMove = (event: MouseEvent) => {
      if (!start) return;
      const current = asPoint(event);

      if (!box) {
        box = document.createElement('div');
        box.className = 'zone-select-box';
        canvas.appendChild(box);
      }

      const minX = Math.min(start.x, current.x);
      const minY = Math.min(start.y, current.y);
      box.style.transform = `translate(${minX}px, ${minY}px)`;
      box.style.width = `${Math.abs(current.x - start.x)}px`;
      box.style.height = `${Math.abs(current.y - start.y)}px`;
    };

    const finish = (event: MouseEvent) => {
      if (!start) return;
      const end = asPoint(event);

      box?.remove();
      box = null;
      map.dragPan.enable();
      setBoxSelecting(false);

      const dragged = Math.abs(end.x - start.x) > 3 && Math.abs(end.y - start.y) > 3;
      const from = start;
      start = null;
      if (!dragged) return;

      // `queryRenderedFeatures` answers in screen space, which is exactly the
      // question the gesture asks — "what did I draw a box around" — and it
      // reads the tiles already on the GPU rather than re-testing thousands of
      // polygons in JS.
      const hits = map.queryRenderedFeatures([from, end], { layers: [LAYER.parcelFill] });
      const parcelNumbers = [
        ...new Set(
          hits
            .map((feature) => feature.properties?.parcelNumber)
            .filter((n): n is string => typeof n === 'string'),
        ),
      ];

      if (parcelNumbers.length === 0) {
        onNoticeRef.current('لم يتم تحديد أي عقار داخل المربع');
        return;
      }
      toggleParcels(parcelNumbers, 'add');
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !start) return;
      box?.remove();
      box = null;
      start = null;
      map.dragPan.enable();
      setBoxSelecting(false);
    };

    canvas.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', finish);
    window.addEventListener('keydown', onKeyDown);

    return () => {
      map.off('mousemove', LAYER.parcelFill, onMove);
      map.off('mouseleave', LAYER.parcelFill, onLeave);
      map.off('click', LAYER.parcelFill, onClick);
      canvas.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('keydown', onKeyDown);
      box?.remove();
    };
  }, [ready, toggleParcels]);

  // ── Paint selection and existing zone ownership ────────────────────
  // One pass over both sets rather than a diff: the source is a few thousand
  // features, `setFeatureState` is cheap, and a diff here would have to track
  // what it painted last render to stay correct across a zone switch.
  const paintedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const taken = assignments.takenByOtherZone;
    const next = new Set<string>([...selectedSet, ...Object.keys(taken)]);

    for (const parcelNumber of paintedRef.current) {
      if (next.has(parcelNumber)) continue;
      map.setFeatureState(
        { source: SOURCE.parcels, id: parcelNumber },
        { selected: false, zoneColor: null },
      );
    }

    for (const parcelNumber of next) {
      map.setFeatureState(
        { source: SOURCE.parcels, id: parcelNumber },
        {
          selected: selectedSet.has(parcelNumber),
          zoneColor: selectedSet.has(parcelNumber) ? null : (taken[parcelNumber] ?? null),
        },
      );
    }

    paintedRef.current = next;
  }, [selectedSet, assignments, ready]);

  // ── Basemap switching ──────────────────────────────────────────────
  // Compares the applied basemap rather than tracking a "first run" flag: refs
  // outlive React's dev-mode remount but the map does not, so a boolean guard
  // lets a redundant `setStyle` hit a map whose first style is still loading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedBasemapRef.current === basemap) return;
    appliedBasemapRef.current = basemap;

    setReady(false);
    // Feature state does not survive a style swap, so the paint effect above
    // must run again — clearing this is what makes it repaint everything.
    paintedRef.current = new Set();
    map.setStyle(styleFor(basemap));
    map.once('style.load', () => attachLayersSafely(map, true));
  }, [basemap, attachLayersSafely]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={containerRef}
        className="h-full w-full"
        aria-label={locale === 'en' ? 'Sector selection map' : 'خريطة تحديد القطاعات'}
      />

      {/* How to select, stated plainly */}
      <div className="pointer-events-none absolute bottom-20 left-1/2 z-10 -translate-x-1/2 rounded-lg border bg-card/95 px-3 py-2 shadow-sm backdrop-blur">
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <MousePointerClick className="size-3.5" aria-hidden />
            {locale === 'en' ? 'Click to select parcel' : 'انقر لتحديد عقار'}
          </span>
          <span
            className={`flex items-center gap-1.5 ${boxSelecting ? 'font-bold text-primary' : ''}`}
          >
            <SquareDashedMousePointer className="size-3.5" aria-hidden />
            {locale === 'en' ? 'Shift + Drag to select area' : 'Shift + سحب لتحديد منطقة'}
          </span>
        </div>
      </div>

      {!ready ? (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border bg-card/95 px-4 py-2 text-sm shadow-sm backdrop-blur">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {locale === 'en' ? 'Loading parcel boundaries…' : 'جاري تحميل حدود العقارات…'}
          </div>
        </div>
      ) : null}

      <style>{`
        .zone-select-box {
          position: absolute;
          top: 0; left: 0;
          background: ${SELECTED_COLOR}22;
          border: 2px dashed ${SELECTED_COLOR};
          border-radius: 2px;
          pointer-events: none;
          z-index: 5;
        }
      `}</style>

      <MapLayerControl value={basemap} onChange={setBasemap} locale={locale} />
    </div>
  );
}
