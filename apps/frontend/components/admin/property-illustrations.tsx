'use client';

import { buildingWidth, isStructuralUnitType, layoutFloorSpans, type UnitSpan } from '@mechanization/shared-schemas';
import type { BuildingDetail, UnitWithOccupants } from '@/lib/api-client';
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * Pictures of what a citizen holds — a building drawn from its own census, a
 * house, a plot, a tent. Decoration with a job: the reader of «عقارات المواطن»
 * should see at a glance that this is the third floor of a six-storey block,
 * or a quarter of a plot, before reading a single label.
 *
 * Every drawing takes its colour from `tone` — green for what the citizen
 * owns, blue for what they rent or occupy — the same pair the rest of the page
 * uses for the two roles.
 */
export type PropertyTone = 'owner' | 'occupant';

const TONE_TEXT: Record<PropertyTone, string> = {
  owner: 'text-success',
  occupant: 'text-info',
};
/**
 * How a lit unit — the citizen's own, or the one picked — stands out: an
 * outline and a glow in the role's colour, over its own colours, so what the
 * unit is stays visible while it is marked.
 */
const TONE_FILL: Record<PropertyTone, string> = {
  owner: 'z-[1] ring-2 ring-success shadow-[0_0_12px] shadow-success/70',
  occupant: 'z-[1] ring-2 ring-info shadow-[0_0_12px] shadow-info/70',
};

/**
 * The building as the census records it: every unit in its column, the
 * citizen's own lit and everyone else's drawn plain, below the ground line for
 * a basement. Drawn from the units, not the register's counts — from the
 * lowest floor with a unit to the highest — so it shows what has been painted
 * on the matrix; a storey with no unit between two that have them stays as an
 * outline, so nothing above it floats.
 */
