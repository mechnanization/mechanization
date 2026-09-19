'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import type { FeatureCollection } from 'geojson';
import {
  Check,
  ChevronDown,
  Coins,
  Building2,
  Crosshair,
  Eye,
  EyeOff,
  Info,
  Loader2,
  Maximize2,
  Printer,
  Ruler,
  Search,
  SlidersHorizontal,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  checkPropertyNumber,
  getBuildingMapPins,
  getZone,
  getZones,
  getZonesGeoJson,
  logApiError,
  type BuildingMapPin,
  type RegisteredParcel,
  type ZoneSummary,
} from '@/lib/api-client';
import { getLabels, type CitizenResidence } from '@mechanization/shared-schemas';
import {
  BUILDING_LAYER,
  BUILDING_SOURCE,
  BUILDING_ZOOM,
  buildingLegend,
  buildingsGeoJson,
  damageRingExpression,
  ensureStructureIcons,
  parcelRollupGeoJson,
  structureIconExpression,
  lifecycleOpacityExpression,
  surveyFillExpression,
} from './building-map-layer';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  computePolygonArea,
  computeTotalDistance,
  formatArea,
  formatDistance,
} from '@/lib/map-geometry';
import { MapLayerControl } from './map-layer-control';
import { CitizenDetailDrawer } from './citizen-detail-drawer';
import { ZoneLegend } from './zone-legend';
import { MapExportDialog } from './map-export-dialog';
import { ZoneInfoDialog } from './zone-info-dialog';
import { BuildingUnitMatrixDrawer } from './building-unit-matrix-drawer';
import {
  basemapById,
  ensureRtlTextPlugin,
  styleFor,
  type BasemapId,
  DEFAULT_BASEMAP,
} from './map-styles';

// Falls back to Mapbox's own public example token — never a real project
// token here, since this file is committed. Set NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN
// in `.env`/`.env.local` (both gitignored) for real usage.
mapboxgl.accessToken =
  process.env.NEXT_PUBLIC_MAPBOX_ACCESS_TOKEN;

/** Parcel numbers only become legible — and useful — this far in. */
const PARCEL_LABEL_MIN_ZOOM = 16;

/** Albazourieh's cadastre sits here; the fallback view before data loads. */
const FALLBACK_CENTER: [number, number] = [35.2654, 33.2539];
const FALLBACK_ZOOM = 13.5;

const SOURCE = {
  cadastre: 'cadastre-source',
  parcels: 'parcels-source',
  zones: 'zones-source',
  registered: 'registered-source',
  measure: 'measure-source',
} as const;

const LAYER = {
  cadastreLines: 'cadastre-lines',
  parcelLabels: 'parcel-labels',
  zoneFills: 'zone-fills',
  zoneLines: 'zone-lines',
  zoneLabels: 'zone-labels',
  registeredHalo: 'registered-halo',
  registeredDots: 'registered-dots',
  registeredCount: 'registered-count',
  measureFill: 'measure-fill',
  measureLine: 'measure-line',
  measurePoints: 'measure-points',
} as const;

const DOT = {
  fill: '#2563eb',
  fillDark: '#60a5fa',
  stroke: '#ffffff',
  focus: '#f59e0b',
  focusDark: '#fbbf24',
} as const;

/**
 * Lifts the GPU dots straight up so their anchor matches the historic DOM
 * markers: on a point-pin the *tip* touches the coordinate, but a circle's
 * centre sits right on top of it. Pulling it up lets the parcel number behind
 * it stay readable instead of being covered by the dot.
 *
 * A zoom ramp rather than a flat 12px, because 12px stopped doing that job once
 * the numbers appear (`PARCEL_LABEL_MIN_ZOOM`). The dot and the number both
 * grow as the map zooms in, and at 18 a dot's lower edge reached the middle of
 * the number, and a several-registrant dot hid it entirely. Each stop clears
 * the larger dot — radius plus stroke, half the number's height, and a 2px gap
 * — since `circle-translate` cannot differ per feature. Below 15 there are no
 * numbers to clear, so the dots stay where they always were.
 */
const DOT_LIFT: mapboxgl.ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  15,
  ['literal', [0, -12]],
  16,
  ['literal', [0, -22]],
  18,
  ['literal', [0, -26]],
  19,
  ['literal', [0, -27]],
];

/** Fill strength of a drawn sector — the same whether or not one is picked. */
const ZONE_FILL_OPACITY = 0.25;
const ZONE_LINE_OPACITY = 0.9;

/**
 * Shows every sector at `opacity`, or — once one is picked — only that one,
 * with the rest fully transparent so their colours cannot be mistaken for it.
 *
 * Keyed on `zoneId`, the property `ZonesService.buildGeoJson` writes; the
 * features carry no `id`, and matching on one silently faded every sector.
 */
function zoneOpacity(
  activeZoneId: string | null | undefined,
  opacity: number,
): number | mapboxgl.ExpressionSpecification {
  if (!activeZoneId) return opacity;
  return ['case', ['==', ['get', 'zoneId'], activeZoneId], opacity, 0];
}

function applyZoneOpacity(map: mapboxgl.Map, activeZoneId: string | null | undefined): void {
  if (map.getLayer(LAYER.zoneFills)) {
    map.setPaintProperty(LAYER.zoneFills, 'fill-opacity', zoneOpacity(activeZoneId, ZONE_FILL_OPACITY));
  }
  if (map.getLayer(LAYER.zoneLines)) {
    map.setPaintProperty(LAYER.zoneLines, 'line-opacity', zoneOpacity(activeZoneId, ZONE_LINE_OPACITY));
  }
  if (map.getLayer(LAYER.zoneLabels)) {
    map.setPaintProperty(LAYER.zoneLabels, 'text-opacity', zoneOpacity(activeZoneId, 1));
  }
}

/**
 * Classifies a parcel's primary property usage category.
 */
function getParcelUsageCategory(parcel: RegisteredParcel): 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL' {
  /*
    Every structure on the parcel, not only each registrant's first.

    `propertyType`/`occupancyType` on the registrant are that citizen's opening
    card and are already the first entry of `structures`, so reading both would
    weigh it twice. The fallback covers a response predating `structures`.
  */
  const allTypes = parcel.registrants.flatMap((r) =>
    r.structures && r.structures.length > 0
      ? r.structures.map((s) => `${s.propertyType} ${s.occupancyType}`.toUpperCase())
      : [`${r.propertyType} ${r.occupancyType}`.toUpperCase()],
  );
  if (allTypes.some((t) => t.includes('COMMERCIAL') || t.includes('STORE') || t.includes('SHOP') || t.includes('OFFICE'))) {
    return 'COMMERCIAL';
  }
  if (allTypes.some((t) => t.includes('INDUSTRIAL') || t.includes('FACTORY') || t.includes('WORKSHOP'))) {
    return 'INDUSTRIAL';
  }
  return 'RESIDENTIAL';
}

/**
 * Whether each map's *style spec* has finished parsing — the only condition
 * `addSource`/`addLayer`/`getSource` actually require.
 *
 * `map.isStyleLoaded()` cannot answer that question. It is Mapbox's
 * `Style.loaded()`, which also returns false while **any** source still has
 * tiles in flight — which on this screen is most of the time: a megabyte of
 * cadastre GeoJSON streams in, then the sector overlay, then a flyTo to zoom
 * 17 pulls a fresh round of basemap tiles.
 */
const styleSpecLoaded = new WeakMap<mapboxgl.Map, boolean>();

/**
 * Wires a map so `attachWhenReady` can tell "the style is still parsing" apart
 * from "tiles are still downloading". Persistent rather than `once`, because
 * `style.load` fires again for every `setStyle` (i.e. every basemap switch).
 */
function trackStyleSpec(map: mapboxgl.Map): void {
  styleSpecLoaded.set(map, false);
  map.on('style.load', () => styleSpecLoaded.set(map, true));
}

/** Call immediately before `setStyle` — the old style is gone from that moment. */
function markStyleSwapping(map: mapboxgl.Map): void {
  styleSpecLoaded.set(map, false);
}

/**
 * Runs a layer-mutating callback once the map's style spec is parsed.
 *
 * Deferring to `style.load` is only correct while the style really is loading:
 * that event fires once per style, so anything queued on it *after* it has
 * already fired is lost for good. Testing `isStyleLoaded()` did exactly that,
 * and it is why arriving from a citizen's «عرض على الخريطة» landed on a map
 * with parcel numbers drawn and not one registered dot — the parcels response
 * came back mid-flight, tiles were loading, so the `setData` that fills the
 * dot source was queued on an event that never came again.
 */
function attachWhenReady(map: mapboxgl.Map, fn: () => void): void {
  if (styleSpecLoaded.get(map)) {
    fn();
  } else {
    map.once('style.load', fn);
  }
}

/**
 * How far to lift a flown-to parcel so the sheet about to open does not cover
 * it.
 *
 * Below `sm` that sheet is a bottom drawer over as much as 75dvh of the map,
 * so a parcel centred in the container lands behind it and the officer flies
 * to a pin they cannot see. Centre it in the strip that stays visible instead.
 * From `sm` up the sheet is a side panel and the vertical centre is already
 * right, so the offset is zero.
 */
function sheetOffset(map: mapboxgl.Map): [number, number] {
  if (window.matchMedia('(min-width: 640px)').matches) return [0, 0];
  const height = map.getContainer().clientHeight;
  const visible = height * 0.25;
  return [0, -(height / 2 - visible / 2)];
}

/**
 * Keeps the registered-parcel dots visually above whatever layers got added
 * after them. Moving a layer with `moveLayer` throws if the layer does not
 * exist yet (e.g. while data is still loading), so each move is guarded.
 */
