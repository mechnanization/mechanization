import type mapboxgl from 'mapbox-gl';

/*
  The fullscreen map's sources, layers and the sector opacity rules (GOD-23).

  Moved out of `fullscreen-map.tsx` as they were: the ids the layers are added
  and looked up by, the lift that keeps a dot clear of the parcel number behind
  it, and the fill and line strength of a drawn sector. The colours they use are
  in `map-palette.ts`.
*/

export const SOURCE = {
  cadastre: 'cadastre-source',
  parcels: 'parcels-source',
  zones: 'zones-source',
  registered: 'registered-source',
  measure: 'measure-source',
} as const;

export const LAYER = {
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
export const DOT_LIFT: mapboxgl.ExpressionSpecification = [
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
export const ZONE_FILL_OPACITY = 0.25;
export const ZONE_LINE_OPACITY = 0.9;

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

export function applyZoneOpacity(map: mapboxgl.Map, activeZoneId: string | null | undefined): void {
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