export function BuildingElevation({
  building,
  highlight,
  tone,
  selected = null,
  onSelect,
  pickAny = false,
  locale = 'ar',
}: {
  building: BuildingDetail;
  highlight: ReadonlySet<string>;
  tone: PropertyTone;
  /** The language of the drawing's spoken name (TXT-2). */
  locale?: string;
  /** The lit unit whose details are open below the drawing — marked with a ring. */
  selected?: string | null;
  /** Makes the lit units pressable: the drawing doubles as the way to pick one. */
  onSelect?: (unitId: string) => void;
  /**
   * Every unit pressable, not only the lit ones — the matrix's own drawing,
   * where any unit can be picked and the lit one is the one picked.
   */
  pickAny?: boolean;
}) {
  const unitFloors = building.units.map((unit) => unit.floor);
  /*
    As tall as what is drawn on it, not as the register's floor count: a
    three-storey matrix with units painted on the ground floor only is drawn
    as that one storey, not with two empty outlines stacked above it. A floor
    with no unit *between* two that have them is still drawn — the storey is
    there, and the floors above it do not float.
  */
  const top = Math.max(...unitFloors, 0);
  const bottom = Math.min(...unitFloors, 0);

  const floors: Array<{ floor: number; blocks: Array<UnitSpan<UnitWithOccupants>>; width: number }> = [];
  for (let floor = top; floor >= bottom; floor -= 1) {
    const units = building.units
      .filter((unit) => unit.floor === floor)
      .sort((a, b) => a.sequence - b.sequence);
    floors.push({ floor, ...layoutFloorSpans(units) });
  }
  const columns = buildingWidth(floors);

  /*
    حالة المبنى, drawn: going up, its top is open; permitted or never built,
    it is only the outline of what was planned; demolished, the outline of
    what stood, in red; war-damaged, cracked through; abandoned, boarded up.
  */
  const lifecycle = building.lifecycleStatus;
  const unfinished = lifecycle === 'UNDER_CONSTRUCTION';
  const ghost = lifecycle === 'PERMITTED' || lifecycle === 'NOT_REALISED' || lifecycle === 'DEMOLISHED';
  const damaged = lifecycle === 'WAR_DAMAGED_UNINHABITED';
  const derelict = lifecycle === 'DERELICT';
  /*
    A tall block is drawn compact — thin storeys, no windows, nothing on the
    roof — so a twenty-five-storey tower fits the frame whole rather than
    losing its top floors off the edge of it.
  */
  const dense = floors.length > 14;
  const look = structureLook(building.structureType);

  // A camp is not a building: tents on the ground, no walls, no storeys.
  if (look === 'camp') {
    return (
      <TentCamp
        building={building}
        highlight={highlight}
        tone={tone}
        locale={locale}
        selected={selected}
        onSelect={onSelect}
        pickAny={pickAny}
      />
    );
  }

  /*
    The top floor's roof, by what the structure is: a house wears a pitched
    roof, a hangar an arched one; everything else is the flat Lebanese slab
    with its tanks (or, on a commercial centre, its sign). Not while it is
    still going up — an unfinished top is its bare slab and rebar.
  */
  const topRoof: 'pitched' | 'arched' | null =
    unfinished || ghost ? null : look === 'house' ? 'pitched' : look === 'warehouse' ? 'arched' : null;
  /** What stands on the roof: nothing on an outline, a ruin, or a tower drawn compact. */
  const roofKit = !ghost && !damaged && !dense;
  const topExtent = (() => {
    const occupied = [...occupiedColumns(floors[0]?.blocks ?? [])];
    return occupied.length ? { from: Math.min(...occupied), to: Math.max(...occupied) } : null;
  })();

  return (
    /*
      Left to right whatever the page language, as the census numbers a floor:
      0001 at the left, then 0002…, and 0101, 0201 above it — the same way
      the building matrix and the creation grid draw it. Without this an Arabic
      page mirrored the building, putting each floor's first unit at the right.
    */
    <div dir="ltr" className="flex h-full w-full items-center justify-center">
      <div
        className="flex h-full w-full flex-col justify-center pt-3"
        // As wide as its floors are, not as wide as the frame: a block two flats across is
        // drawn narrow and tall, one five across wide — never stretched to fill a phone.
        style={{ maxWidth: Math.min(640, 72 + columns * 120) }}
        role={onSelect ? 'group' : 'img'}
        aria-label={
          locale === 'en'
            ? `${building.floorsCount} floors, ${building.units.length} units`
            : `${building.floorsCount} طوابق، ${building.units.length} وحدات`
        }
      >
        {topRoof && topExtent && floors[0]!.floor >= 0 ? (
          <div
            aria-hidden
            className="grid h-[16px] shrink-0"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            <span
              className={cn(
                'mx-[-5px]',
                topRoof === 'pitched' ? 'bg-foreground/45' : 'rounded-t-[999px] bg-foreground/35',
              )}
              style={{
                gridColumn: `${topExtent.from} / ${topExtent.to + 1}`,
                ...(topRoof === 'pitched'
                  ? {
                      // A tiled gable: the triangle, ruled with its courses of tiles.
                      clipPath: 'polygon(0 100%, 50% 0, 100% 100%)',
                      backgroundImage: 'repeating-linear-gradient(0deg, transparent 0 3px, hsl(var(--foreground) / 0.18) 3px 4px)',
                    }
                  : {
                      // A hangar's arch, with its ribs.
                      backgroundImage: 'repeating-linear-gradient(90deg, transparent 0 7px, hsl(var(--muted-foreground) / 0.5) 7px 8px)',
                    }),
              }}
            />
          </div>
        ) : null}
        {floors.map(({ floor, blocks }, index) => {
          /*
            The building is drawn from its units, not from its widest floor.
            A floor's wall exists only behind a unit: where a storey has no
            unit in a column there is no wall there either, so a setback, a
            gap between two wings or an L-shaped block shows its real outline
            instead of a rectangle with holes in it.
          */
          const occupied = occupiedColumns(blocks);
          const above = index > 0 ? occupiedColumns(floors[index - 1]!.blocks) : new Set<number>();
          // Not over a column floor (open ground) or a shopfront (it has its own door).
          const doorColumn =
            floor === 0
              ? doorColumnOf(
                  blocks.filter((block) => !['structure', 'premises'].includes(unitKind(block.unit.unitType))),
                  columns,
                )
              : null;
          return (
            <div key={floor} className="contents">
              {/* The street level: the pavement line, with the basements below it. */}
              {floor === -1 ? <StreetLine /> : null}
              {/*
                «سكني - تجاري»: the shops' fascia — a band between the street
                floor and the homes over it, across the shops' own width.
              */}
              {look === 'mixed' && floor === 0 && index > 0 && occupied.size > 0 ? (
                <div
                  aria-hidden
                  className="grid h-[4px] shrink-0"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  <span
                    className="bg-foreground/55"
                    style={{ gridColumn: `${Math.min(...occupied)} / ${Math.max(...occupied) + 1}` }}
                  />
                </div>
              ) : null}
              <div
                className="grid"
                style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, flex: '1 1 0', minHeight: dense ? 1 : 5, maxHeight: 44 }}
              >
                {blocks.length === 0 ? (
                  // A storey the register counts with no unit drawn on it: an outline, not a wall.
                  <span
                    className="my-[2px] rounded-[2px] border border-dashed border-foreground/15"
                    style={{ gridColumn: `1 / ${columns + 1}` }}
                  />
                ) : (
                  blocks.map(({ unit, startCol, endCol }) => {
                    const lit = highlight.has(unit.id);
                    const kind = unitKind(unit.unitType);
                    // What the front shows, which the structure decides as much as the unit does.
                    const faceKind = faceFor(kind, look);
                    const span = endCol - startCol + 1;
                    // Walls only at the building's own edges — where nothing stands beside this unit.
                    const openStart = !occupied.has(startCol - 1);
                    const openEnd = !occupied.has(endCol + 1);
                    // A roof over every stretch of this unit with nothing standing on it.
                    const roofRuns = runsWhere(startCol, endCol, (col) => !above.has(col));
                    const className = cn(
                      'relative h-full w-full overflow-hidden rounded-[2px] transition-all',
                      ghost
                        ? cn('border border-dashed bg-transparent', lifecycle === 'DEMOLISHED' ? 'border-destructive/50' : 'border-foreground/40')
                        : panelFor(unit.unitType, faceKind),
                      lit && TONE_FILL[tone],
                      (lit || pickAny) && onSelect && 'cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      unit.id === selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
                    );
                    const face =
                      ghost || dense ? null : (
                        <>
                          <ColorFace unitType={unit.unitType} kind={faceKind} columns={span} upstairs={floor > 0} />
                          {damaged ? <span aria-hidden className="pointer-events-none absolute inset-0" style={CRACKS} /> : null}
                          {derelict ? <span aria-hidden className="pointer-events-none absolute inset-0" style={BOARDS} /> : null}
                        </>
                      );
                    // Under a pitched or arched top the gable is the roof; the flat caps are for the slab.
                    const flatCaps = floor >= 0 && !ghost && kind !== 'structure' && !(index === 0 && topRoof);
                    return (
                      <div
                        key={unit.id}
                        className={cn(
                          'relative border-x border-t',
                          dense ? 'px-px py-0' : 'px-[2px] py-[2px]',
                          // An outline has no wall: only the plan of where the units were to be.
                          ghost
                            ? 'border-transparent bg-transparent'
                            : kind === 'structure'
                              ? 'border-x-transparent border-t-foreground/50 bg-transparent'
                              : floor < 0
                                ? 'border-foreground/15 bg-foreground/[0.12]'
                                : 'border-foreground/25 bg-foreground/[0.06]',
                          // The outside wall is heavier than a partition.
                          !ghost && kind !== 'structure' && openStart && 'border-s-foreground/40 ps-[3px]',
                          !ghost && kind !== 'structure' && openEnd && 'border-e-foreground/40 pe-[3px]',
                          // A derelict shell, dimmed.
                          derelict && 'opacity-75',
                          // A column floor's slab is its own top; its pillars stand on the ground.
                          !ghost && kind === 'structure' && 'border-t-0 p-0',
                        )}
                        style={{ gridColumn: `${startCol} / ${endCol + 1}` }}
                      >
                        {flatCaps
                          ? roofRuns.map((run) => (
                              <span
                                key={`roof-${run.from}`}
                                aria-hidden
                                className={cn(
                                  'pointer-events-none absolute -top-[4px] h-[4px] rounded-t-sm',
                                  unfinished ? 'border-t-2 border-dashed border-foreground/50' : 'bg-foreground/45',
                                )}
                                style={{
                                  insetInlineStart: `calc(${((run.from - startCol) / span) * 100}% - ${run.from === startCol && openStart ? 3 : 0}px)`,
                                  width: `calc(${((run.to - run.from + 1) / span) * 100}% + ${
                                    (run.from === startCol && openStart ? 3 : 0) + (run.to === endCol && openEnd ? 3 : 0)
                                  }px)`,
                                }}
                              />
                            ))
                          : null}
                        {/*
                          What a Lebanese roof carries, standing on the top
                          floor's roof rather than floating over the frame: the
                          solar panel on its first unit, the water tanks on its
                          last. Still going up, the slab has bare rebar instead.
                        */}
                        {index === 0 && floor >= 0 && roofKit && roofRuns.length > 0 ? (
                          unfinished ? (
                            <span aria-hidden className="pointer-events-none absolute inset-x-1 bottom-[calc(100%+3px)] flex h-[8px] justify-around">
                              {[0, 1, 2].map((i) => (
                                <span key={i} className="h-full w-px bg-foreground/50" />
                              ))}
                            </span>
                          ) : look === 'commercial' && unit.id === blocks[0]!.unit.id ? (
                            // A commercial centre's sign on the roof, on its two posts — not water tanks.
                            <span
                              aria-hidden
                              className="pointer-events-none absolute bottom-[calc(100%+4px)] start-1 flex w-[70%] max-w-[90px] flex-col items-center"
                            >
                              <span className="flex h-[9px] w-full items-center justify-center gap-[3px] rounded-[1px] bg-foreground/45 px-1">
                                <span className="h-[2px] flex-1 bg-background/60" />
                                <span className="h-[2px] w-1/4 bg-background/60" />
                              </span>
                              <span className="flex w-1/2 justify-between">
                                <span className="h-[3px] w-px bg-foreground/50" />
                                <span className="h-[3px] w-px bg-foreground/50" />
                              </span>
                            </span>
                          ) : (look === 'residential' || look === 'mixed') && unit.id === blocks[blocks.length - 1]!.unit.id ? (
                            <span aria-hidden className="pointer-events-none absolute bottom-[calc(100%+4px)] end-1 flex items-end gap-[3px]">
                              <span className="h-[9px] w-[10px] rounded-t-[3px] bg-foreground/40" />
                              <span className="h-[7px] w-[8px] rounded-t-[3px] bg-foreground/35" />
                            </span>
                          ) : null
                        ) : null}
                        {index === 0 && floor >= 0 && roofKit && !unfinished && (look === 'residential' || look === 'mixed') && roofRuns.length > 0 && blocks.length > 0 && unit.id === blocks[0]!.unit.id ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute bottom-[calc(100%+5px)] start-1.5 h-[5px] w-[18px] -skew-x-[25deg] border border-foreground/40 bg-foreground/20"
                          />
                        ) : null}
                        {(lit || pickAny) && onSelect ? (
                          <button
                            type="button"
                            title={unit.unitCode}
                            aria-label={unit.unitCode}
                            aria-pressed={unit.id === selected}
                            onClick={() => onSelect(unit.id)}
                            className={className}
                          >
                            {face}
                          </button>
                        ) : (
                          <span title={unit.unitCode} className={className}>
                            {face}
                          </span>
                        )}
                        {/* The way in: the stair door, on a street-floor unit — never in a gap. */}
                        {!ghost && !dense && doorColumn !== null && doorColumn >= startCol && doorColumn <= endCol ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute bottom-0 h-[70%] w-[7px] -translate-x-1/2 rounded-t-[2px] border border-b-0 border-foreground/50 bg-foreground/40"
                            style={{ insetInlineStart: `${((doorColumn - startCol + 0.5) / span) * 100}%` }}
                          />
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
        {/* The street it stands on, and the pavement, when it has no basement below. */}
        {bottom === 0 ? (
          <>
            <StreetLine />
            <div className="mx-[-14px] h-[4px] rounded-b bg-foreground/15" />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The street the building stands on, a tree at either end of it. */
function StreetLine() {
  return (
    <div className="relative mx-[-14px] h-[2px] rounded bg-foreground/55">
      <Tree className="absolute bottom-full start-[-6px]" />
      <Tree className="absolute bottom-full end-[-6px]" />
    </div>
  );
}

/** A street tree beside the building — scale, and the sense of a pavement. */
function Tree({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex flex-col items-center', className)}>
      <span className="size-[16px] rounded-full bg-foreground/20" />
      <span className="-mt-[2px] h-[10px] w-[3px] rounded-b bg-foreground/30" />
    </span>
  );
}

/** A house: tiled roof with its water tank, door and path, windows, a garden wall. */
export function HouseArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <rect x="0" y="108" width="200" height="12" className="fill-foreground/10" />
      <line x1="6" y1="108" x2="194" y2="108" className="stroke-foreground/50" strokeWidth="2" />
      {/* path to the door */}
      <path d="M93 108 L86 120 H115 L108 108 Z" className="fill-foreground/20" />
      {/* garden wall and gate posts */}
      <rect x="14" y="98" width="62" height="10" className="fill-foreground/15 stroke-foreground/30" strokeWidth="1" />
      <rect x="124" y="98" width="62" height="10" className="fill-foreground/15 stroke-foreground/30" strokeWidth="1" />
      {/* trees behind the wall */}
      <circle cx="30" cy="84" r="13" className="fill-foreground/20" />
      <rect x="28.5" y="90" width="3" height="10" className="fill-foreground/30" />
      <circle cx="172" cy="86" r="11" className="fill-foreground/20" />
      <rect x="170.5" y="91" width="3" height="9" className="fill-foreground/30" />
      {/* body */}
      <rect x="58" y="56" width="84" height="52" rx="2" className="fill-foreground/10 stroke-foreground/40" strokeWidth="1.5" />
      {/* roof, its tiles, the chimney and the water tank */}
      <rect x="118" y="24" width="8" height="18" className="fill-foreground/40" />
      <rect x="72" y="20" width="14" height="10" rx="3" className="fill-foreground/35" />
      <path d="M50 58 L100 22 L150 58 Z" fill="currentColor" fillOpacity="0.85" />
      {[34, 42, 50].map((y) => (
        <line
          key={y}
          x1={100 - (y - 22) * 1.39}
          x2={100 + (y - 22) * 1.39}
          y1={y}
          y2={y}
          className="stroke-background/40"
          strokeWidth="1"
        />
      ))}
      {/* door, with its step and handle */}
      <rect x="92" y="80" width="16" height="28" rx="1.5" fill="currentColor" fillOpacity="0.6" />
      <rect x="89" y="106" width="22" height="2" className="fill-foreground/40" />
      <circle cx="104.5" cy="95" r="1.2" className="fill-background" />
      {/* windows, with sills and a cross bar */}
      {[66, 118].map((x) => (
        <g key={x}>
          <rect x={x} y="66" width="16" height="14" rx="1.5" fill="currentColor" fillOpacity="0.9" />
          <line x1={x + 8} y1="66" x2={x + 8} y2="80" className="stroke-background" strokeWidth="1" />
          <line x1={x} y1="73" x2={x + 16} y2="73" className="stroke-background" strokeWidth="1" />
          <rect x={x - 2} y="80" width="20" height="2" className="fill-foreground/40" />
        </g>
      ))}
      {/* the air conditioner's outdoor unit */}
      <rect x="126" y="86" width="12" height="8" rx="1" className="fill-foreground/30 stroke-foreground/40" strokeWidth="0.75" />
      <circle cx="132" cy="90" r="2.4" className="fill-none stroke-foreground/50" strokeWidth="0.75" />
    </svg>
  );
}

/**
 * A plot, fenced and grassed, with the citizen's أسهم drawn as a ring: 600 of
 * the cadastre's 2400 is a quarter of it filled. No ring when no share is
 * recorded — an empty ring would claim a share of nothing.
 */
export function LandArt({
  tone,
  shares,
  landType,
}: {
  tone: PropertyTone;
  shares: number | null;
  /** «زراعي» draws crops, «صناعي» bare gravel with a works in the corner. */
  landType?: string | null;
}) {
  const industrial = landType === 'INDUSTRIAL';
  const fraction = shares != null ? Math.max(0, Math.min(1, shares / 2400)) : null;
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <defs>
        <pattern id="grass" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
          <line x1="0" y1="0" x2="0" y2="8" className="stroke-success/35" strokeWidth="2" />
        </pattern>
        <pattern id="gravel" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="2" cy="2" r="1" className="fill-foreground/25" />
        </pattern>
      </defs>
      <path d="M30 88 L70 30 L176 40 L160 100 Z" fill={industrial ? 'url(#gravel)' : 'url(#grass)'} className="stroke-foreground/50" strokeWidth="1.5" strokeDasharray="5 4" />
      {[
        [30, 88],
        [70, 30],
        [176, 40],
        [160, 100],
      ].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="3" fill="currentColor" />
      ))}
      {industrial ? (
        <g transform="translate(132 54)" className="fill-foreground/45">
          <path d="M0 26 V10 L10 16 V10 L20 16 V10 L30 16 V26 Z" />
          <rect x="22" y="-4" width="5" height="16" />
        </g>
      ) : landType === 'AGRICULTURAL' ? (
        <g className="fill-success/60">
          {[
            [60, 70],
            [80, 58],
            [128, 82],
            [146, 66],
          ].map(([x, y]) => (
            <path key={`${x}-${y}`} d={`M${x} ${y} q-6 -10 0 -16 q6 6 0 16 z`} />
          ))}
        </g>
      ) : null}
      {fraction != null ? (
        <g transform="translate(103 66)">
          <circle r={radius} className="fill-background/80 stroke-foreground/15" strokeWidth="6" />
          <circle
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={`${fraction * circumference} ${circumference}`}
            transform="rotate(-90)"
          />
          <text textAnchor="middle" dy="4" className="fill-foreground text-[11px] font-bold">
            {Math.round(fraction * 100)}%
          </text>
        </g>
      ) : null}
    </svg>
  );
}

/** A tent, pegged to the ground. */
export function TentArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <line x1="20" y1="104" x2="180" y2="104" className="stroke-foreground/50" strokeWidth="2" />
      <path d="M50 104 L100 30 L150 104 Z" fill="currentColor" fillOpacity="0.8" />
      <path d="M100 30 L88 104 L112 104 Z" className="fill-background/70" />
      <line x1="100" y1="30" x2="100" y2="22" className="stroke-foreground/60" strokeWidth="2" />
      <line x1="50" y1="104" x2="34" y2="110" className="stroke-foreground/40" strokeWidth="1.5" />
      <line x1="150" y1="104" x2="166" y2="110" className="stroke-foreground/40" strokeWidth="1.5" />
    </svg>
  );
}

/**
 * What a unit is, in the ways a drawing can tell them apart: somewhere people
 * live, a premises that opens onto the street, a store, structure, nothing.
 */
export type UnitKind = 'dwelling' | 'premises' | 'storage' | 'structure' | 'void';

export function unitKind(unitType: string | null | undefined): UnitKind {
  switch (unitType) {
    case 'SHOP':
    case 'OFFICE':
    case 'CLINIC':
      return 'premises';
    case 'WAREHOUSE':
    case 'GARAGE':
      return 'storage';
    case 'PILOTIS':
      return 'structure';
    case 'EMPTY_FLOOR':
      return 'void';
    default:
      // A structural type added later is drawn as structure, not as a home (ICO-2).
      return isStructuralUnitType(unitType as never) ? 'structure' : 'dwelling';
  }
}

/**
 * One unit on its own, drawn as what it is — the picture for a card that is a
 * single unit (a house, a shop, a garage) rather than a whole building.
 */
export function UnitArt({ unitType, tone }: { unitType: string | null | undefined; tone: PropertyTone }) {
  switch (unitType) {
    case 'SHOP':
      return <ShopArt tone={tone} />;
    case 'OFFICE':
      return <OfficeArt tone={tone} />;
    case 'CLINIC':
      return <ShopArt tone={tone} cross />;
    case 'WAREHOUSE':
      return <WarehouseArt tone={tone} />;
    case 'GARAGE':
      return <GarageArt tone={tone} />;
    case 'PILOTIS':
      return <PilotisArt tone={tone} />;
    case 'EMPTY_FLOOR':
      return <EmptyFloorArt tone={tone} />;
    case 'APARTMENT':
      return <ApartmentArt tone={tone} />;
    default:
      return <HouseArt tone={tone} />;
  }
}

function Ground() {
  return (
    <>
      <rect x="0" y="108" width="200" height="12" className="fill-foreground/10" />
      <line x1="10" y1="108" x2="190" y2="108" className="stroke-foreground/50" strokeWidth="2" />
    </>
  );
}

/** A flat: one storey of a block, its balcony and windows lit, the storeys around it dark. */
export function ApartmentArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <rect x="60" y="14" width="80" height="94" rx="2" className="fill-foreground/10 stroke-foreground/40" strokeWidth="1.5" />
      <rect x="56" y="11" width="88" height="4" rx="1" className="fill-foreground/40" />
      <rect x="68" y="3" width="11" height="8" rx="2.5" className="fill-foreground/35" />
      <rect x="82" y="5" width="9" height="6" rx="2.5" className="fill-foreground/30" />
      <path d="M112 10 l6 -5 h14 l-6 5 z" className="fill-foreground/20 stroke-foreground/35" strokeWidth="0.75" />
      <rect x="142" y="58" width="10" height="7" rx="1" className="fill-foreground/30 stroke-foreground/40" strokeWidth="0.75" />
      {[24, 50, 76].map((y) =>
        y === 50 ? (
          <g key={y}>
            <rect x="68" y={y} width="28" height="18" rx="1.5" fill="currentColor" fillOpacity="0.9" />
            <rect x="104" y={y} width="28" height="18" rx="1.5" fill="currentColor" fillOpacity="0.9" />
            <rect x="64" y={y + 18} width="72" height="4" rx="1" fill="currentColor" fillOpacity="0.6" />
          </g>
        ) : (
          <g key={y}>
            <rect x="68" y={y} width="28" height="16" rx="1.5" className="fill-foreground/20" />
            <rect x="104" y={y} width="28" height="16" rx="1.5" className="fill-foreground/20" />
          </g>
        ),
      )}
      <rect x="92" y="96" width="16" height="12" className="fill-foreground/30" />
    </svg>
  );
}

/** A shop: striped awning, shop window, door — and a cross in the window for a clinic. */
export function ShopArt({ tone, cross = false }: { tone: PropertyTone; cross?: boolean }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <rect x="40" y="34" width="120" height="74" rx="2" className="fill-foreground/10 stroke-foreground/40" strokeWidth="1.5" />
      <rect x="48" y="40" width="104" height="12" rx="1.5" className="fill-foreground/25" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <path
          key={i}
          d={`M${40 + i * 15} 56 h15 v8 a7.5 7.5 0 0 1 -15 0 z`}
          fill="currentColor"
          fillOpacity={i % 2 ? 0.45 : 0.95}
        />
      ))}
      <rect x="50" y="74" width="62" height="34" rx="1.5" fill="currentColor" fillOpacity="0.25" className="stroke-foreground/30" />
      <rect x="122" y="74" width="26" height="34" rx="1.5" fill="currentColor" fillOpacity="0.7" />
      {cross ? (
        <g transform="translate(81 91)" className="fill-background">
          <rect x="-3" y="-10" width="6" height="20" rx="1" />
          <rect x="-10" y="-3" width="20" height="6" rx="1" />
        </g>
      ) : null}
    </svg>
  );
}