function raiseRegistered(map: mapboxgl.Map): void {
  for (const id of [LAYER.registeredHalo, LAYER.registeredDots, LAYER.registeredCount]) {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  }
}

/**
 * Attaches the measurement line and polygon layers.
 */
function attachMeasureLayers(map: mapboxgl.Map): void {
  if (!map.getSource(SOURCE.measure)) {
    map.addSource(SOURCE.measure, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  }

  if (!map.getLayer(LAYER.measureFill)) {
    map.addLayer({
      id: LAYER.measureFill,
      type: 'fill',
      source: SOURCE.measure,
      filter: ['==', '$type', 'Polygon'],
      paint: {
        'fill-color': '#3b82f6',
        'fill-opacity': 0.22,
      },
    });
  }

  if (!map.getLayer(LAYER.measureLine)) {
    map.addLayer({
      id: LAYER.measureLine,
      type: 'line',
      source: SOURCE.measure,
      filter: ['==', '$type', 'LineString'],
      paint: {
        'line-color': '#2563eb',
        'line-width': 3,
        'line-dasharray': [2, 2],
      },
    });
  }

  if (!map.getLayer(LAYER.measurePoints)) {
    map.addLayer({
      id: LAYER.measurePoints,
      type: 'circle',
      source: SOURCE.measure,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': 5.5,
        'circle-color': '#ffffff',
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#2563eb',
      },
    });
  }
}

