import type mapboxgl from 'mapbox-gl';
import type { FeatureCollection, Feature, Point } from 'geojson';
import type { BuildingMapPin } from '@/lib/api-client';

/**
 * The census as three visual channels on one dot (P3-T5).
 *
 * A map that colours a building one way answers one question. This one has to
 * answer three at once, because the three are what a dispatch decision is made
 * of — *what* is standing there, *how much of it has anyone been inside*, and
 * *whether it is safe to enter*. They are independent facts and a single hue
 * cannot carry them, so each gets its own channel:
 *
 *   - **icon** — the structure type. A shape, read pre-attentively, and it does
 *     not change as work progresses.
 *   - **fill** — the survey rollup, i.e. the *worst* status among the units
 *     (D11). This is the channel that moves as a town gets surveyed.
 *   - **ring** — the current damage level, drawn only when there is one. An
 *     absent ring means "never assessed", which is a different statement from
 *     `NOT_AFFECTED` and must not look like it.
 *
 * Kept in its own module rather than inside `fullscreen-map.tsx` for the plain
 * reason that the file is already 1,900 lines and this is a self-contained
 * layer: the expressions, the icon sprites and the parcel rollup are all pure
 * functions of the pins, and none of them touch the map's own state.
 */

export const BUILDING_SOURCE = {
  polygons: 'parcel-polygons-source',
  buildings: 'buildings-source',
  parcelRollup: 'building-parcel-rollup-source',
} as const;

export const BUILDING_LAYER = {
  polygonFill: 'parcel-polygon-fill',
  polygonLine: 'parcel-polygon-line',
  ring: 'building-damage-ring',
  fill: 'building-survey-fill',
  icon: 'building-structure-icon',
  parcelDot: 'building-parcel-dot',
  parcelCount: 'building-parcel-count',
} as const;

/**
 * Below this the town is a scatter of parcels, above it a stairwell of
 * buildings.
 *
 * 16.5 rather than a round number because it is the zoom at which two entrances
 * on one parcel stop overlapping at this cadastre's typical plot size — under
 * that they draw on top of each other and "three buildings" reads as one badly
 * rendered dot, which is worse than the honest parcel aggregate.
 */
export const BUILDING_ZOOM = 16.5;

/**
 * The survey ladder as colour, worst-first — the same ordering `rollupOf` uses
 * server-side, and the same judgement: `NOT_SURVEYED` is the state an officer
 * is dispatched against, so it is the one that has to be visible across a town
 * at a glance.
 */
const SURVEY_COLORS: Record<string, string> = {
  NOT_SURVEYED: '#94a3b8',
  VISITED_NO_ANSWER: '#f59e0b',
  REFUSED: '#ef4444',
  INACCESSIBLE: '#a855f7',
  PARTIAL: '#eab308',
  COMPLETE: '#10b981',
  VACANT_CONFIRMED: '#0ea5e9',
  DEMOLISHED: '#78716c',
};

/**
 * UN-Habitat's five levels as a ring.
 *
 * `NOT_AFFECTED` and `SAFE_MINOR_DAMAGE` are deliberately *not* green-and-quiet
 * — they are assessments, and an assessed building should be distinguishable
 * from an unassessed one, which draws no ring at all. `UNCLASSIFIED` gets a
 * grey ring for the same reason: somebody looked and could not classify it,
 * which is a finding.
 */
const DAMAGE_COLORS: Record<string, string> = {
  NOT_AFFECTED: '#22c55e',
  SAFE_MINOR_DAMAGE: '#84cc16',
  RESTRICTED_USE: '#f59e0b',
  UNSAFE_EVACUATE: '#ef4444',
  TOTAL_COLLAPSE: '#7f1d1d',
  UNCLASSIFIED: '#64748b',
};

/** The severity ladder, worst first — mirrors `SURVEY_SEVERITY` on the server. */
const SURVEY_SEVERITY: readonly string[] = [
  'NOT_SURVEYED',
  'VISITED_NO_ANSWER',
  'REFUSED',
  'INACCESSIBLE',
  'PARTIAL',
  'COMPLETE',
  'VACANT_CONFIRMED',
  'DEMOLISHED',
];

/** Mirrors `damageSeverity` on the server — worst first. */
const DAMAGE_SEVERITY: readonly string[] = [
  'TOTAL_COLLAPSE',
  'UNSAFE_EVACUATE',
  'RESTRICTED_USE',
  'SAFE_MINOR_DAMAGE',
  'NOT_AFFECTED',
  'UNCLASSIFIED',
];

function worstOf(ladder: readonly string[], values: readonly string[]): string | null {
  let best: string | null = null;
  let bestIndex = Number.MAX_SAFE_INTEGER;
  for (const value of values) {
    const index = ladder.indexOf(value);
    // An unrecognised label sorts last rather than throwing — a status added to
    // the enum and not to the ladder must not take the map down.
    const rank = index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index;
    if (rank < bestIndex) {
      bestIndex = rank;
      best = value;
    }
  }
  return best;
}