/** An office: a glazed front, a grid of panes. */
export function OfficeArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <rect x="56" y="18" width="88" height="90" rx="2" fill="currentColor" fillOpacity="0.18" className="stroke-foreground/40" strokeWidth="1.5" />
      {[0, 1, 2, 3].map((row) =>
        [0, 1, 2].map((col) => (
          <rect
            key={`${row}-${col}`}
            x={64 + col * 26}
            y={26 + row * 18}
            width="20"
            height="13"
            rx="1"
            fill="currentColor"
            fillOpacity={(row + col) % 3 === 0 ? 0.9 : 0.45}
          />
        )),
      )}
      <rect x="90" y="96" width="20" height="12" fill="currentColor" fillOpacity="0.7" />
    </svg>
  );
}

/** A warehouse: a shed roof and a roller door. */
export function WarehouseArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <path d="M30 108 V54 L100 30 L170 54 V108 Z" className="fill-foreground/10 stroke-foreground/40" strokeWidth="1.5" />
      <path d="M26 56 L100 28 L174 56" fill="none" stroke="currentColor" strokeWidth="5" strokeLinejoin="round" />
      <rect x="66" y="62" width="68" height="46" rx="1.5" fill="currentColor" fillOpacity="0.35" />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => (
        <line key={i} x1="66" x2="134" y1={68 + i * 6} y2={68 + i * 6} stroke="currentColor" strokeOpacity="0.8" strokeWidth="1.5" />
      ))}
    </svg>
  );
}

