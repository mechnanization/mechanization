/*
  The colours the maps draw with, in one place (UX-04).

  A Mapbox paint property takes a colour *string*, never a CSS variable, so a
  map's colours are literals however they are named; they cannot be
  `hsl(var(--primary))`. They were spread over five files — thirty-six in
  `fullscreen-map.tsx` alone — and the legend beside the map was drawn in
  Tailwind classes that agreed with it only by luck: the legend's unpaid dot was
  rose where the map paints red, its commercial dot purple where the map paints
  violet, its «other» dot slate-400 where the map paints slate-500.

  So: every hue is named once, by the Tailwind palette step it is (`HUE`), and
  the roles below say what each paints. The legend reads the same roles the map's
  expressions do, so they cannot drift apart again. Nothing else in the maps
  names a colour; `lib/map-palette.test.ts` fails when one does.

  This file has no imports, so the layers, the legend and the print sheet can all
  take it.
*/

/** Every hue the maps use, once. The key is the palette step; the value is what Mapbox is given. */
export const HUE = {
  white: '#ffffff',
  slate300: '#cbd5e1',
  slate400: '#94a3b8',
  slate500: '#64748b',
  slate600: '#475569',
  slate900: '#0f172a',
  stone500: '#78716c',
  red500: '#ef4444',
  red900: '#7f1d1d',
  orange500: '#f97316',
  amber400: '#fbbf24',
  amber500: '#f59e0b',
  yellow500: '#eab308',
  lime500: '#84cc16',
  green500: '#22c55e',
  emerald500: '#10b981',
  teal700: '#0f766e',
  sky300: '#7dd3fc',
  sky400: '#38bdf8',
  sky500: '#0ea5e9',
  sky700: '#0369a1',
  blue400: '#60a5fa',
  blue500: '#3b82f6',
  blue600: '#2563eb',
  violet400: '#a78bfa',
  violet500: '#8b5cf6',
  purple500: '#a855f7',
} as const;

/** The dark halo behind a label on the dark basemap: black at 85%, which no palette step is. */
export const HALO_ON_DARK = 'rgba(0,0,0,0.85)';

/** A label's text on the light or the dark basemap. */
export const labelText = (dark: boolean): string => (dark ? HUE.white : HUE.slate900);

/** The halo that keeps a label legible over the parcels beneath it. */
export const labelHalo = (dark: boolean): string => (dark ? HALO_ON_DARK : HUE.white);

/** The cadastre's and a building outline's line: teal on light, sky on dark. */
export const boundaryLine = (dark: boolean): string => (dark ? HUE.sky300 : HUE.teal700);

/** The wash inside a building outline. */
export const boundaryFill = (dark: boolean): string => (dark ? HUE.sky400 : HUE.teal700);

/** The registered-parcel dots, and the colour of the one the map was asked to focus. */
export const DOT = {
  fill: HUE.blue600,
  fillDark: HUE.blue400,
  stroke: HUE.white,
  focus: HUE.amber500,
  focusDark: HUE.amber400,
} as const;

/** The measuring tool's polygon, line and vertices. */
export const MEASURE = {
  fill: HUE.blue500,
  line: HUE.blue600,
  point: HUE.white,
  pointStroke: HUE.blue600,
} as const;

/**
 * «حسب تسديد الرسوم»: a parcel by what its registrants owe. `focused` is the one
 * the map was asked to point at, `none` a parcel with no bills.
 */
export const PAYMENT_STATUS_COLOR = {
  focused: HUE.blue500,
  PAID: HUE.emerald500,
  PARTIALLY_PAID: HUE.amber500,
  UNPAID: HUE.red500,
  none: HUE.slate400,
} as const;

/** «حسب نوع الإشغال»: a parcel by its main use. `other` is anything not in the three. */
export const PROPERTY_USAGE_COLOR = {
  focused: HUE.amber500,
  RESIDENTIAL: HUE.blue500,
  COMMERCIAL: HUE.violet500,
  INDUSTRIAL: HUE.orange500,
  other: HUE.slate500,
} as const;

/** The dot beside each colouring mode in the toolbar's menu: the mode's own first colour. */
export const MODE_DOT = {
  default: DOT.fill,
  paymentStatus: PAYMENT_STATUS_COLOR.PAID,
  propertyType: PROPERTY_USAGE_COLOR.COMMERCIAL,
} as const;