/** Builds a `match` expression from a lookup table, with a stated fallback. */
function matchColor(table: Record<string, string>, fallback: string): mapboxgl.ExpressionSpecification {
  return [
    'match',
    ['get', 'key'],
    ...Object.entries(table).flatMap(([key, color]) => [key, color]),
    fallback,
  ] as unknown as mapboxgl.ExpressionSpecification;
}

export const surveyFillExpression = (): mapboxgl.ExpressionSpecification =>
  [
    'match',
    ['get', 'surveyRollup'],
    ...Object.entries(SURVEY_COLORS).flatMap(([key, color]) => [key, color]),
    '#94a3b8',
  ] as unknown as mapboxgl.ExpressionSpecification;

export const damageRingExpression = (): mapboxgl.ExpressionSpecification =>
  [
    'match',
    ['get', 'damageLevel'],
    ...Object.entries(DAMAGE_COLORS).flatMap(([key, color]) => [key, color]),
    // No assessment on file. Transparent rather than a neutral grey: an absent
    // ring is the honest rendering of "nobody has looked", and a grey one would
    // be indistinguishable from `UNCLASSIFIED`, which means somebody did.
    'rgba(0,0,0,0)',
  ] as unknown as mapboxgl.ExpressionSpecification;

/** The legend the three channels need, in the order they are read. */
export function buildingLegend(
  labels: { surveyStatus: Record<string, string>; damageLevel: Record<string, string> },
): {
  survey: Array<{ key: string; color: string; label: string }>;
  damage: Array<{ key: string; color: string; label: string }>;
} {
  return {
    survey: SURVEY_SEVERITY.map((key) => ({
      key,
      color: SURVEY_COLORS[key] ?? '#94a3b8',
      label: labels.surveyStatus[key] ?? key,
    })),
    damage: DAMAGE_SEVERITY.map((key) => ({
      key,
      color: DAMAGE_COLORS[key] ?? '#64748b',
      label: labels.damageLevel[key] ?? key,
    })),
  };
}

/**
 * The lifecycle as a fourth, quieter channel.
 *
 * Not a colour of its own — the dot already carries three, and a fourth hue
 * would compete with the one that means "send an officer here". A structure
 * that cannot hold households is drawn faint and hollow instead: present on the
 * map, legible as a thing standing on the parcel, and visibly not work.
 *
 * `IN_USE` and `DERELICT` render at full strength, matching
 * `OCCUPIABLE_LIFECYCLE` on the server. Change one and change the other, or the
 * map will fade a building the ledger is still counting.
 */
const MUTED_LIFECYCLE: readonly string[] = [
  'PERMITTED',
  'UNDER_CONSTRUCTION',
  'WAR_DAMAGED_UNINHABITED',
  'DEMOLISHED',
  'NOT_REALISED',
];

/** Full strength for a structure with doors; faint for one without. */
export const lifecycleOpacityExpression = (): mapboxgl.ExpressionSpecification =>
  [
    'case',
    ['in', ['get', 'lifecycleStatus'], ['literal', [...MUTED_LIFECYCLE]]],
    0.35,
    1,
  ] as unknown as mapboxgl.ExpressionSpecification;

/** One feature per building, carrying all three channels' inputs. */
export function buildingsGeoJson(pins: readonly BuildingMapPin[]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: pins.map(
      (pin): Feature<Point> => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [pin.longitude, pin.latitude] },
        properties: {
          id: pin.id,
          code: pin.code,
          name: pin.name ?? '',
          parcelNumber: pin.parcelNumber,
          structureType: pin.structureType,
          lifecycleStatus: pin.lifecycleStatus,
          /*
            `''` for a structure nobody can be inside.

            The server withholds the rollup for those (its units really are
            `NOT_SURVEYED`, and that colour means "send somebody"), and an
            explicit empty string falls through the `match` to the neutral
            fallback the same way an unrecognised status would.
          */
          surveyRollup: pin.surveyRollup ?? '',
          // `''` rather than null: a Mapbox `match` on a null property falls
          // through to the fallback anyway, but an explicit empty string is
          // what the expression above is written against and keeps the two
          // readable side by side.
          damageLevel: pin.worstDamageLevel ?? '',
          unitsTotal: pin.unitsTotal,
          unitsSurveyed: pin.unitsSurveyed,
        },
      }),
    ),
  };
}

/**
 * One feature per *parcel*, for the zoom range where individual entrances
 * overlap.
 *
 * The aggregate takes the **worst** status and the **worst** damage across the
 * parcel's buildings, for exactly the reason D11 gives one floor up: a parcel
 * with one unsurveyed block and two finished ones is a parcel somebody has to
 * go back to, and averaging or majority-voting it would paint it as done.
 */