/** A garage: a sectional door, half up, and the car inside. */
export function GarageArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <path d="M48 108 V48 L100 30 L152 48 V108 Z" className="fill-foreground/10 stroke-foreground/40" strokeWidth="1.5" />
      <rect x="62" y="58" width="76" height="50" rx="2" className="fill-foreground/20" />
      {[0, 1, 2].map((i) => (
        <rect key={i} x="62" y={58 + i * 8} width="76" height="7" rx="1" fill="currentColor" fillOpacity="0.75" />
      ))}
      <path d="M72 104 v-8 l8 -10 h40 l8 10 v8 z" fill="currentColor" fillOpacity="0.9" />
      <circle cx="84" cy="104" r="5" className="fill-foreground/70" />
      <circle cx="116" cy="104" r="5" className="fill-foreground/70" />
    </svg>
  );
}

/** A column floor: a slab on pillars, open underneath. */
export function PilotisArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <rect x="34" y="40" width="132" height="10" rx="1.5" fill="currentColor" fillOpacity="0.8" />
      {[44, 78, 112, 146].map((x) => (
        <rect key={x} x={x} y="50" width="10" height="58" className="fill-foreground/35" />
      ))}
    </svg>
  );
}

/** A floor with no unit on it: the slab and an empty dashed outline. */
export function EmptyFloorArt({ tone }: { tone: PropertyTone }) {
  return (
    <svg viewBox="0 0 200 120" className={cn('h-full w-full', TONE_TEXT[tone])} aria-hidden>
      <Ground />
      <rect x="40" y="46" width="120" height="62" rx="2" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="6 5" />
      <rect x="34" y="40" width="132" height="6" rx="1.5" className="fill-foreground/40" />
    </svg>
  );
}

