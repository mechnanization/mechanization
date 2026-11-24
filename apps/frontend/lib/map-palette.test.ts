import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DOT,
  HALO_ON_DARK,
  HUE,
  MEASURE,
  MODE_DOT,
  PAYMENT_STATUS_COLOR,
  PROPERTY_USAGE_COLOR,
  boundaryFill,
  boundaryLine,
  labelHalo,
  labelText,
} from '@/components/admin/map/map-palette';
import { DOT_LIFT, LAYER, SOURCE, ZONE_FILL_OPACITY, ZONE_LINE_OPACITY, applyZoneOpacity } from '@/components/admin/map/map-layers';
import { buildingLegend } from '@/components/admin/building-map-layer';

/*
  GOD-23 and UX-04 (cleanup sprint, 2026-11-24): the fullscreen map's layer
  definitions leave `fullscreen-map.tsx`, and every colour the maps draw with is
  named once, in `map/map-palette.ts`. The point of the move is that nothing
  changed on the map, so the values the screens had are written out below and
  pinned; the sources are read to fail when a literal comes back.
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');

/** The code of a file: a comment may quote a colour. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

const MAP_FILES = [
  'components/admin/fullscreen-map.tsx',
  'components/admin/building-map-layer.ts',
  'components/admin/zone-editor-map.tsx',
  'components/admin/parcel-pin-picker.tsx',
  'components/admin/map-export-dialog.tsx',
  'components/admin/map/map-layers.ts',
];

describe('the palette names every hue once (UX-04)', () => {
  it('each is a six-digit lower-case hex, and no two names hold one colour', () => {
    const values = Object.values(HUE);
    for (const value of values) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it('the colouring modes paint what they painted before', () => {
    expect(PAYMENT_STATUS_COLOR).toEqual({
      focused: '#3b82f6',
      PAID: '#10b981',
      PARTIALLY_PAID: '#f59e0b',
      UNPAID: '#ef4444',
      none: '#94a3b8',
    });
    expect(PROPERTY_USAGE_COLOR).toEqual({
      focused: '#f59e0b',
      RESIDENTIAL: '#3b82f6',
      COMMERCIAL: '#8b5cf6',
      INDUSTRIAL: '#f97316',
      other: '#64748b',
    });
  });

  it('the registered dots, the measuring tool and the toolbar dots', () => {
    expect(DOT).toEqual({ fill: '#2563eb', fillDark: '#60a5fa', stroke: '#ffffff', focus: '#f59e0b', focusDark: '#fbbf24' });
    expect(MEASURE).toEqual({ fill: '#3b82f6', line: '#2563eb', point: '#ffffff', pointStroke: '#2563eb' });
    expect(MODE_DOT).toEqual({ default: '#2563eb', paymentStatus: '#10b981', propertyType: '#8b5cf6' });
  });

  it('the label, halo and boundary colours, light and dark', () => {
    expect([labelText(false), labelText(true)]).toEqual(['#0f172a', '#ffffff']);
    expect([labelHalo(false), labelHalo(true)]).toEqual(['#ffffff', 'rgba(0,0,0,0.85)']);
    expect(HALO_ON_DARK).toBe('rgba(0,0,0,0.85)');
    expect([boundaryLine(false), boundaryLine(true)]).toEqual(['#0f766e', '#7dd3fc']);
    expect([boundaryFill(false), boundaryFill(true)]).toEqual(['#0f766e', '#38bdf8']);
  });

  it('the building map’s survey and damage colours', () => {
    const legend = buildingLegend({ surveyStatus: {}, damageLevel: {} });
    const survey = Object.fromEntries(legend.survey.map((row) => [row.key, row.color]));
    const damage = Object.fromEntries(legend.damage.map((row) => [row.key, row.color]));
    expect(survey).toMatchObject({
      NOT_SURVEYED: '#94a3b8',
      VISITED_NO_ANSWER: '#f59e0b',
      REFUSED: '#ef4444',
      INACCESSIBLE: '#a855f7',
      PARTIAL: '#eab308',
      COMPLETE: '#10b981',
      VACANT_CONFIRMED: '#0ea5e9',
      DEMOLISHED: '#78716c',
    });
    expect(damage).toMatchObject({
      NOT_AFFECTED: '#22c55e',
      SAFE_MINOR_DAMAGE: '#84cc16',
      RESTRICTED_USE: '#f59e0b',
      UNSAFE_EVACUATE: '#ef4444',
      TOTAL_COLLAPSE: '#7f1d1d',
      UNCLASSIFIED: '#64748b',
    });
  });

  it.each(MAP_FILES)('%s names no colour of its own', (path) => {
    const code = withoutComments(read(path));
    expect(code.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
  });

  it('the fullscreen map’s legend uses no Tailwind palette step', () => {
    const code = withoutComments(read('components/admin/fullscreen-map.tsx'));
    expect(code).not.toMatch(
      /\b(?:bg|text|border|ring)-(?:slate|gray|zinc|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}/,
    );
  });

  it('the legend and the map’s expressions read the same roles, so they cannot drift', () => {
    const code = withoutComments(read('components/admin/fullscreen-map.tsx'));
    for (const role of [
      'PAYMENT_STATUS_COLOR.PAID',
      'PAYMENT_STATUS_COLOR.PARTIALLY_PAID',
      'PAYMENT_STATUS_COLOR.UNPAID',
      'PAYMENT_STATUS_COLOR.none',
      'PROPERTY_USAGE_COLOR.RESIDENTIAL',
      'PROPERTY_USAGE_COLOR.COMMERCIAL',
      'PROPERTY_USAGE_COLOR.INDUSTRIAL',
      'PROPERTY_USAGE_COLOR.other',
    ]) {
      // once in the expression, once in the legend
      expect(code.split(role).length - 1, role).toBeGreaterThanOrEqual(2);
    }
    expect(code).toMatch(/backgroundColor: PAYMENT_STATUS_COLOR\.UNPAID/);
  });
});

describe('the layer definitions left fullscreen-map.tsx as they were (GOD-23)', () => {
  it('it declares none of them any more', () => {
    const code = withoutComments(read('components/admin/fullscreen-map.tsx'));
    for (const name of ['SOURCE', 'LAYER', 'DOT_LIFT', 'DOT', 'ZONE_FILL_OPACITY', 'ZONE_LINE_OPACITY']) {
      expect(code, name).not.toMatch(new RegExp(`\\bconst ${name}\\b`));
    }
    expect(code).not.toMatch(/\bfunction (?:applyZoneOpacity|zoneOpacity)\(/);
  });

  it('the ids the layers are added and found by', () => {
    expect(SOURCE).toEqual({
      cadastre: 'cadastre-source',
      parcels: 'parcels-source',
      zones: 'zones-source',
      registered: 'registered-source',
      measure: 'measure-source',
    });
    expect(LAYER.registeredDots).toBe('registered-dots');
    expect(Object.keys(LAYER)).toHaveLength(11);
  });

  it('the dot lift and the sector strengths', () => {
    expect(DOT_LIFT).toEqual([
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
    ]);
    expect([ZONE_FILL_OPACITY, ZONE_LINE_OPACITY]).toEqual([0.25, 0.9]);
  });

  it('every sector shows at full strength with none picked, and only the picked one with one', () => {
    const map = { getLayer: vi.fn(() => ({})), setPaintProperty: vi.fn() };
    applyZoneOpacity(map as never, null);
    expect(map.setPaintProperty.mock.calls).toEqual([
      [LAYER.zoneFills, 'fill-opacity', 0.25],
      [LAYER.zoneLines, 'line-opacity', 0.9],
      [LAYER.zoneLabels, 'text-opacity', 1],
    ]);

    map.setPaintProperty.mockClear();
    applyZoneOpacity(map as never, 'zone-1');
    expect(map.setPaintProperty.mock.calls[0]).toEqual([
      LAYER.zoneFills,
      'fill-opacity',
      ['case', ['==', ['get', 'zoneId'], 'zone-1'], 0.25, 0],
    ]);
  });

  it('leaves a layer that is not on the map alone', () => {
    const map = { getLayer: vi.fn(() => undefined), setPaintProperty: vi.fn() };
    applyZoneOpacity(map as never, 'zone-1');
    expect(map.setPaintProperty).not.toHaveBeenCalled();
  });
});