export function parcelRollupGeoJson(pins: readonly BuildingMapPin[]): FeatureCollection {
  const byParcel = new Map<string, BuildingMapPin[]>();
  for (const pin of pins) {
    byParcel.set(pin.parcelNumber, [...(byParcel.get(pin.parcelNumber) ?? []), pin]);
  }

  return {
    type: 'FeatureCollection',
    features: [...byParcel.entries()].map(([parcelNumber, group]): Feature<Point> => {
      const longitude = group.reduce((sum, pin) => sum + pin.longitude, 0) / group.length;
      const latitude = group.reduce((sum, pin) => sum + pin.latitude, 0) / group.length;

      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: {
          parcelNumber,
          buildings: group.length,
          // Only shown past one: a "1" on every single-building parcel is
          // noise on a town-wide view, and the dot itself already says one.
          label: group.length > 1 ? String(group.length) : '',
          /*
            Aggregated over the structures that *have* a rollup only.

            A parcel holding one finished block and one building site is a
            parcel with no outstanding work, and folding the site's absent
            status in as `NOT_SURVEYED` would paint it as somewhere to send an
            officer. Where every structure on the parcel is a site, the group
            has nothing to say and falls through to the neutral fallback.
          */
          surveyRollup:
            worstOf(
              SURVEY_SEVERITY,
              group
                .map((pin) => pin.surveyRollup)
                .filter((status): status is NonNullable<typeof status> => Boolean(status)),
            ) ?? '',
          damageLevel:
            worstOf(
              DAMAGE_SEVERITY,
              group
                .map((pin) => pin.worstDamageLevel)
                .filter((level): level is NonNullable<typeof level> => Boolean(level)),
            ) ?? '',
        },
      };
    }),
  };
}

/**
 * Six structure icons, drawn once into the map's sprite.
 *
 * Canvas rather than `text-field` glyphs, and that is not a stylistic
 * preference: `icon-image` needs an image, and the alternative — a symbol layer
 * whose text is a box-drawing character — depends on the glyph existing in
 * Mapbox's hosted font. Where it does not, the layer renders *nothing at all*,
 * silently, which is the failure mode a purely visual channel can least afford.
 * A canvas is drawn by the same browser that will display it.
 *
 * White on transparent, sized for the dot they sit on: the colour underneath is
 * the survey channel, so the icon must not compete with it.
 */
export function ensureStructureIcons(map: mapboxgl.Map): void {
  const size = 24;

  const draw = (paint: (ctx: CanvasRenderingContext2D) => void): ImageData | null => {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    paint(ctx);
    return ctx.getImageData(0, 0, size, size);
  };

  const icons: Record<string, (ctx: CanvasRenderingContext2D) => void> = {
    // A tall block with windows.
    RESIDENTIAL_BUILDING: (ctx) => {
      ctx.strokeRect(7, 5, 10, 15);
      ctx.fillRect(9.5, 8, 2, 2);
      ctx.fillRect(13, 8, 2, 2);
      ctx.fillRect(9.5, 12.5, 2, 2);
      ctx.fillRect(13, 12.5, 2, 2);
    },
    // A pitched roof over a single storey.
    INDEPENDENT_HOUSE: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(4, 12);
      ctx.lineTo(12, 5);
      ctx.lineTo(20, 12);
      ctx.stroke();
      ctx.strokeRect(7, 12, 10, 8);
    },
    // A shopfront: awning over an opening.
    COMMERCIAL_CENTER: (ctx) => {
      ctx.strokeRect(5, 9, 14, 11);
      ctx.beginPath();
      ctx.moveTo(4, 9);
      ctx.lineTo(20, 9);
      ctx.moveTo(4, 6);
      ctx.lineTo(20, 6);
      ctx.stroke();
      ctx.fillRect(10, 13, 4, 7);
    },
    // A wide, low hangar with a curved roof.
    WAREHOUSE_HANGAR: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(4, 19);
      ctx.lineTo(4, 12);
      ctx.quadraticCurveTo(12, 5, 20, 12);
      ctx.lineTo(20, 19);
      ctx.closePath();
      ctx.stroke();
    },
    // A block split down the middle — dwellings one side, trade the other.
    MIXED_USE: (ctx) => {
      ctx.strokeRect(5, 6, 14, 14);
      ctx.beginPath();
      ctx.moveTo(12, 6);
      ctx.lineTo(12, 20);
      ctx.stroke();
      ctx.fillRect(7.5, 9, 2, 2);
      ctx.fillRect(14.5, 14, 2, 4);
    },
    // A tent.
    TENT_SHELTER: (ctx) => {
      ctx.beginPath();
      ctx.moveTo(12, 5);
      ctx.lineTo(21, 20);
      ctx.lineTo(3, 20);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(12, 11);
      ctx.lineTo(12, 20);
      ctx.stroke();
    },
  };

  for (const [type, paint] of Object.entries(icons)) {
    const id = `structure-${type}`;
    if (map.hasImage(id)) continue;
    const image = draw(paint);
    if (image) map.addImage(id, image, { pixelRatio: 2 });
  }
}

/** `icon-image` for a feature, matching the sprite names above. */
export const structureIconExpression = (): mapboxgl.ExpressionSpecification =>
  [
    'concat',
    'structure-',
    ['coalesce', ['get', 'structureType'], 'RESIDENTIAL_BUILDING'],
  ] as unknown as mapboxgl.ExpressionSpecification;

/** Exported for the legend swatches, which have to match the fill exactly. */
export { SURVEY_COLORS, DAMAGE_COLORS, matchColor };