/** The columns a floor's units stand in. */
export function occupiedColumns(blocks: ReadonlyArray<{ startCol: number; endCol: number }>): Set<number> {
  const columns = new Set<number>();
  for (const { startCol, endCol } of blocks) {
    for (let col = startCol; col <= endCol; col += 1) columns.add(col);
  }
  return columns;
}

/** The runs of columns in [from, to] where `keep` holds — a roof's stretches over a unit. */
export function runsWhere(from: number, to: number, keep: (col: number) => boolean): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (let col = from; col <= to; col += 1) {
    if (!keep(col)) continue;
    const last = runs[runs.length - 1];
    if (last && last.to === col - 1) last.to = col;
    else runs.push({ from: col, to: col });
  }
  return runs;
}

/** Where the stair door goes: the street-floor column nearest the middle that has a unit in it. */
function doorColumnOf(blocks: ReadonlyArray<{ startCol: number; endCol: number }>, columns: number): number | null {
  const occupied = [...occupiedColumns(blocks)];
  if (occupied.length === 0) return null;
  const middle = (columns + 1) / 2;
  return occupied.reduce((best, col) => (Math.abs(col - middle) < Math.abs(best - middle) ? col : best));
}

/**
 * What a structure looks like from the street, by نوع المنشأة — which decides
 * its roof and, for a centre or a hangar, what its units show to the street.
 */