export function FullscreenMap({
  parcels,
  tenant,
  token,
  refreshToken,
  citizenHref,
  focusParcelNumber,
  focusLat,
  focusLng,
  registerHref,
  locale = 'ar',
}: {
  parcels: RegisteredParcel[];
  tenant: string;
  token?: string;
  refreshToken?: string | number;
  citizenHref: (citizenId: string) => string;
  focusParcelNumber?: string;
  focusLat?: number;
  focusLng?: number;
  /**
   * Where the census drawer's «ملف جديد» choices go — see the drawer's own
   * `registerHref`.
   *
   * Built by the page, like `citizenHref` beside it: this component is handed
   * links rather than reconstructing `/{tenant}/{locale}/{adminPath}` itself.
   */
  registerHref?: (
    buildingId: string,
    unitId: string,
    residence: CitizenResidence,
    /** Whatever the officer typed into the occupant search — seeds the name or the phone. */
    name: string,
  ) => string;
  locale?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  const [basemap, setBasemap] = useState<BasemapId>(DEFAULT_BASEMAP);
  const appliedBasemapRef = useRef<BasemapId>(DEFAULT_BASEMAP);

  const [selected, setSelected] = useState<RegisteredParcel | null>(null);
  const [cadastreReady, setCadastreReady] = useState(false);

  const [mapReady, setMapReady] = useState(false);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const [query, setQuery] = useState('');
  const [searchStatus, setSearchStatus] = useState<'idle' | 'searching' | 'not-found'>('idle');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [matchesOpen, setMatchesOpen] = useState(false);

  const [zones, setZones] = useState<ZoneSummary[]>([]);
  const [zonesGeoJson, setZonesGeoJson] = useState<FeatureCollection | null>(null);
  const [zonesVisible, setZonesVisible] = useState(true);
  const [zoneLabelsVisible, setZoneLabelsVisible] = useState(true);
  const [activeZoneId, setActiveZoneId] = useState<string | null>(null);
  const [zoneParcelNumbers, setZoneParcelNumbers] = useState<Set<string> | null>(null);

  // Map Controls & Filters
  const [registeredVisible, setRegisteredVisible] = useState(true);
  const [colorMode, setColorMode] = useState<'default' | 'paymentStatus' | 'propertyType'>('default');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UNPAID' | 'PARTIALLY_PAID' | 'PAID' | 'NO_BILLS'>('ALL');
  const [propertyTypeFilter, setPropertyTypeFilter] = useState<'ALL' | 'RESIDENTIAL' | 'COMMERCIAL' | 'INDUSTRIAL'>('ALL');
  const [financeMenuOpen, setFinanceMenuOpen] = useState(false);
  /**
   * Phone only: the tool cluster is folded behind one button, because five
   * controls plus a search field cannot share a 360px strip without the field
   * shrinking to nothing. Ignored from `sm` up, where the row always shows.
   */
  const [toolsOpen, setToolsOpen] = useState(false);

  // GIS Measurement Tools
  const [measureMode, setMeasureMode] = useState<'none' | 'distance' | 'area'>('none');
  const [measurePoints, setMeasurePoints] = useState<[number, number][]>([]);
  const [measureMenuOpen, setMeasureMenuOpen] = useState(false);
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;

  // Map Export Dialog
  const [exportOpen, setExportOpen] = useState(false);
  const [mapDataUrl, setMapDataUrl] = useState<string | null>(null);

  // Zone Info Dialog
  const [selectedZoneInfo, setSelectedZoneInfo] = useState<ZoneSummary | null>(null);
  const [zoneInfoOpen, setZoneInfoOpen] = useState(false);

  // ── The census layer (P3-T5) ───────────────────────────────────────
  const [buildingPins, setBuildingPins] = useState<BuildingMapPin[]>([]);
  const [buildingsVisible, setBuildingsVisible] = useState(false);
  const [buildingLegendOpen, setBuildingLegendOpen] = useState(false);
  /** Which building's matrix is open, if any. */
  const [openBuildingId, setOpenBuildingId] = useState<string | null>(null);

  const zonesVisibleRef = useRef(zonesVisible);
  zonesVisibleRef.current = zonesVisible;
  const activeZoneIdRef = useRef(activeZoneId);
  activeZoneIdRef.current = activeZoneId;

  const dark = basemapById(basemap).dark;
  const trimmedQuery = query.trim();

  const localMatches = trimmedQuery
    ? parcels.filter((parcel) => parcel.propertyNumber.startsWith(trimmedQuery)).slice(0, 6)
    : [];

  const attachRegisteredRef = useRef<((map: mapboxgl.Map) => void) | null>(null);
  const selectedPinRef = useRef<mapboxgl.Marker | null>(null);
  const citizenPinRef = useRef<mapboxgl.Marker | null>(null);
  const searchMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const focusMatchedRef = useRef<string | null>(null);

  // ── Measurement Calculations ─────────────────────────────────────────
  const liveDistance = useMemo(() => computeTotalDistance(measurePoints), [measurePoints]);
  const liveArea = useMemo(() => computePolygonArea(measurePoints), [measurePoints]);

  const attachCadastre = useCallback(
    async (map: mapboxgl.Map, force = false) => {
      const base = `/tenants/${encodeURIComponent(tenant)}`;
      const apiBase = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/t/${encodeURIComponent(tenant)}/cadastre/assets`;
      const bust = refreshToken ? `?v=${refreshToken}` : '';
      const [cadastre, parcelPoints] = await Promise.all([
        fetchGeoJson(`${base}/cadastre.geojson${bust}`, `${apiBase}/cadastre.geojson${bust}`),
        fetchGeoJson(`${base}/parcels.geojson${bust}`, `${apiBase}/parcels.geojson${bust}`),
      ]);

      if (!mapRef.current || mapRef.current !== map) return;

      if (force) {
        if (map.getLayer(LAYER.cadastreLines)) map.removeLayer(LAYER.cadastreLines);
        if (map.getSource(SOURCE.cadastre)) map.removeSource(SOURCE.cadastre);
        if (map.getLayer(LAYER.parcelLabels)) map.removeLayer(LAYER.parcelLabels);
        if (map.getSource(SOURCE.parcels)) map.removeSource(SOURCE.parcels);
      }

      if (cadastre && !map.getSource(SOURCE.cadastre)) {
        map.addSource(SOURCE.cadastre, { type: 'geojson', data: cadastre });
        map.addLayer({
          id: LAYER.cadastreLines,
          type: 'line',
          source: SOURCE.cadastre,
          paint: {
            'line-color': dark ? '#7dd3fc' : '#0f766e',
            'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 18, 1.6],
            'line-opacity': ['interpolate', ['linear'], ['zoom'], 13, 0.35, 16, 0.85],
          },
        });
      }

      if (parcelPoints && !map.getSource(SOURCE.parcels)) {
        map.addSource(SOURCE.parcels, { type: 'geojson', data: parcelPoints });
        map.addLayer({
          id: LAYER.parcelLabels,
          type: 'symbol',
          source: SOURCE.parcels,
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

      raiseRegistered(map);
      attachMeasureLayers(map);
      setCadastreReady(Boolean(cadastre || parcelPoints));
    },
    [tenant, dark, refreshToken],
  );

  const attachCadastreSafely = useCallback(
    (map: mapboxgl.Map, force = false): void => {
      void attachCadastre(map, force).catch(() => {
        map.once('style.load', () => {
          if (mapRef.current === map) void attachCadastre(map, force).catch(() => {});
        });
      });
    },
    [attachCadastre],
  );

  const attachZones = useCallback(
    (map: mapboxgl.Map, data: FeatureCollection) => {
      if (map.getLayer(LAYER.zoneLabels)) map.removeLayer(LAYER.zoneLabels);
      if (map.getLayer(LAYER.zoneLines)) map.removeLayer(LAYER.zoneLines);
      if (map.getLayer(LAYER.zoneFills)) map.removeLayer(LAYER.zoneFills);
      if (map.getSource(SOURCE.zones)) map.removeSource(SOURCE.zones);

      map.addSource(SOURCE.zones, { type: 'geojson', data });
      const beneathLabels = map.getLayer(LAYER.parcelLabels) ? LAYER.parcelLabels : undefined;

      map.addLayer(
        {
          id: LAYER.zoneFills,
          type: 'fill',
          source: SOURCE.zones,
          paint: { 'fill-color': ['to-color', ['get', 'color']], 'fill-opacity': ZONE_FILL_OPACITY },
        },
        beneathLabels,
      );

      map.addLayer(
        {
          id: LAYER.zoneLines,
          type: 'line',
          source: SOURCE.zones,
          paint: {
            'line-color': ['to-color', ['get', 'color']],
            'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 17, 3],
            'line-opacity': ZONE_LINE_OPACITY,
          },
        },
        beneathLabels,
      );

      map.addLayer({
        id: LAYER.zoneLabels,
        type: 'symbol',
        source: SOURCE.zones,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 11, 17, 18],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': dark ? '#ffffff' : '#0f172a',
          'text-halo-color': dark ? 'rgba(0,0,0,0.85)' : '#ffffff',
          'text-halo-width': 1.8,
        },
      });

      const visibility = zonesVisibleRef.current ? 'visible' : 'none';
      for (const id of [LAYER.zoneFills, LAYER.zoneLines, LAYER.zoneLabels]) {
        map.setLayoutProperty(id, 'visibility', visibility);
      }
      applyZoneOpacity(map, activeZoneIdRef.current);

      raiseRegistered(map);
      attachMeasureLayers(map);
    },
    [dark],
  );

  // ── The census layer (P3-T5) ───────────────────────────────────────

  /**
   * The pins, fetched once per session and only when they are asked for.
   *
   * Gated on `buildingsVisible` rather than loaded with the page: this is a
   * second full request beside the registered parcels, and the map is opened
   * far more often to find a citizen than to read the census. The state is kept
   * after the layer is hidden again, so toggling it back on is free.
   */
  useEffect(() => {
    if (!token || !buildingsVisible || buildingPins.length > 0) return;
    let cancelled = false;

    getBuildingMapPins(tenant, token)
      .then((response) => {
        if (!cancelled) setBuildingPins(response.buildings);
      })
      .catch((caught) => {
        // The map still works without the census layer, so a failure costs the
        // toggle rather than the screen.
        logApiError(caught);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, buildingsVisible, buildingPins.length]);

  const censusLegend = useMemo(() => buildingLegend(getLabels(locale)), [locale]);
  const buildingData = useMemo(() => buildingsGeoJson(buildingPins), [buildingPins]);
  const parcelRollupData = useMemo(() => parcelRollupGeoJson(buildingPins), [buildingPins]);

  /**
   * The parcel outlines the plan asks for, from the asset that already exists.
   *
   * Drawn under everything else and deliberately faint: this is the ground the
   * building pins stand on, not a layer to read on its own — `cadastre.geojson`
   * already draws the boundary lines, and what the polygons add is a *fill* a
   * pin can be seen to be inside.
   */
  const attachParcelPolygons = useCallback(
    async (map: mapboxgl.Map) => {
      if (map.getSource(BUILDING_SOURCE.polygons)) return;

      const base = `/tenants/${encodeURIComponent(tenant)}`;
      const apiBase = `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001'}/t/${encodeURIComponent(tenant)}/cadastre/assets`;
      const polygons = await fetchGeoJson(
        `${base}/parcel-polygons.geojson`,
        `${apiBase}/parcel-polygons.geojson`,
      );
      if (!polygons || !mapRef.current || mapRef.current !== map) return;
      if (map.getSource(BUILDING_SOURCE.polygons)) return;

      map.addSource(BUILDING_SOURCE.polygons, { type: 'geojson', data: polygons });

      map.addLayer({
        id: BUILDING_LAYER.polygonFill,
        type: 'fill',
        source: BUILDING_SOURCE.polygons,
        paint: {
          'fill-color': dark ? '#38bdf8' : '#0f766e',
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.04, 18, 0.12],
        },
      });

      map.addLayer({
        id: BUILDING_LAYER.polygonLine,
        type: 'line',
        source: BUILDING_SOURCE.polygons,
        paint: {
          'line-color': dark ? '#7dd3fc' : '#0f766e',
          'line-width': ['interpolate', ['linear'], ['zoom'], 14, 0.3, 18, 1.1],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 14, 0.25, 17, 0.6],
        },
      });
    },
    [tenant, dark],
  );

  /**
   * The three channels, plus the parcel aggregate below the building zoom.
   *
   * Layer order is load-bearing: the ring is drawn first and largest so the
   * fill sits inside it, and the icon last so nothing occludes it. Three layers
   * over one source rather than one styled layer is what makes the channels
   * *independent* — a building can be fully surveyed and unsafe to enter, and
   * the reader has to see both at once.
   */
  const attachBuildings = useCallback(
    (map: mapboxgl.Map) => {
      ensureStructureIcons(map);

      const existing = map.getSource(BUILDING_SOURCE.buildings) as
        | mapboxgl.GeoJSONSource
        | undefined;
      if (existing) {
        existing.setData(buildingData);
        (
          map.getSource(BUILDING_SOURCE.parcelRollup) as mapboxgl.GeoJSONSource | undefined
        )?.setData(parcelRollupData);
        return;
      }

      map.addSource(BUILDING_SOURCE.buildings, { type: 'geojson', data: buildingData });
      map.addSource(BUILDING_SOURCE.parcelRollup, { type: 'geojson', data: parcelRollupData });

      // ── Below the building zoom: one dot per parcel, worst status (D11) ──
      map.addLayer({
        id: BUILDING_LAYER.parcelDot,
        type: 'circle',
        source: BUILDING_SOURCE.parcelRollup,
        maxzoom: BUILDING_ZOOM,
        paint: {
          'circle-color': surveyFillExpression(),
          'circle-stroke-color': damageRingExpression(),
          'circle-stroke-width': 2.5,
          'circle-opacity': 0.9,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['case', ['>', ['get', 'buildings'], 1], 7, 5],
            16,
            ['case', ['>', ['get', 'buildings'], 1], 13, 9],
          ],
        },
      });

      map.addLayer({
        id: BUILDING_LAYER.parcelCount,
        type: 'symbol',
        source: BUILDING_SOURCE.parcelRollup,
        maxzoom: BUILDING_ZOOM,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 16, 13],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': '#ffffff' },
      });

      // ── At building zoom: one pin per structure, three channels ──
      map.addLayer({
        id: BUILDING_LAYER.ring,
        type: 'circle',
        source: BUILDING_SOURCE.buildings,
        minzoom: BUILDING_ZOOM,
        paint: {
          // Transparent fill: this layer exists only for its stroke, which is
          // the damage channel. A filled disc here would put a second colour
          // under the survey fill and muddy both.
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': damageRingExpression(),
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 16, 2.5, 19, 4],
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 11, 19, 18],
        },
      });

      map.addLayer({
        id: BUILDING_LAYER.fill,
        type: 'circle',
        source: BUILDING_SOURCE.buildings,
        minzoom: BUILDING_ZOOM,
        paint: {
          'circle-color': surveyFillExpression(),
          /*
            The lifecycle's channel: a structure nobody can be inside is drawn
            faint rather than in a colour of its own. Three hues already compete
            on this dot, and a permitted plot must not read as urgent work.
          */
          'circle-opacity': lifecycleOpacityExpression(),
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 16, 9, 19, 15],
        },
      });

      map.addLayer({
        id: BUILDING_LAYER.icon,
        type: 'symbol',
        source: BUILDING_SOURCE.buildings,
        minzoom: BUILDING_ZOOM,
        layout: {
          'icon-image': structureIconExpression(),
          'icon-size': ['interpolate', ['linear'], ['zoom'], 16, 0.5, 19, 0.85],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    },
    [buildingData, parcelRollupData],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !buildingsVisible) return;
    attachWhenReady(map, () => {
      void attachParcelPolygons(map).catch(() => {});
      attachBuildings(map);
      raiseRegistered(map);
    });
  }, [buildingsVisible, attachBuildings, attachParcelPolygons]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibility = buildingsVisible ? 'visible' : 'none';
    for (const id of Object.values(BUILDING_LAYER)) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [buildingsVisible, buildingData]);

  /**
   * Clicking a pin opens that building's matrix; clicking a parcel aggregate
   * flies in far enough for its buildings to separate.
   *
   * The same fingertip-sized box the registered dots use, and for the same
   * reason: a 9px circle is not a tap target on a phone in a stairwell.
   */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onClick = (event: mapboxgl.MapMouseEvent) => {
      if (measureModeRef.current !== 'none') return;
      if (!buildingsVisible) return;

      const slop = window.matchMedia?.('(pointer: coarse)').matches ? 14 : 4;
      const box: [[number, number], [number, number]] = [
        [event.point.x - slop, event.point.y - slop],
        [event.point.x + slop, event.point.y + slop],
      ];

      const layers = [BUILDING_LAYER.fill, BUILDING_LAYER.parcelDot].filter((id) =>
        map.getLayer(id),
      );
      if (layers.length === 0) return;

      const hit = map.queryRenderedFeatures(box, { layers })[0];
      if (!hit) return;

      const buildingId = hit.properties?.id as string | undefined;
      if (buildingId) {
        setOpenBuildingId(buildingId);
        return;
      }

      /*
        A parcel aggregate. Zooming past the split point is the useful action
        rather than opening something: the only reason it is one dot is that its
        buildings overlap at this zoom, and the officer's next question is which
        of them they meant.
      */
      if (hit.geometry.type === 'Point') {
        map.flyTo({
          center: hit.geometry.coordinates as [number, number],
          zoom: Math.max(map.getZoom(), BUILDING_ZOOM + 0.6),
          duration: 600,
        });
      }
    };

    map.on('click', onClick);
    return () => {
      map.off('click', onClick);
    };
  }, [buildingsVisible]);

  // ── Map lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    ensureRtlTextPlugin();

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: styleFor(DEFAULT_BASEMAP),
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      preserveDrawingBuffer: true,
    });

    trackStyleSpec(map);

    map.addControl(new mapboxgl.NavigationControl(), 'top-left');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    appliedBasemapRef.current = DEFAULT_BASEMAP;

    map.on('load', () => {
      attachCadastreSafely(map);
      attachMeasureLayers(map);
    });
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount-only: attachCadastre is re-run explicitly on basemap change below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => mapRef.current?.resize());
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // ── Basemap switching ──────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedBasemapRef.current === basemap) return;
    appliedBasemapRef.current = basemap;

    setCadastreReady(false);
    markStyleSwapping(map);
    map.setStyle(styleFor(basemap));
    map.once('style.load', () => {
      attachCadastreSafely(map);
      attachRegisteredRef.current?.(map);
      attachMeasureLayers(map);
    });
  }, [basemap, attachCadastreSafely]);

  // ── Cadastre refresh ───────────────────────────────────────────────
  const appliedRefreshRef = useRef(refreshToken);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || appliedRefreshRef.current === refreshToken) return;
    appliedRefreshRef.current = refreshToken;

    setCadastreReady(false);
    attachCadastreSafely(map, true);
  }, [refreshToken, attachCadastreSafely]);

  // ── Zone overlay ───────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    getZones(tenant, token)
      .then((list) => {
        if (!cancelled) setZones(list.zones);
      })
      .catch(() => {
        if (!cancelled) setZones([]);
      });

    getZonesGeoJson(tenant, token)
      .then((geojson) => {
        if (!cancelled) setZonesGeoJson(geojson);
      })
      .catch(() => {
        if (!cancelled) setZonesGeoJson(null);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, refreshToken]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !zonesGeoJson) return;
    attachWhenReady(map, () => {
      if (mapRef.current === map) attachZones(map, zonesGeoJson);
    });
  }, [zonesGeoJson, cadastreReady, attachZones]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(LAYER.zoneFills)) return;

    const fillVisibility = zonesVisible ? 'visible' : 'none';
    for (const id of [LAYER.zoneFills, LAYER.zoneLines]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', fillVisibility);
    }
    const labelVisibility = zonesVisible && zoneLabelsVisible ? 'visible' : 'none';
    if (map.getLayer(LAYER.zoneLabels)) {
      map.setLayoutProperty(LAYER.zoneLabels, 'visibility', labelVisibility);
    }
  }, [zonesVisible, zoneLabelsVisible, zonesGeoJson, cadastreReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.getLayer(LAYER.zoneFills)) return;
    applyZoneOpacity(map, activeZoneId);
  }, [activeZoneId, zonesGeoJson, cadastreReady]);

  useEffect(() => {
    if (!token || !activeZoneId) {
      setZoneParcelNumbers(null);
      return;
    }
    let cancelled = false;

    getZone(tenant, token, activeZoneId)
      .then((detail) => {
        if (!cancelled) setZoneParcelNumbers(new Set(detail.parcelNumbers));
      })
      .catch(() => {
        if (!cancelled) setZoneParcelNumbers(null);
      });

    return () => {
      cancelled = true;
    };
  }, [tenant, token, activeZoneId]);

  const openParcel = useCallback((parcel: RegisteredParcel) => {
    setSelected(parcel);
    setMatchesOpen(false);
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: [parcel.longitude, parcel.latitude],
      zoom: 17,
      duration: 600,
      offset: sheetOffset(map),
    });
  }, []);

  // ── Registration dots GeoJSON & Coloring ───────────────────────────
  const registeredGeoJson = useMemo<FeatureCollection>(() => {
    let visible = zoneParcelNumbers
      ? parcels.filter((parcel) => zoneParcelNumbers.has(parcel.propertyNumber))
      : parcels;

    if (colorMode === 'paymentStatus' && statusFilter !== 'ALL') {
      visible = visible.filter((p) => (p.financials?.status ?? 'NO_BILLS') === statusFilter);
    }

    if (colorMode === 'propertyType' && propertyTypeFilter !== 'ALL') {
      visible = visible.filter((p) => getParcelUsageCategory(p) === propertyTypeFilter);
    }

    return {
      type: 'FeatureCollection',
      features: visible.map((parcel) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [parcel.longitude, parcel.latitude] },
        properties: {
          propertyNumber: parcel.propertyNumber,
          registrants: parcel.registrants.length,
          focused: parcel.propertyNumber === focusParcelNumber ? 1 : 0,
          paymentStatus: parcel.financials?.status ?? 'NO_BILLS',
          propertyType: getParcelUsageCategory(parcel),
          label: parcel.registrants.length > 1 ? String(parcel.registrants.length) : '',
        },
      })),
    };
  }, [parcels, zoneParcelNumbers, focusParcelNumber, colorMode, statusFilter, propertyTypeFilter]);

  const parcelsRef = useRef(parcels);
  parcelsRef.current = parcels;
  const fittedRef = useRef(false);

  const fillExpression: mapboxgl.ExpressionSpecification = useMemo(() => {
    if (colorMode === 'paymentStatus') {
      return [
        'case',
        ['==', ['get', 'focused'], 1],
        '#3b82f6',
        ['==', ['get', 'paymentStatus'], 'PAID'],
        '#10b981',
        ['==', ['get', 'paymentStatus'], 'PARTIALLY_PAID'],
        '#f59e0b',
        ['==', ['get', 'paymentStatus'], 'UNPAID'],
        '#ef4444',
        '#94a3b8',
      ];
    }
    if (colorMode === 'propertyType') {
      return [
        'case',
        ['==', ['get', 'focused'], 1],
        '#f59e0b',
        ['==', ['get', 'propertyType'], 'RESIDENTIAL'],
        '#3b82f6',
        ['==', ['get', 'propertyType'], 'COMMERCIAL'],
        '#8b5cf6',
        ['==', ['get', 'propertyType'], 'INDUSTRIAL'],
        '#f97316',
        '#64748b',
      ];
    }
    return [
      'case',
      ['==', ['get', 'focused'], 1],
      dark ? DOT.focusDark : DOT.focus,
      dark ? DOT.fillDark : DOT.fill,
    ];
  }, [colorMode, dark]);

  const attachRegistered = useCallback(
    (map: mapboxgl.Map) => {
      const existing = map.getSource(SOURCE.registered) as mapboxgl.GeoJSONSource | undefined;
      if (existing) {
        existing.setData(registeredGeoJson);
        return;
      }

      map.addSource(SOURCE.registered, { type: 'geojson', data: registeredGeoJson });

      map.addLayer({
        id: LAYER.registeredHalo,
        type: 'circle',
        source: SOURCE.registered,
        paint: {
          'circle-color': fillExpression,
          'circle-blur': 0.65,
          'circle-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.18, 17, 0.35],
          'circle-translate': DOT_LIFT,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['case', ['>', ['get', 'registrants'], 1], 11, 8],
            18,
            ['case', ['>', ['get', 'registrants'], 1], 26, 19],
          ],
        },
      });

      map.addLayer({
        id: LAYER.registeredDots,
        type: 'circle',
        source: SOURCE.registered,
        paint: {
          'circle-color': fillExpression,
          'circle-stroke-color': DOT.stroke,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 17, 2.4],
          'circle-translate': DOT_LIFT,
          'circle-radius': [
            'interpolate',
            ['linear'],
            ['zoom'],
            12,
            ['case', ['>', ['get', 'registrants'], 1], 6, 4.5],
            18,
            ['case', ['>', ['get', 'registrants'], 1], 15, 10],
          ],
        },
      });

      map.addLayer({
        id: LAYER.registeredCount,
        type: 'symbol',
        source: SOURCE.registered,
        layout: {
          'text-field': ['get', 'label'],
          'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 12, 9, 18, 15],
          'text-allow-overlap': true,
          'text-ignore-placement': true,
        },
        paint: { 'text-color': DOT.stroke, 'text-translate': DOT_LIFT },
      });

      const visibility = registeredVisible ? 'visible' : 'none';
      for (const id of [LAYER.registeredHalo, LAYER.registeredDots, LAYER.registeredCount]) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
      }
    },
    [registeredGeoJson, fillExpression, registeredVisible],
  );
  attachRegisteredRef.current = attachRegistered;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    attachWhenReady(map, () => attachRegistered(map));
  }, [attachRegistered]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (map.getLayer(LAYER.registeredHalo)) {
      map.setPaintProperty(LAYER.registeredHalo, 'circle-color', fillExpression);
    }
    if (map.getLayer(LAYER.registeredDots)) {
      map.setPaintProperty(LAYER.registeredDots, 'circle-color', fillExpression);
    }
  }, [fillExpression]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const visibility = registeredVisible ? 'visible' : 'none';
    for (const id of [LAYER.registeredHalo, LAYER.registeredDots, LAYER.registeredCount]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
  }, [registeredVisible]);

  // ── Measurement tool GeoJSON synchronization ───────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const source = map.getSource(SOURCE.measure) as mapboxgl.GeoJSONSource | undefined;
    if (!source) return;

    if (measurePoints.length === 0 || measureMode === 'none') {
      source.setData({ type: 'FeatureCollection', features: [] });
      return;
    }

    const features: GeoJSON.Feature[] = [];

    // Points
    for (const pt of measurePoints) {
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: pt },
        properties: {},
      });
    }

    // Line / Polygon
    if (measurePoints.length >= 2) {
      const lineCoords = [...measurePoints];
      if (measureMode === 'area' && measurePoints.length >= 3) {
        lineCoords.push(measurePoints[0]);
        features.push({
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [lineCoords],
          },
          properties: {},
        });
      }

      features.push({
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: lineCoords,
        },
        properties: {},
      });
    }

    source.setData({
      type: 'FeatureCollection',
      features,
    });
  }, [measurePoints, measureMode]);

  // ── Measurement cursor & map click handling ─────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (measureMode !== 'none') {
      map.getCanvas().style.cursor = 'crosshair';
    } else {
      map.getCanvas().style.cursor = '';
      setMeasurePoints([]);
    }
  }, [measureMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const handleMapClick = (e: mapboxgl.MapMouseEvent) => {
      if (measureModeRef.current !== 'none') {
        setMeasurePoints((pts) => [...pts, [e.lngLat.lng, e.lngLat.lat]]);
      }
    };

    map.on('click', handleMapClick);
    return () => {
      map.off('click', handleMapClick);
    };
  }, []);

  // ── Dot interaction handlers ───────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    /**
     * A fingertip is not a cursor. A dot renders 4.5–10px wide, and a
     * layer-scoped `click` is an exact hit test, which made opening a parcel
     * on a phone a game of luck. Query a small box around the tap instead,
     * widened on coarse pointers to roughly a fingertip.
     */
    const onClick = (e: mapboxgl.MapMouseEvent) => {
      if (measureModeRef.current !== 'none') return;
      if (!map.getLayer(LAYER.registeredDots)) return;

      const slop = window.matchMedia?.('(pointer: coarse)').matches ? 14 : 4;
      const box: [[number, number], [number, number]] = [
        [e.point.x - slop, e.point.y - slop],
        [e.point.x + slop, e.point.y + slop],
      ];

      const propertyNumber = map.queryRenderedFeatures(box, {
        layers: [LAYER.registeredDots],
      })[0]?.properties?.propertyNumber;
      if (!propertyNumber) return;
      const matched = parcelsRef.current.find((p) => p.propertyNumber === propertyNumber);
      if (matched) openParcel(matched);
    };

    const enter = () => {
      if (measureModeRef.current === 'none') map.getCanvas().style.cursor = 'pointer';
    };
    const leave = () => {
      if (measureModeRef.current === 'none') map.getCanvas().style.cursor = '';
    };

    map.on('click', onClick);
    map.on('mouseenter', LAYER.registeredDots, enter);
    map.on('mouseleave', LAYER.registeredDots, leave);

    return () => {
      map.off('click', onClick);
      map.off('mouseenter', LAYER.registeredDots, enter);
      map.off('mouseleave', LAYER.registeredDots, leave);
    };
  }, [openParcel]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || fittedRef.current) return;
    if (focusParcelNumber || selectedRef.current) return;

    const features = registeredGeoJson.features;
    if (features.length === 0) return;

    const bounds = new mapboxgl.LngLatBounds();
    for (const feature of features) {
      if (feature.geometry.type !== 'Point') continue;
      bounds.extend(feature.geometry.coordinates as [number, number]);
    }
    map.fitBounds(bounds, { padding: 96, maxZoom: 16, duration: 0 });
    fittedRef.current = true;
  }, [registeredGeoJson, focusParcelNumber]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !selected) return;

    const element = document.createElement('div');
    element.className = 'map-selected-pin';
    selectedPinRef.current?.remove();
    selectedPinRef.current = new mapboxgl.Marker({ element, anchor: 'bottom' })
      .setLngLat([selected.longitude, selected.latitude])
      .addTo(map);

    return () => {
      selectedPinRef.current?.remove();
      selectedPinRef.current = null;
    };
  }, [selected]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || focusLat == null || focusLng == null) return;

    const element = document.createElement('div');
    element.className = 'map-citizen-pin';
    citizenPinRef.current?.remove();
    citizenPinRef.current = new mapboxgl.Marker({ element })
      .setLngLat([focusLng, focusLat])
      .addTo(map);
    map.flyTo({ center: [focusLng, focusLat], zoom: 17, duration: 900 });

    return () => {
      citizenPinRef.current?.remove();
      citizenPinRef.current = null;
    };
  }, [focusLat, focusLng]);

  useEffect(() => {
    if (!focusParcelNumber || focusMatchedRef.current === focusParcelNumber) return;
    const matched = parcels.find((parcel) => parcel.propertyNumber === focusParcelNumber);
    if (!matched) return;

    focusMatchedRef.current = focusParcelNumber;
    citizenPinRef.current?.remove();
    citizenPinRef.current = null;
    openParcel(matched);
  }, [parcels, focusParcelNumber, openParcel]);

  // ── Search by رقم العقار ────────────────────────────────────────────
  const runSearch = useCallback(
    async (term?: string) => {
      const map = mapRef.current;
      const propertyNumber = (term ?? query).trim();
      if (!map || !propertyNumber) return;

      if (term) setQuery(term);
      setMatchesOpen(false);
      setSuggestions([]);
      setSearchStatus('searching');

      const local = parcels.find((p) => p.propertyNumber === propertyNumber);
      if (local) {
        setSearchStatus('idle');
        openParcel(local);
        return;
      }

      try {
        const result = await checkPropertyNumber(tenant, propertyNumber);

        if (result.location) {
          setSearchStatus('idle');

          const element = document.createElement('div');
          element.className = 'map-search-pin';
          searchMarkerRef.current?.remove();
          searchMarkerRef.current = new mapboxgl.Marker({ element })
            .setLngLat([result.location.longitude, result.location.latitude])
            .addTo(map);

          map.flyTo({
            center: [result.location.longitude, result.location.latitude],
            zoom: 17,
            duration: 800,
          });
        } else {
          setSearchStatus('not-found');
          setSuggestions(result.suggestions ?? []);
        }
      } catch {
        setSearchStatus('not-found');
      }
    },
    [tenant, query, parcels, openParcel],
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || mapReady) return;

    const onIdle = () => {
      setMapReady(true);
      map.off('idle', onIdle);
    };
    map.on('idle', onIdle);

    return () => {
      map.off('idle', onIdle);
    };
  }, [mapReady]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setSearchStatus('idle');
    setSuggestions([]);
    setMatchesOpen(false);
    searchMarkerRef.current?.remove();
    searchMarkerRef.current = null;
  }, []);

  // ── Map Export Trigger ──────────────────────────────────────────────
  const handleExportMap = () => {
    const map = mapRef.current;
    if (!map) return;
    try {
      const dataUrl = map.getCanvas().toDataURL('image/png');
      setMapDataUrl(dataUrl);
      setExportOpen(true);
    } catch {
      // ignore
    }
  };

  // ── Reset View Trigger ──────────────────────────────────────────────
  const handleResetView = () => {
    const map = mapRef.current;
    if (!map) return;
    map.flyTo({
      center: FALLBACK_CENTER,
      zoom: FALLBACK_ZOOM,
      bearing: 0,
      pitch: 0,
      duration: 800,
    });
  };

  return (
    <div
      className="group/map relative h-full w-full"
      data-sheet-open={selected ? "true" : undefined}
    >
      <div ref={containerRef} className="h-full w-full" aria-label="خريطة العقارات" />

      {/* Loading Cover */}
      <div
        aria-hidden={mapReady}
        className={cn(
          'absolute inset-0 z-30 flex flex-col items-center justify-center gap-3',
          'bg-background transition-opacity duration-500',
          mapReady ? 'pointer-events-none opacity-0' : 'opacity-100',
        )}
      >
        <Loader2 className="size-7 animate-spin text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">جارٍ تحضير الخريطة…</p>
      </div>

      {/*
        Top Map Toolbar: Search + Controls.

      {/*
        Top Map Toolbar: Search + Controls.

        Two rows on a phone — a full-width sleek search field, then the tool cluster
        when it is asked for — collapsing to the single centred row from `sm`
        up via `sm:contents`.
      */}
      <div className="absolute inset-x-2 top-2 z-20 flex flex-col gap-2 sm:inset-x-auto sm:left-1/2 sm:top-3 sm:w-auto sm:max-w-[calc(100%-1.5rem)] sm:-translate-x-1/2 sm:flex-row sm:flex-nowrap sm:items-center sm:justify-center sm:gap-2">
        <div className="flex items-center gap-2 sm:contents">
          {/* Search by رقم العقار */}
          <div className="relative min-w-0 flex-1 shrink sm:w-[15rem] sm:flex-none md:w-[17rem]">
            <div className="flex items-center gap-1.5 rounded-2xl border border-border/80 bg-card/95 p-1 shadow-lg backdrop-blur-md transition-all focus-within:ring-2 focus-within:ring-primary/20">
              <Search className="ms-2.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMatchesOpen(true);
                  if (searchStatus === 'not-found') setSearchStatus('idle');
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runSearch();
                  if (e.key === 'Escape') clearSearch();
                }}
                placeholder={locale === 'en' ? 'Search parcel number…' : 'ابحث برقم العقار…'}
                aria-label={locale === 'en' ? 'Search parcel number' : 'ابحث برقم العقار'}
                className="h-9 min-w-0 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 sm:h-8"
              />
              {query ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={clearSearch}
                  aria-label={locale === 'en' ? 'Clear search' : 'مسح البحث'}
                  className="size-8 shrink-0 cursor-pointer text-muted-foreground hover:text-foreground sm:size-7"
                >
                  <X className="size-3.5" aria-hidden />
                </Button>
              ) : null}
              <Button
                size="sm"
                onClick={() => void runSearch()}
                disabled={searchStatus === 'searching' || !query.trim()}
                className="h-8 shrink-0 px-3 text-xs font-semibold rounded-xl bg-primary text-primary-foreground shadow-xs cursor-pointer hover:bg-primary/90 transition-colors sm:h-7"
              >
                {searchStatus === 'searching' ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                ) : (
                  locale === 'en' ? 'Search' : 'بحث'
                )}
              </Button>
            </div>

            {/* Typeahead match list */}
            {matchesOpen && localMatches.length > 0 ? (
              <ul className="absolute left-0 right-0 top-full mt-1.5 overflow-hidden rounded-2xl border bg-card/95 shadow-xl backdrop-blur-md z-50">
                {localMatches.map((parcel) => (
                  <li key={parcel.propertyNumber}>
                    <button
                      type="button"
                      onClick={() => {
                        setQuery(parcel.propertyNumber);
                        setMatchesOpen(false);
                        setSearchStatus('idle');
                        openParcel(parcel);
                      }}
                      className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm transition-colors hover:bg-accent cursor-pointer"
                    >
                      <span className="font-medium">
                        {locale === 'en' ? `Parcel #${parcel.propertyNumber}` : `العقار رقم ${parcel.propertyNumber}`}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {locale === 'en'
                          ? `${parcel.registrants.length} registered`
                          : `${parcel.registrants.length} مسجّل`}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {searchStatus === 'not-found' ? (
              <div className="absolute left-0 right-0 top-full mt-1.5 rounded-2xl border bg-card/95 px-3.5 py-2.5 shadow-xl backdrop-blur-md z-50">
                <p className="text-xs font-medium text-destructive">
                  {locale === 'en' ? 'No parcel found with this number' : 'لا يوجد عقار بهذا الرقم'}
                </p>
                {suggestions.length > 0 ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">
                      {locale === 'en' ? 'Did you mean:' : 'هل تقصد'}
                    </span>
                    {suggestions.map((suggestion) => (
                      <Button
                        key={suggestion}
                        variant="outline"
                        size="sm"
                        onClick={() => void runSearch(suggestion)}
                        className="h-6 px-2 text-xs rounded-lg cursor-pointer"
                      >
                        {suggestion}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              setToolsOpen((open) => !open);
              setFinanceMenuOpen(false);
              setMeasureMenuOpen(false);
            }}
            aria-expanded={toolsOpen}
            aria-label={locale === 'en' ? 'Map tools' : 'أدوات الخريطة'}
            className={cn(
              'size-11 shrink-0 rounded-2xl border border-border/80 bg-card/95 shadow-lg backdrop-blur-md sm:hidden transition-all flex items-center justify-center',
              toolsOpen || colorMode !== 'default' || measureMode !== 'none' || !registeredVisible
                ? 'border-primary/60 bg-primary/10 text-primary ring-2 ring-primary/20'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent',
            )}
          >
            <SlidersHorizontal className="size-4.5" aria-hidden />
          </Button>
        </div>

        {/*
          Toolbar Controls.
        */}
        <div
          className={cn(
            'relative overflow-x-auto max-w-full items-center gap-1.5 rounded-2xl border border-border/80 bg-card/95 p-1.5 shadow-lg backdrop-blur-md no-scrollbar animate-in fade-in-0 slide-in-from-top-1 duration-200',
            'sm:flex sm:flex-nowrap sm:shrink-0 sm:rounded-xl sm:p-1 sm:shadow-md sm:animate-none',
            toolsOpen ? 'flex' : 'hidden',
          )}
        >
          {/* Toggle Points Button */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRegisteredVisible((v) => !v)}
            title={
              registeredVisible
                ? (locale === 'en' ? 'Hide Registered Points' : 'إخفاء نقاط العقارات')
                : (locale === 'en' ? 'Show Registered Points' : 'إظهار نقاط العقارات')
            }
            className={cn(
              'h-9 shrink-0 gap-1.5 px-2.5 text-xs font-semibold cursor-pointer rounded-xl transition-all sm:h-8 sm:rounded-lg',
              registeredVisible
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {registeredVisible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5 text-muted-foreground" />}
            <span>
              {registeredVisible
                ? (locale === 'en' ? 'Points' : 'النقاط')
                : (locale === 'en' ? 'Hidden' : 'مخفية')}
            </span>
          </Button>

          {/* Toggle the census layer (P3-T5) */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setBuildingsVisible((v) => !v);
              setBuildingLegendOpen((open) => (buildingsVisible ? false : open));
            }}
            title={
              buildingsVisible
                ? locale === 'en'
                  ? 'Hide the building census'
                  : 'إخفاء سجل المباني'
                : locale === 'en'
                  ? 'Show the building census'
                  : 'إظهار سجل المباني'
            }
            className={cn(
              'h-9 shrink-0 gap-1.5 px-2.5 text-xs font-semibold cursor-pointer rounded-xl transition-all sm:h-8 sm:rounded-lg',
              buildingsVisible
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            <Building2 className="size-3.5" aria-hidden />
            <span>{locale === 'en' ? 'Buildings' : 'المباني'}</span>
          </Button>

          {/* The three channels need explaining, so the legend rides with them. */}
          {buildingsVisible ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setBuildingLegendOpen((open) => !open)}
              aria-expanded={buildingLegendOpen}
              title={locale === 'en' ? 'Census legend' : 'مفتاح سجل المباني'}
              className={cn(
                'h-9 shrink-0 gap-1.5 px-2.5 text-xs font-semibold cursor-pointer rounded-xl transition-all sm:h-8 sm:rounded-lg',
                buildingLegendOpen
                  ? 'bg-primary/10 text-primary hover:bg-primary/20'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Info className="size-3.5" aria-hidden />
              <span>{locale === 'en' ? 'Legend' : 'المفتاح'}</span>
            </Button>
          ) : null}

          {/* Color & Filter Dropdown Menu */}
          <div className="static sm:relative">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setFinanceMenuOpen((o) => !o);
                setMeasureMenuOpen(false);
              }}
              title={locale === 'en' ? 'Point Color & Filter Mode' : 'وضع تلوين وتصفية النقاط'}
              className={cn(
                'h-9 shrink-0 gap-1.5 px-2.5 text-xs font-semibold cursor-pointer rounded-xl transition-all sm:h-8 sm:rounded-lg',
                colorMode !== 'default'
                  ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300 hover:bg-amber-500/25 border border-amber-500/30'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Coins className="size-3.5" />
              <span>{locale === 'en' ? 'Color' : 'تلوين'}</span>
              {colorMode !== 'default' ? (
                <span
                  className={cn(
                    'size-2 rounded-full inline-block shrink-0',
                    colorMode === 'paymentStatus' ? 'bg-emerald-500' : 'bg-purple-500',
                  )}
                />
              ) : null}
              <ChevronDown className="size-3 opacity-60" />
            </Button>

            {financeMenuOpen ? (
              <div className="absolute inset-x-0 top-full mt-1.5 z-50 w-auto rounded-xl sm:inset-x-auto sm:end-0 sm:w-60 border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-xl backdrop-blur-md outline-hidden animate-in fade-in-0 zoom-in-95">
                <div className="px-2 py-1 text-[11px] font-bold text-muted-foreground border-b border-border/40 mb-1">
                  {locale === 'en' ? 'Point Color Mode' : 'وضع تلوين وتصنيف النقاط'}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setColorMode('default');
                    setStatusFilter('ALL');
                    setPropertyTypeFilter('ALL');
                    setFinanceMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-start cursor-pointer transition-colors',
                    colorMode === 'default' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full bg-blue-600 inline-block" />
                    {locale === 'en' ? 'Default (Blue)' : 'الافتراضي (أزرق)'}
                  </span>
                  {colorMode === 'default' ? <Check className="size-3.5" /> : null}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setColorMode('paymentStatus');
                    setFinanceMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-start cursor-pointer transition-colors',
                    colorMode === 'paymentStatus' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full bg-emerald-500 inline-block" />
                    {locale === 'en' ? 'By Payment Status' : 'حسب تسديد الرسوم'}
                  </span>
                  {colorMode === 'paymentStatus' ? <Check className="size-3.5" /> : null}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setColorMode('propertyType');
                    setFinanceMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-start cursor-pointer transition-colors',
                    colorMode === 'propertyType' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="size-2.5 rounded-full bg-purple-500 inline-block" />
                    {locale === 'en' ? 'By Property Usage' : 'حسب نوع الإشغال'}
                  </span>
                  {colorMode === 'propertyType' ? <Check className="size-3.5" /> : null}
                </button>

                {colorMode === 'paymentStatus' ? (
                  <div className="mt-2 pt-2 border-t border-border/40 space-y-1">
                    <div className="px-2 text-[10px] font-bold text-muted-foreground">
                      {locale === 'en' ? 'Filter on map:' : 'تصفية العرض:'}
                    </div>

                    {[
                      { id: 'ALL' as const, labelAr: 'عرض جميع العقارات', labelEn: 'Show All' },
                      { id: 'UNPAID' as const, labelAr: '🔴 غير مسدد فقط (ذمم)', labelEn: '🔴 Unpaid Debt Only' },
                      { id: 'PARTIALLY_PAID' as const, labelAr: '🟡 مسدد جزئياً فقط', labelEn: '🟡 Partially Paid Only' },
                      { id: 'PAID' as const, labelAr: '🟢 مسدد بالكامل فقط', labelEn: '🟢 Fully Paid Only' },
                      { id: 'NO_BILLS' as const, labelAr: '⚪ لا توجد رسوم', labelEn: '⚪ No Active Bills' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setStatusFilter(f.id);
                          setFinanceMenuOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2 py-1 text-[11px] text-start cursor-pointer transition-colors',
                          statusFilter === f.id ? 'bg-accent font-bold text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        <span>{locale === 'en' ? f.labelEn : f.labelAr}</span>
                        {statusFilter === f.id ? <Check className="size-3" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}

                {colorMode === 'propertyType' ? (
                  <div className="mt-2 pt-2 border-t border-border/40 space-y-1">
                    <div className="px-2 text-[10px] font-bold text-muted-foreground">
                      {locale === 'en' ? 'Filter usage:' : 'تصفية الإشغال:'}
                    </div>

                    {[
                      { id: 'ALL' as const, labelAr: 'عرض الكل', labelEn: 'Show All' },
                      { id: 'RESIDENTIAL' as const, labelAr: '🔵 سكني فقط', labelEn: '🔵 Residential Only' },
                      { id: 'COMMERCIAL' as const, labelAr: '🟣 تجاري ومحلات فقط', labelEn: '🟣 Commercial Only' },
                      { id: 'INDUSTRIAL' as const, labelAr: '🟠 صناعي / أخرى', labelEn: '🟠 Industrial / Other' },
                    ].map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => {
                          setPropertyTypeFilter(f.id);
                          setFinanceMenuOpen(false);
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2 py-1 text-[11px] text-start cursor-pointer transition-colors',
                          propertyTypeFilter === f.id ? 'bg-accent font-bold text-foreground' : 'text-muted-foreground hover:bg-accent/50',
                        )}
                      >
                        <span>{locale === 'en' ? f.labelEn : f.labelAr}</span>
                        {propertyTypeFilter === f.id ? <Check className="size-3" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* GIS Measurement Tools */}
          <div className="static sm:relative">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setMeasureMenuOpen((o) => !o);
                setFinanceMenuOpen(false);
              }}
              title={locale === 'en' ? 'GIS Measurement Tools (Distance & Area)' : 'أدوات القياس (مسافات ومساحات)'}
              className={cn(
                'h-9 gap-1.5 px-2 text-xs font-semibold cursor-pointer rounded-lg transition-all sm:h-8',
                measureMode !== 'none'
                  ? 'bg-primary/20 text-primary font-bold border border-primary/30'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              <Ruler className="size-3.5" />
              <span className="hidden sm:inline">
                {measureMode === 'distance'
                  ? (locale === 'en' ? 'Distance' : 'مسافة')
                  : measureMode === 'area'
                    ? (locale === 'en' ? 'Area' : 'مساحة')
                    : (locale === 'en' ? 'Measure' : 'قياس')}
              </span>
              <ChevronDown className="size-3 opacity-60" />
            </Button>

            {measureMenuOpen ? (
              <div className="absolute inset-x-0 top-full mt-1.5 z-50 w-auto rounded-xl sm:inset-x-auto sm:end-0 sm:w-52 border border-border/80 bg-popover p-1.5 text-popover-foreground shadow-xl backdrop-blur-md outline-hidden animate-in fade-in-0 zoom-in-95">
                <div className="px-2 py-1 text-[11px] font-bold text-muted-foreground border-b border-border/40 mb-1">
                  {locale === 'en' ? 'Measurement Mode' : 'نوع القياس'}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setMeasureMode('distance');
                    setMeasurePoints([]);
                    setMeasureMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-start cursor-pointer transition-colors',
                    measureMode === 'distance' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Ruler className="size-3.5" />
                    {locale === 'en' ? 'Distance (Meters / KM)' : 'قياس المسافة (متر / كم)'}
                  </span>
                  {measureMode === 'distance' ? <Check className="size-3.5" /> : null}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setMeasureMode('area');
                    setMeasurePoints([]);
                    setMeasureMenuOpen(false);
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs text-start cursor-pointer transition-colors',
                    measureMode === 'area' ? 'bg-primary text-primary-foreground font-semibold' : 'hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Maximize2 className="size-3.5" />
                    {locale === 'en' ? 'Area (m² / Dunams)' : 'قياس المساحة (م² / دونم)'}
                  </span>
                  {measureMode === 'area' ? <Check className="size-3.5" /> : null}
                </button>

                {measureMode !== 'none' ? (
                  <button
                    type="button"
                    onClick={() => {
                      setMeasureMode('none');
                      setMeasurePoints([]);
                      setMeasureMenuOpen(false);
                    }}
                    className="mt-1 w-full rounded-lg px-2 py-1 text-xs text-start text-destructive hover:bg-destructive/10 cursor-pointer transition-colors"
                  >
                    {locale === 'en' ? 'Stop Measuring' : 'إيقاف القياس'}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>

          {/* Export & Print Button */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleExportMap}
            title={locale === 'en' ? 'Export & Print Map View' : 'طباعة وتصدير المخطط'}
            className="h-9 gap-1.5 px-2 text-xs font-semibold text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer rounded-lg transition-all sm:h-8"
          >
            <Printer className="size-3.5" />
            <span className="hidden lg:inline">{locale === 'en' ? 'Export' : 'طباعة'}</span>
          </Button>

          {/* Reset Municipality View Button */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleResetView}
            title={locale === 'en' ? 'Reset to full municipality view' : 'إعادة التمركز للبلدية'}
            className="size-9 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer rounded-lg transition-all sm:size-8"
          >
            <Crosshair className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Floating Measurement HUD */}
      {measureMode !== 'none' ? (
        <div className="absolute inset-x-2 bottom-[4.5rem] z-20 flex flex-wrap items-center justify-center gap-3 rounded-2xl sm:inset-x-auto sm:bottom-16 sm:left-1/2 sm:-translate-x-1/2 sm:justify-start border border-border/80 bg-card/95 px-4 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in-0 slide-in-from-bottom-2">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <Ruler className="size-4" />
            </span>
            <div>
              <p className="text-[11px] font-medium text-muted-foreground">
                {measureMode === 'distance'
                  ? (locale === 'en' ? 'Distance Measurement' : 'قياس المسافة')
                  : (locale === 'en' ? 'Area Measurement' : 'قياس المساحة')}
              </p>
              <p className="text-sm font-bold text-foreground">
                {measureMode === 'distance'
                  ? formatDistance(liveDistance.meters, locale)
                  : formatArea(liveArea.squareMeters, locale)}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-1.5 border-s border-border/60 ps-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMeasurePoints((pts) => pts.slice(0, -1))}
              disabled={measurePoints.length === 0}
              className="h-8 px-2 text-xs cursor-pointer gap-1 sm:h-7"
              title={locale === 'en' ? 'Undo last point' : 'تراجع عن آخر نقطة'}
            >
              <Undo2 className="size-3" />
              <span>{locale === 'en' ? 'Undo' : 'تراجع'}</span>
            </Button>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setMeasurePoints([])}
              disabled={measurePoints.length === 0}
              className="h-8 px-2 text-xs cursor-pointer gap-1 text-destructive hover:text-destructive sm:h-7"
              title={locale === 'en' ? 'Clear points' : 'مسح القياس'}
            >
              <Trash2 className="size-3" />
              <span>{locale === 'en' ? 'Clear' : 'مسح'}</span>
            </Button>

            <Button
              type="button"
              size="sm"
              onClick={() => setMeasureMode('none')}
              className="h-8 px-3 text-xs font-semibold cursor-pointer sm:h-7"
            >
              {locale === 'en' ? 'Done' : 'إنهاء'}
            </Button>
          </div>
        </div>
      ) : null}

      <style>{`
        .map-selected-pin {
          position: relative;
          width: 28px; height: 28px;
          border-radius: 50% 50% 50% 0;
          transform: rotate(-45deg);
          background: hsl(var(--warning));
          border: 3px solid #fff;
          box-shadow: 0 2px 10px rgba(15, 23, 42, 0.55);
        }
        .map-selected-pin::before {
          content: '';
          position: absolute;
          inset: 6px;
          border-radius: 9999px;
          background: #fff;
        }
        .map-selected-pin::after {
          content: '';
          position: absolute;
          inset: -10px;
          border-radius: 9999px;
          border: 2px solid hsl(var(--warning));
          animation: map-search-pulse 1.8s ease-out 3;
        }

        .map-citizen-pin {
          position: relative;
          width: 20px; height: 20px;
          border-radius: 9999px;
          background: hsl(var(--warning));
          border: 3px solid #fff;
          box-shadow: 0 2px 8px rgba(15, 23, 42, 0.45);
          animation: map-search-pulse 1.6s ease-out infinite;
        }

        .map-search-pin {
          width: 22px; height: 22px;
          border-radius: 9999px;
          border: 3px solid hsl(var(--destructive));
          box-shadow: 0 0 0 4px rgba(0,0,0,0.08);
          animation: map-search-pulse 1.4s ease-out 2;
        }
        @keyframes map-search-pulse {
          0% { transform: scale(0.6); opacity: 0.9; }
          70% { transform: scale(1.6); opacity: 0; }
          100% { transform: scale(1.6); opacity: 0; }
        }

        @media (max-width: 639px) {
          /* Clears the parcel sheet, which tops out at 75dvh. */
          [data-sheet-open] .mapboxgl-ctrl-bottom-left,
          [data-sheet-open] .mapboxgl-ctrl-bottom-right {
            bottom: calc(75dvh + 0.5rem);
            /* Undoes the basemap-switcher clearance below, which the sheet
               has already lifted these well past. */
            margin-bottom: 0;
            transition: bottom 300ms ease;
          }

          /* The zoom/compass stack sits exactly where the search row now is.
             Pinch already zooms on touch and «إعادة التمركز» in the toolbar is
             the compass reset, so nothing is lost by dropping it. */
          .mapboxgl-ctrl-top-left {
            display: none;
          }

          /* Above the basemap switcher, centred at the same height. */
          .mapboxgl-ctrl-bottom-left {
            margin-bottom: 3rem;
          }
        }
      `}</style>

      {/* Top Right Corner Widgets */}
      <div
        className={cn(
          'absolute right-2 top-[3.75rem] z-20 flex flex-col gap-1.5',
          'sm:right-3 sm:top-3 sm:w-52',
          // The phone tool cluster drops down over exactly this corner.
          toolsOpen ? 'hidden sm:flex' : 'flex',
        )}
      >
        {zones.length > 0 ? (
          <div className="w-44 sm:w-52">
            <ZoneLegend
              zones={zones}
              visible={zonesVisible}
              onVisibleChange={setZonesVisible}
              labelsVisible={zoneLabelsVisible}
              onLabelsVisibleChange={setZoneLabelsVisible}
              activeZoneId={activeZoneId}
              onSelectZone={setActiveZoneId}
              onOpenZoneInfo={(zone) => {
                setSelectedZoneInfo(zone);
                setZoneInfoOpen(true);
              }}
              locale={locale}
            />
          </div>
        ) : (
          <div className="hidden sm:block sm:w-52">
            <ZoneLegend
              zones={zones}
              visible={zonesVisible}
              onVisibleChange={setZonesVisible}
              labelsVisible={zoneLabelsVisible}
              onLabelsVisibleChange={setZoneLabelsVisible}
              activeZoneId={activeZoneId}
              onSelectZone={setActiveZoneId}
              onOpenZoneInfo={(zone) => {
                setSelectedZoneInfo(zone);
                setZoneInfoOpen(true);
              }}
              locale={locale}
            />
          </div>
        )}

        {/* Parcel count badge: Compact chip on mobile, full card on desktop */}
        <div className="self-end rounded-2xl border border-border/80 bg-card/95 px-3 py-1.5 shadow-lg backdrop-blur-md sm:w-full sm:rounded-xl sm:shadow-md">
          <p className="text-xs font-bold text-foreground pointer-events-none flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-primary inline-block shrink-0 sm:hidden" />
            <span>
              {zoneParcelNumbers
                ? parcels.filter((parcel) => zoneParcelNumbers.has(parcel.propertyNumber)).length
                : parcels.length}{' '}
              {locale === 'en' ? 'registered parcels' : 'عقار مسجّل'}
            </span>
          </p>
          {activeZoneId ? (
            <div className="flex items-center justify-between gap-1 pt-0.5 border-t border-border/40 mt-1">
              <p className="text-[11px] text-primary font-semibold truncate pointer-events-none">
                {locale === 'en'
                  ? `Sector: ${zones.find((zone) => zone.id === activeZoneId)?.name ?? ''}`
                  : `قطاع ${zones.find((zone) => zone.id === activeZoneId)?.name ?? ''}`}
              </p>
              <button
                type="button"
                onClick={() => {
                  const z = zones.find((zone) => zone.id === activeZoneId);
                  if (z) {
                    setSelectedZoneInfo(z);
                    setZoneInfoOpen(true);
                  }
                }}
                className="text-[10px] font-bold text-primary hover:underline flex items-center gap-0.5 shrink-0 cursor-pointer"
              >
                <span>{locale === 'en' ? 'Area & Info' : 'المساحة'}</span>
              </button>
            </div>
          ) : cadastreReady ? (
            <p className="hidden sm:block text-[11px] text-muted-foreground truncate pointer-events-none">
              {locale === 'en' ? 'Pins on registered parcels' : 'النقاط على العقارات المسجّلة'}
            </p>
          ) : null}
        </div>

        {/* Financial Mini Legend when Payment Status mode is active */}
        {colorMode === 'paymentStatus' ? (
          <div className="pointer-events-none rounded-xl border border-border/80 bg-card/95 p-2 shadow-md backdrop-blur text-xs space-y-1 animate-in fade-in-0 duration-200">
            <div className="flex items-center gap-1 font-bold text-[10px] text-muted-foreground">
              <Coins className="size-3 text-primary" />
              <span>{locale === 'en' ? 'Payment Legend' : 'دليل حالة الرسوم'}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-emerald-500" />
                <span>{locale === 'en' ? 'Paid' : 'مسدد'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-amber-500" />
                <span>{locale === 'en' ? 'Partial' : 'جزئي'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-rose-500" />
                <span>{locale === 'en' ? 'Unpaid' : 'غير مسدد'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-slate-400" />
                <span>{locale === 'en' ? 'No Bills' : 'بدون رسوم'}</span>
              </span>
            </div>
          </div>
        ) : null}

        {/* Usage Mini Legend when Property Type mode is active */}
        {colorMode === 'propertyType' ? (
          <div className="pointer-events-none rounded-xl border border-border/80 bg-card/95 p-2 shadow-md backdrop-blur text-xs space-y-1 animate-in fade-in-0 duration-200">
            <div className="flex items-center gap-1 font-bold text-[10px] text-muted-foreground">
              <Coins className="size-3 text-primary" />
              <span>{locale === 'en' ? 'Usage Legend' : 'دليل نوع الإشغال'}</span>
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-blue-500" />
                <span>{locale === 'en' ? 'Residential' : 'سكني'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-purple-500" />
                <span>{locale === 'en' ? 'Commercial' : 'تجاري'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-orange-500" />
                <span>{locale === 'en' ? 'Industrial' : 'صناعي'}</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="size-2 rounded-full bg-slate-400" />
                <span>{locale === 'en' ? 'Other' : 'أخرى'}</span>
              </span>
            </div>
          </div>
        ) : null}
      </div>

      <MapLayerControl value={basemap} onChange={setBasemap} locale={locale} />

      <CitizenDetailDrawer
        parcel={selected}
        citizenHref={citizenHref}
        onClose={() => setSelected(null)}
        locale={locale}
      />

      <MapExportDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        mapDataUrl={mapDataUrl}
        tenant={tenant}
        locale={locale}
      />

      {/*
        The census legend.

        Three channels is two more than a map usually asks a reader to hold, so
        it is spelled out rather than left to be inferred — and it is only
        offered while the layer is on, because a legend for something invisible
        is furniture.
      */}
      {buildingsVisible && buildingLegendOpen ? (
        <div className="pointer-events-auto absolute inset-x-2 bottom-20 z-20 max-h-[45dvh] overflow-y-auto rounded-xl border bg-card/95 p-3 text-xs shadow-lg backdrop-blur sm:inset-x-auto sm:end-3 sm:top-20 sm:bottom-auto sm:w-64">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-semibold">
              {locale === 'en' ? 'Building census' : 'سجل المباني'}
            </p>
            <button
              type="button"
              onClick={() => setBuildingLegendOpen(false)}
              aria-label={locale === 'en' ? 'Close the legend' : 'إغلاق المفتاح'}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>

          <p className="mb-2 leading-relaxed text-muted-foreground">
            {locale === 'en'
              ? 'Icon = structure · fill = survey · ring = damage. No ring means nobody has assessed it.'
              : 'الأيقونة = نوع المنشأة · التعبئة = حالة المسح · الحلقة = مستوى الضرر. غياب الحلقة يعني أنه لم يُكشف عليه بعد.'}
          </p>

          <p className="mb-1 font-medium">
            {locale === 'en' ? 'Fill — survey' : 'التعبئة — حالة المسح'}
          </p>
          <ul className="mb-2 space-y-1">
            {censusLegend.survey.map((entry) => (
              <li key={entry.key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border border-black/20"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="truncate">{entry.label}</span>
              </li>
            ))}
          </ul>

          <p className="mb-1 font-medium">
            {locale === 'en' ? 'Ring — damage' : 'الحلقة — مستوى الضرر'}
          </p>
          <ul className="space-y-1">
            {censusLegend.damage.map((entry) => (
              <li key={entry.key} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className="size-3 shrink-0 rounded-full border-2 bg-transparent"
                  style={{ borderColor: entry.color }}
                />
                <span className="truncate">{entry.label}</span>
              </li>
            ))}
          </ul>

          <p className="mt-2 leading-relaxed text-muted-foreground">
            {locale === 'en'
              ? `Below zoom ${BUILDING_ZOOM} a parcel shows one dot carrying its worst status; tap it to zoom in.`
              : `دون مستوى التكبير ${BUILDING_ZOOM} يظهر العقار كنقطة واحدة تحمل أسوأ حالة فيه؛ انقر عليها للتكبير.`}
          </p>
        </div>
      ) : null}

      {/*
        Clicking a pin opens the same matrix the census ledger opens — the same
        component, so an officer who logs a visit from the map and one who logs
        it from the ledger are using one screen, not two that have to be kept in
        step.
      */}
      {token ? (
        <BuildingUnitMatrixDrawer
          open={openBuildingId !== null}
          onClose={() => setOpenBuildingId(null)}
          tenant={tenant}
          token={token}
          buildingId={openBuildingId}
          canWrite
          registerHref={registerHref}
          // The same builder the parcel popups already use, so an occupant's
          // name leads to the same record from either layer.
          citizenHref={citizenHref}
          onChanged={() => {
            // The pin's own fill and ring are derived from what just changed,
            // so the layer is re-read rather than left showing the old rollup.
            if (!token) return;
            void getBuildingMapPins(tenant, token)
              .then((response) => setBuildingPins(response.buildings))
              .catch(logApiError);
          }}
          locale={locale}
        />
      ) : null}

      <ZoneInfoDialog
        zone={selectedZoneInfo}
        open={zoneInfoOpen}
        onOpenChange={setZoneInfoOpen}
        zonesGeoJson={zonesGeoJson}
        parcels={parcels}
        tenant={tenant}
        locale={locale}
      />
    </div>
  );
}

async function fetchGeoJson(url: string, fallbackUrl?: string): Promise<FeatureCollection | null> {
  try {
    let response = await fetch(url);
    if (!response.ok && fallbackUrl) {
      response = await fetch(fallbackUrl);
    }
    if (!response.ok) return null;
    return (await response.json()) as FeatureCollection;
  } catch {
    if (fallbackUrl) {
      try {
        const response = await fetch(fallbackUrl);
        if (response.ok) return (await response.json()) as FeatureCollection;
      } catch {
        return null;
      }
    }
    return null;
  }
}