export type StructureLook = 'residential' | 'mixed' | 'house' | 'commercial' | 'warehouse' | 'camp';

export function structureLook(structureType: string): StructureLook {
  switch (structureType) {
    case 'INDEPENDENT_HOUSE':
      return 'house';
    case 'COMMERCIAL_CENTER':
      return 'commercial';
    case 'WAREHOUSE_HANGAR':
      return 'warehouse';
    case 'MIXED_USE':
      return 'mixed';
    case 'TENT_SHELTER':
      return 'camp';
    default:
      return 'residential';
  }
}

/** A unit's front: its own kind, or what the structure makes of it. */
type FaceKind = UnitKind | 'glass';

function faceFor(kind: UnitKind, look: StructureLook): FaceKind {
  if (kind === 'structure' || kind === 'void') return kind;
  // A commercial centre's flats read as its glass; its shops, clinics and offices keep their own fronts.
  if (look === 'commercial' && kind === 'dwelling') return 'glass';
  // A hangar's bays are doors.
  if (look === 'warehouse') return 'storage';
  return kind;
}

/**
 * «تجمّع خيم / مأوى» — not a building: tents pitched in a row on the ground,
 * one per unit, in the order the census numbers them. The citizen's own are in
 * their colour and can be pressed, as a lit unit can on a building.
 */
function TentCamp({
  building,
  highlight,
  tone,
  selected,
  onSelect,
  pickAny = false,
  locale,
}: {
  building: BuildingDetail;
  highlight: ReadonlySet<string>;
  tone: PropertyTone;
  locale: string;
  selected: string | null;
  onSelect?: (unitId: string) => void;
  pickAny?: boolean;
}) {
  const tents = [...building.units].sort((a, b) => a.floor - b.floor || a.sequence - b.sequence);
  return (
    <div dir="ltr" className="flex h-full w-full items-center justify-center">
      <div
        className="flex w-full max-w-[260px] flex-col"
        role={onSelect ? 'group' : 'img'}
        aria-label={locale === 'en' ? `${tents.length} tents` : `${tents.length} خيم`}
      >
        <div className="flex flex-wrap items-end justify-center gap-x-1.5 gap-y-1">
          {tents.map((tent) => {
            const lit = highlight.has(tent.id);
            const art = (
              <svg viewBox="0 0 40 32" className="h-full w-full" aria-hidden>
                <path d="M2 31 L20 4 L38 31 Z" className={lit ? undefined : 'fill-foreground/30'} fill={lit ? 'currentColor' : undefined} />
                <path d="M20 4 L15 31 L25 31 Z" className="fill-background/60" />
                <line x1="20" y1="4" x2="20" y2="1" className="stroke-foreground/60" strokeWidth="1.5" />
              </svg>
            );
            const className = cn(
              'h-[30px] w-[38px] rounded-sm',
              lit ? TONE_TEXT[tone] : 'text-foreground',
              (lit || pickAny) && onSelect && 'cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              tent.id === selected && 'ring-2 ring-foreground ring-offset-1 ring-offset-background',
            );
            return (lit || pickAny) && onSelect ? (
              <button
                key={tent.id}
                type="button"
                title={tent.unitCode}
                aria-label={tent.unitCode}
                aria-pressed={tent.id === selected}
                onClick={() => onSelect(tent.id)}
                className={className}
              >
                {art}
              </button>
            ) : (
              <span key={tent.id} title={tent.unitCode} className={className}>
                {art}
              </span>
            );
          })}
        </div>
        <div className="mt-[2px] h-[2px] rounded bg-foreground/55" />
        <div className="h-[4px] rounded-b bg-foreground/15" />
      </div>
    </div>
  );
}

/** «متضررة من الحرب» — cracks run through every unit of the building. */
const CRACKS: CSSProperties = {
  backgroundImage: [
    'linear-gradient(115deg, transparent 45%, hsl(var(--foreground) / 0.55) 46%, hsl(var(--foreground) / 0.55) 47.5%, transparent 48.5%)',
    'linear-gradient(62deg, transparent 58%, hsl(var(--foreground) / 0.45) 59%, hsl(var(--foreground) / 0.45) 60%, transparent 61%)',
    'linear-gradient(160deg, transparent 20%, hsl(var(--foreground) / 0.35) 21%, transparent 22.5%)',
  ].join(', '),
};

/** «قائم ومهجور» — its windows boarded over. */
const BOARDS: CSSProperties = {
  backgroundImage: 'repeating-linear-gradient(-28deg, transparent 0 6px, hsl(var(--muted-foreground) / 0.5) 6px 8px)',
};

/**
 * A unit's front panel, by its type — the wall colour behind its face. Real
 * materials rather than greys: stone for a flat, cream for a house, a shop's
 * pale fascia, a clinic's white, an office's grey-blue, a warehouse's metal.
 * Each pair is its light and dark rendering.
 */
const PANEL: Record<string, string> = {
  APARTMENT: 'bg-illustration-wall',
  INDEPENDENT_HOUSE: 'bg-illustration-wall-house',
  SHOP: 'bg-illustration-shop',
  CLINIC: 'bg-illustration-clinic',
  OFFICE: 'bg-illustration-office',
  WAREHOUSE: 'bg-illustration-warehouse',
  GARAGE: 'bg-illustration-garage',
  PILOTIS: 'bg-transparent',
  EMPTY_FLOOR: 'bg-transparent',
};
const GLASS_PANEL = 'bg-illustration-frame';

/** The panel a unit is drawn on: its type's, or what the structure makes of it. */
function panelFor(unitType: string | null, kind: FaceKind): string {
  if (kind === 'glass') return GLASS_PANEL;
  if (kind === 'storage' && unitType !== 'GARAGE') return PANEL.WAREHOUSE!;
  return PANEL[unitType ?? 'APARTMENT'] ?? PANEL.APARTMENT!;
}

/** A window: white frame, sky glass, a cross bar, a sill under it. */
function Window({ className }: { className?: string }) {
  return (
    <span className={cn('flex flex-col', className)}>
      <span className="relative flex-1 rounded-[1px] border border-card/90 bg-illustration-window">
        <span className="absolute inset-y-0 left-1/2 w-px bg-card/80" />
        <span className="absolute inset-x-0 top-1/2 h-px bg-card/60" />
      </span>
      <span className="-mx-px h-[2px] rounded-[1px] bg-illustration-concrete/70" />
    </span>
  );
}

/**
 * The front of a unit, in colour, by its own type: so a clinic is not a shop
 * nor a garage a warehouse, and each reads as what it is on the street.
 */
function ColorFace({
  unitType,
  kind,
  columns,
  upstairs,
}: {
  unitType: string | null;
  kind: FaceKind;
  columns: number;
  upstairs: boolean;
}) {
  if (kind === 'void') {
    // «طابق فارغ» — a floor with nothing on it: its outline only.
    return <span aria-hidden className="absolute inset-0 rounded-[2px] border border-dashed border-foreground/40" />;
  }
  if (kind === 'structure') {
    // «طابق أعمدة» — a concrete slab on full-height pillars, open between them.
    return (
      <span aria-hidden className="absolute inset-0 flex flex-col">
        <span className="h-[22%] min-h-[3px] shrink-0 rounded-[1px] bg-illustration-concrete" />
        <span className="flex flex-1 justify-between px-[6%]">
          {Array.from({ length: Math.min(7, columns + 1) }, (_, i) => (
            <span key={i} className="h-full w-[9%] max-w-[8px] min-w-[2px] bg-illustration-concrete" />
          ))}
        </span>
      </span>
    );
  }
  if (kind === 'glass') {
    // A centre's curtain wall: sky panes edge to edge.
    const panes = Math.min(10, columns * 3);
    return (
      <span aria-hidden className="absolute inset-[2px] grid gap-[2px]" style={{ gridTemplateColumns: `repeat(${panes}, minmax(0, 1fr))` }}>
        {Array.from({ length: panes }, (_, i) => (
          <span key={i} className="rounded-[1px] bg-illustration-window/90" />
        ))}
      </span>
    );
  }
  if (kind === 'storage' && unitType !== 'GARAGE') {
    // «مستودع» — a metal roller door, the yellow-and-black loading dock under it.
    return (
      <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-end px-[8%] pt-[14%]">
        <span
          className="w-full flex-1 rounded-t-[2px] border border-b-0 border-illustration-metal-edge bg-illustration-metal"
          style={{ backgroundImage: 'repeating-linear-gradient(0deg, hsl(var(--illustration-metal-edge) / 0.45) 0 1px, transparent 1px 4px)' }}
        />
        <span
          className="h-[4px] w-[110%] rounded-[1px]"
          style={{ backgroundImage: 'repeating-linear-gradient(45deg, hsl(var(--warning)) 0 4px, hsl(var(--foreground)) 4px 8px)' }}
        />
      </span>
    );
  }

  switch (unitType) {
    case 'GARAGE':
      // «كراج» — a wooden sectional door of wide panels.
      return (
        <span aria-hidden className="absolute inset-0 flex items-end justify-center px-[16%] pt-[20%]">
          <span className="flex h-full w-full flex-col gap-[2px] rounded-t-[2px] border border-foreground/40 bg-illustration-wood p-[2px]">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className="flex-1 rounded-[1px] bg-illustration-wood-light" />
            ))}
          </span>
        </span>
      );
    case 'SHOP':
      // «محل تجاري» — the fascia, a red-and-white awning, the display window, the door.
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col">
          <span className="h-[16%] min-h-[2px] shrink-0 bg-illustration-steel" />
          <span
            className="h-[22%] min-h-[3px] shrink-0 rounded-b-[3px]"
            style={{ backgroundImage: 'repeating-linear-gradient(90deg, hsl(var(--destructive)) 0 6px, hsl(var(--card)) 6px 12px)' }}
          />
          <span className="flex min-h-0 flex-1 gap-[3px] px-[3px] pt-[3px]">
            <span className="flex-1 rounded-t-[2px] border border-illustration-steel/60 bg-illustration-window-pale" />
            <span className="w-[20%] max-w-[12px] rounded-t-[2px] bg-illustration-steel" />
          </span>
        </span>
      );
    case 'CLINIC':
      // «عيادة» — a green sign with a white cross, a frosted window, the door.
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col">
          <span className="flex h-[24%] min-h-[4px] shrink-0 items-center justify-center bg-success">
            <span className="relative block size-[9px]">
              <span className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 bg-success-foreground" />
              <span className="absolute inset-y-0 left-1/2 w-[3px] -translate-x-1/2 bg-success-foreground" />
            </span>
          </span>
          <span className="flex min-h-0 flex-1 gap-[3px] px-[3px] pt-[3px]">
            <span className="flex-1 rounded-t-[2px] border border-illustration-frame bg-illustration-window-pale/70" />
            <span className="w-[20%] max-w-[12px] rounded-t-[2px] bg-illustration-steel/80" />
          </span>
        </span>
      );
    case 'OFFICE': {
      // «مكتب» — a nameplate over glass, its blinds half down.
      const panes = Math.min(6, columns * 2);
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col gap-[2px] p-[3px]">
          <span className="mx-auto h-[14%] min-h-[2px] w-1/3 shrink-0 rounded-[1px] bg-illustration-steel" />
          <span className="grid min-h-0 flex-1 gap-[2px]" style={{ gridTemplateColumns: `repeat(${panes}, minmax(0, 1fr))` }}>
            {Array.from({ length: panes }, (_, i) => (
              <span
                key={i}
                className="rounded-[1px] bg-illustration-window/80"
                style={{
                  backgroundImage: 'repeating-linear-gradient(0deg, transparent 0 2px, hsl(var(--card) / 0.55) 2px 3px)',
                  backgroundSize: '100% 50%',
                  backgroundRepeat: 'no-repeat',
                }}
              />
            ))}
          </span>
        </span>
      );
    }
    case 'INDEPENDENT_HOUSE':
      // «منزل مستقل» — a window either side of its wooden front door.
      return (
        <span aria-hidden className="absolute inset-0 flex items-end justify-evenly px-[6%]">
          <Window className="mb-[28%] h-[38%] w-[22%] max-w-[16px]" />
          <span className="relative h-[64%] w-[18%] max-w-[13px] rounded-t-[2px] bg-illustration-wood">
            <span className="absolute end-[20%] top-1/2 size-[2px] rounded-full bg-illustration-wood-light" />
          </span>
          <Window className="mb-[28%] h-[38%] w-[22%] max-w-[16px]" />
        </span>
      );
    default: {
      // «شقة» — framed windows; a balcony with its rail above the street.
      const windows = Math.min(8, columns * 2);
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col">
          <span className="flex flex-1 items-center justify-evenly px-[4%]">
            {Array.from({ length: windows }, (_, i) => (
              <Window key={i} className="h-[56%] w-[18%] max-w-[16px]" />
            ))}
          </span>
          {upstairs ? (
            <span
              className="mx-[3%] h-[16%] min-h-[2px] max-h-[6px] border-t-2 border-illustration-steel/80"
              style={{ backgroundImage: 'repeating-linear-gradient(90deg, hsl(var(--illustration-steel) / 0.7) 0 1px, transparent 1px 5px)' }}
            />
          ) : null}
        </span>
      );
    }
  }
}
