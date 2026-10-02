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
  /*
    Downward, the declared basements count too: B1 and B2 are dug whether or
    not a unit has been painted on them yet, and an empty one is drawn as an
    outline in the ground rather than left out.
  */
  const bottom = Math.min(...unitFloors, -(building.basementsCount ?? 0), 0);

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

  /** One storey of the elevation; a basement is drawn by the same hand, inside the ground. */
  function renderFloor(
    { floor, blocks }: { floor: number; blocks: Array<UnitSpan<UnitWithOccupants>> },
    index: number,
  ) {
          /*
            The building is drawn from its units, not from its widest floor.
            A floor's wall exists only behind a unit: where a storey has no
            unit in a column there is no wall there either, so a setback, a
            gap between two wings or an L-shaped block shows its real outline
            instead of a rectangle with holes in it.
          */
          const occupied = occupiedColumns(blocks);
          const above = index > 0 ? occupiedColumns(floors[index - 1]!.blocks) : new Set<number>();
          // Not over a shopfront (it has its own door); through a column floor it is the stair's post.
          const doorColumn =
            floor === 0
              ? doorColumnOf(
                  blocks.filter((block) => unitKind(block.unit.unitType) !== 'premises'),
                  columns,
                )
              : null;
          return (
            <div key={floor} className="contents">
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
                // `relative`: a storey paints over the ground band its basement sits in.
                className="relative grid"
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
                      // `block`: a unit that cannot be pressed is a <span>, which ignores h-full/w-full
                      // while inline — it collapsed to nothing, taking its panel and its face with it.
                      'relative block h-full w-full overflow-hidden rounded-[2px] transition-colors',
                      ghost
                        ? cn('border border-dashed bg-transparent', lifecycle === 'DEMOLISHED' ? 'border-destructive/50' : 'border-foreground/40')
                        : panelFor(faceKind, lit, tone),
                      lit && 'z-[1]',
                      (lit || pickAny) && onSelect && 'cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      // The picked unit: the selection colour (COL-2), not the role's.
                      unit.id === selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
                    );
                    const face =
                      ghost || dense ? null : (
                        <>
                          <UnitFace
                            unitType={unit.unitType}
                            kind={faceKind}
                            columns={span}
                            lit={lit}
                            tone={tone}
                            underground={floor < 0}
                          />
                          {damaged ? <span aria-hidden className="pointer-events-none absolute inset-0" style={CRACKS} /> : null}
                          {derelict ? <span aria-hidden className="pointer-events-none absolute inset-0" style={BOARDS} /> : null}
                        </>
                      );
                    // Under a pitched or arched top the gable is the roof; the flat caps are for the slab.
                    const flatCaps = floor >= 0 && !ghost && kind !== 'structure' && !(index === 0 && topRoof);
                    // Underground and walled: the basement's shading applies (B2 darker than B1).
                    const shaded = floor < 0 && !ghost && kind !== 'structure';
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
                                ? // Its own wall, solid over the earth around it; the depth shade is in `style`.
                                  'border-foreground/30 bg-background'
                                : 'border-foreground/25 bg-foreground/[0.06]',
                          // The outside wall is heavier than a partition.
                          !ghost && kind !== 'structure' && openStart && 'border-s-foreground/40 ps-[3px]',
                          !ghost && kind !== 'structure' && openEnd && 'border-e-foreground/40 pe-[3px]',
                          // A derelict shell, dimmed.
                          derelict && 'opacity-75',
                          // A column floor's slab is its own top; its pillars stand on the ground.
                          !ghost && kind === 'structure' && 'border-t-0 p-0',
                        )}
                        style={{
                          gridColumn: `${startCol} / ${endCol + 1}`,
                          ...(shaded ? { backgroundImage: BASEMENT_WALL } : null),
                        }}
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
                        {/*
                          The shade over a basement: darkest under the street
                          slab, fading toward the floor, and deeper on every
                          level down. After the unit, so a plain one dims; a lit
                          one sits above it (z-[1]) and keeps its colour.
                        */}
                        {shaded ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute inset-0"
                            style={{ backgroundImage: basementShade(floor) }}
                          />
                        ) : null}
                        {/* The way in: the stair door, on a street-floor unit — never in a gap. */}
                        {!ghost && !dense && doorColumn !== null && doorColumn >= startCol && doorColumn <= endCol ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute bottom-0 h-[60%] w-[6px] -translate-x-1/2 rounded-t-[2px] bg-foreground/45"
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
  }

  return (
    /*
      Left to right whatever the page language, as the census numbers a floor:
      0001 at the left, then 0002…, and 0101, 0201 above it — the same way
      the building matrix and the creation grid draw it. Without this an Arabic
      page mirrored the building, putting each floor's first unit at the right.
    */
    // `px-5` holds the ground line and its lamps, which run past the building either side, inside the frame.
    <div dir="ltr" className="flex h-full w-full items-center justify-center px-5">
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
        {floors.map((entry, index) => (entry.floor >= 0 ? renderFloor(entry, index) : null))}
        {/*
          Below grade: the street line, then the basements dug into the ground
          — one band of earth behind every underground storey, running past
          the building either side like the street does, with the footing
          under the lowest one. Nothing below it stands on a pavement.
        */}
        {bottom < 0 ? (
          <>
            <StreetLine />
            <div
              className="relative flex flex-col pb-[6px]"
              style={{ flex: `${-bottom} 1 0`, maxHeight: -bottom * 44 + 6 }}
            >
              {/* The shadow the street slab casts into the ground is the inset at its top. */}
              <span
                aria-hidden
                className="absolute inset-y-0 inset-x-[-16px] rounded-b-[2px] shadow-[inset_0_7px_6px_-5px_hsl(var(--illustration-shade)/0.55)]"
                style={SOIL}
              />
              {floors.map((entry, index) => (entry.floor < 0 ? renderFloor(entry, index) : null))}
            </div>
          </>
        ) : null}
        {/* The ground it stands on, when it has no basement below. */}
        {bottom === 0 ? (
          <>
            <StreetLine />
            <Forecourt
              columns={columns}
              doorColumn={
                ghost || dense
                  ? null
                  : doorColumnOf(
                      (floors.find((entry) => entry.floor === 0)?.blocks ?? []).filter(
                        (block) => unitKind(block.unit.unitType) !== 'premises',
                      ),
                      columns,
                    )
              }
              bushes={!ghost && !dense}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** The ground line the building stands on, a street lamp at either end of it. */
function StreetLine() {
  return (
    <div className="relative mx-[-16px] h-[4px] shrink-0 rounded-[1px] bg-foreground/50">
      <StreetLamp className="absolute bottom-full start-[-2px]" />
      <StreetLamp className="absolute bottom-full end-[-2px]" />
    </div>
  );
}

/**
 * The flat ground in front of the building, under its ground line: paving
 * with its joints, the path from the stair door, low bushes at the foot of
 * the façade, and the kerb at the front edge. Runs 16px past the building
 * either side, like the ground line; the inner box is the building's own
 * width, so the path sits under the door's column. Physical `left`/`right`
 * are deliberate: it is drawn inside the elevation's `dir="ltr"` (RTL-1).
 */
function Forecourt({
  columns,
  doorColumn,
  bushes,
}: {
  columns: number;
  doorColumn: number | null;
  bushes: boolean;
}) {
  return (
    <div aria-hidden className="relative mx-[-16px] h-[16px] shrink-0">
      <span
        className="absolute inset-x-0 top-0 h-[13px] bg-foreground/[0.12]"
        style={{
          backgroundImage:
            'repeating-linear-gradient(90deg, transparent 0 13px, hsl(var(--foreground) / 0.12) 13px 14px)',
        }}
      />
      {/* The kerb, and the edge of the road beyond it. */}
      <span className="absolute inset-x-0 top-[13px] h-[2px] bg-foreground/40" />
      <span className="absolute inset-x-[-4px] bottom-0 h-px bg-foreground/20" />
      <div className="absolute inset-y-0 inset-x-[16px]">
        {doorColumn !== null ? (
          <span
            className="absolute top-0 h-[13px] w-[14px] -translate-x-1/2 bg-foreground/25"
            style={{ left: `${((doorColumn - 0.5) / columns) * 100}%` }}
          />
        ) : null}
        {bushes ? (
          <>
            <Bush className="absolute -top-[7px] left-[4px]" />
            <Bush className="absolute -top-[7px] right-[4px]" />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A low bush at the foot of the wall: two rounded clumps. */
function Bush({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-end', className)}>
      <span className="h-[7px] w-[9px] rounded-t-full bg-foreground/30" />
      <span className="-ms-[3px] h-[5px] w-[7px] rounded-t-full bg-foreground/25" />
    </span>
  );
}

/** A street lamp: a round lamp on its pole. */
function StreetLamp({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('flex flex-col items-center', className)}>
      <span className="size-[13px] rounded-full bg-foreground/40" />
      <span className="h-[12px] w-[2px] bg-foreground/40" />
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

/** The earth the basements are dug into: a hatched band, the section-drawing convention for ground. */
const SOIL: CSSProperties = {
  backgroundColor: 'hsl(var(--foreground) / 0.06)',
  backgroundImage: [
    'repeating-linear-gradient(135deg, transparent 0 5px, hsl(var(--foreground) / 0.14) 5px 6px)',
    // Darker the deeper it goes.
    'linear-gradient(to bottom, hsl(var(--illustration-shade) / 0.04), hsl(var(--illustration-shade) / 0.3))',
  ].join(', '),
};

/** How dark a basement is: B1 a little, each level below more, capped so B5 still reads. */
function basementDepth(floor: number): number {
  return Math.min(-floor - 1, 4);
}

/** A basement's wall fill: the plain wall's tint; the depth is in `basementShade` over it. */
const BASEMENT_WALL = 'linear-gradient(hsl(var(--foreground) / 0.14), hsl(var(--foreground) / 0.14))';

/** The shade laid over a basement: heavy under the slab above it, lighter at its floor. */
function basementShade(floor: number): string {
  const top = 0.3 + basementDepth(floor) * 0.1;
  const bottom = 0.12 + basementDepth(floor) * 0.08;
  return `linear-gradient(to bottom, hsl(var(--illustration-shade) / ${top}), hsl(var(--illustration-shade) / ${bottom}) 70%)`;
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
 * The drawing's two inks, the same ones `HouseArt` and the single-unit arts
 * draw with: a building is grey, the citizen's own units are filled in their
 * role's colour, and every opening (window, door, shop glass) is a dark cut
 * through whichever of the two it sits on. Tokens only (COL-7): `foreground`
 * at an alpha for the plain units, `success`/`info` for the lit ones.
 */
const PLAIN_PANEL = 'bg-foreground/[0.22]';
const TONE_PANEL: Record<PropertyTone, string> = {
  owner: 'bg-success',
  occupant: 'bg-info',
};
const TONE_BORDER: Record<PropertyTone, string> = {
  owner: 'border-success',
  occupant: 'border-info',
};
/** An opening in a wall — reads on grey and on a lit unit alike. */
const OPENING = 'bg-background/75';
/** Frames, rails, slats and signs drawn over an opening or a panel. */
const TRIM = 'bg-foreground/35';

/**
 * The panel a unit is drawn on: grey, its role's colour when lit, nothing for
 * structure — with a hairline rim, so each unit reads as its own bay of the
 * façade rather than as a stripe of the floor.
 */
function panelFor(kind: FaceKind, lit: boolean, tone: PropertyTone): string {
  if (kind === 'structure' || kind === 'void') return 'bg-transparent';
  return cn('border', lit ? cn(TONE_PANEL[tone], TONE_BORDER[tone]) : cn(PLAIN_PANEL, 'border-foreground/35'));
}

/** A window: a small dark pane. */
function Window({ className }: { className?: string }) {
  return <span className={cn('rounded-[1px]', OPENING, className)} />;
}

/**
 * The front of a unit by its own type, in the drawing's two inks — so a shop
 * reads as a shop, an office as an office and a column floor as columns, on
 * the matrix as on the single-unit pictures (ICO-3). Drawn inside the
 * elevation's `dir="ltr"`, so the physical `left-1/2` here is deliberate.
 */
function UnitFace({
  unitType,
  kind,
  columns,
  lit,
  tone,
  underground = false,
}: {
  unitType: string | null;
  kind: FaceKind;
  columns: number;
  lit: boolean;
  tone: PropertyTone;
  /** A basement (B1, B2…): below the street, so it has no street front of its own. */
  underground?: boolean;
}) {
  /*
    Underground, a home, a shop or an office has no windows on the street nor
    an awning over it: only the narrow light-well slits high in the wall. A
    garage or a store keeps its door — a ramp leads down to it — and a column
    or empty floor is drawn as it is anywhere.
  */
  if (underground && (kind === 'dwelling' || kind === 'premises' || kind === 'glass')) {
    const slits = Math.min(6, columns * 2);
    return (
      <span aria-hidden className="absolute inset-x-0 top-[12%] flex h-[16%] min-h-[2px] justify-evenly px-[6%]">
        {Array.from({ length: slits }, (_, i) => (
          <span key={i} className={cn('h-full w-[14%] max-w-[14px] rounded-[1px]', OPENING)} />
        ))}
      </span>
    );
  }
  if (kind === 'void') {
    // «طابق فارغ» — a floor with nothing on it: its outline only.
    return (
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-[2px] border border-dashed',
          lit ? TONE_BORDER[tone] : 'border-foreground/40',
        )}
      />
    );
  }
  if (kind === 'structure') {
    // «طابق أعمدة» — open ground under the floor above: a colonnade of slender columns.
    const ink = lit ? TONE_PANEL[tone] : 'bg-foreground/35';
    return (
      <span aria-hidden className="absolute inset-x-0 bottom-0 top-[6%] flex justify-between px-[2%]">
        {Array.from({ length: Math.min(36, columns * 8 + 1) }, (_, i) => (
          <span key={i} className={cn('h-full w-[2px] rounded-t-[1px]', ink)} />
        ))}
      </span>
    );
  }
  if (kind === 'glass') {
    // A commercial centre's curtain wall: dark panes edge to edge.
    const panes = Math.min(10, columns * 3);
    return (
      <span
        aria-hidden
        className="absolute inset-[3px] grid gap-[2px]"
        style={{ gridTemplateColumns: `repeat(${panes}, minmax(0, 1fr))` }}
      >
        {Array.from({ length: panes }, (_, i) => (
          <span key={i} className={cn('rounded-[1px]', OPENING)} />
        ))}
      </span>
    );
  }
  if (kind === 'storage' && unitType !== 'GARAGE') {
    // «مستودع» — a roller door of horizontal slats, the loading sill under it.
    return (
      <span aria-hidden className="absolute inset-0 flex flex-col items-center justify-end px-[10%] pt-[16%]">
        <span className={cn('flex w-full flex-1 flex-col justify-evenly rounded-t-[2px] px-[2px]', OPENING)}>
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} className={cn('h-px w-full', TRIM)} />
          ))}
        </span>
        <span className={cn('h-[3px] w-[112%] rounded-[1px]', TRIM)} />
      </span>
    );
  }

  switch (unitType) {
    case 'GARAGE':
      // «كراج» — a sectional door: a strip of small lights over wide panels.
      return (
        <span aria-hidden className="absolute inset-0 flex items-end justify-center px-[14%] pt-[18%]">
          <span className={cn('flex h-full w-full flex-col gap-[2px] rounded-t-[2px] p-[2px]', OPENING)}>
            <span className="flex flex-1 gap-[2px]">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={cn('flex-1 rounded-[1px]', TRIM)} />
              ))}
            </span>
            <span className={cn('flex-1 rounded-[1px]', TRIM)} />
            <span className={cn('flex-1 rounded-[1px]', TRIM)} />
          </span>
        </span>
      );
    case 'SHOP':
    case 'CLINIC': {
      /*
        «محل تجاري» — the sign board, a scalloped awning in alternating
        stripes, the display window and the shop door. «عيادة» is the same
        front with a cross on its sign and no awning, as `ShopArt` draws it.
      */
      const clinic = unitType === 'CLINIC';
      const stripes = Math.min(12, columns * 4);
      const signInk = lit ? 'bg-foreground' : TRIM;
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col">
          <span className={cn('flex h-[18%] min-h-[3px] shrink-0 items-center justify-center', OPENING)}>
            {clinic ? (
              <span className="relative block size-[8px]">
                <span className={cn('absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2', signInk)} />
                <span className={cn('absolute inset-y-0 left-1/2 w-[2px] -translate-x-1/2', signInk)} />
              </span>
            ) : (
              <span className={cn('h-[2px] w-1/3 rounded-full', TRIM)} />
            )}
          </span>
          {clinic ? null : (
            <span className="flex h-[18%] min-h-[3px] shrink-0">
              {Array.from({ length: stripes }, (_, i) => (
                <span
                  key={i}
                  className={cn('flex-1 rounded-b-full', i % 2 === 0 ? 'bg-foreground/45' : 'bg-foreground/15')}
                />
              ))}
            </span>
          )}
          <span className="flex min-h-0 flex-1 gap-[3px] px-[4px] pt-[3px]">
            <span className={cn('relative flex-1 rounded-t-[2px]', OPENING)}>
              <span className={cn('absolute inset-x-0 bottom-[30%] h-px', TRIM)} />
            </span>
            <span className={cn('relative w-[18%] max-w-[12px] rounded-t-[2px]', OPENING)}>
              <span className={cn('absolute end-[22%] top-1/2 size-[2px] rounded-full', TRIM)} />
            </span>
          </span>
        </span>
      );
    }
    case 'OFFICE': {
      // «مكتب» — a nameplate over a band of glazing: a grid of panes, two rows.
      const panes = Math.min(6, columns * 3);
      return (
        <span aria-hidden className="absolute inset-0 flex flex-col gap-[2px] p-[3px]">
          <span className={cn('mx-auto h-[12%] min-h-[2px] w-1/3 shrink-0 rounded-[1px]', OPENING)} />
          <span
            className="grid min-h-0 flex-1 grid-rows-2 gap-[2px]"
            style={{ gridTemplateColumns: `repeat(${panes}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: panes * 2 }, (_, i) => (
              <span key={i} className={cn('rounded-[1px]', OPENING)} />
            ))}
          </span>
        </span>
      );
    }
    case 'INDEPENDENT_HOUSE':
      // «منزل مستقل» — a window either side of its front door, the door's handle.
      return (
        <span aria-hidden className="absolute inset-0 flex items-end justify-evenly px-[6%]">
          <Window className="mb-[28%] h-[38%] w-[22%] max-w-[16px]" />
          <span className={cn('relative h-[64%] w-[18%] max-w-[13px] rounded-t-[2px]', OPENING)}>
            <span className={cn('absolute end-[20%] top-1/2 size-[2px] rounded-full', TRIM)} />
          </span>
          <Window className="mb-[28%] h-[38%] w-[22%] max-w-[16px]" />
        </span>
      );
    default: {
      // «شقة» — two small windows a column, evenly spaced.
      const windows = Math.min(8, columns * 2);
      return (
        <span aria-hidden className="absolute inset-0 flex items-center justify-evenly px-[4%]">
          {Array.from({ length: windows }, (_, i) => (
            <Window key={i} className="h-[42%] w-[9%] min-w-[4px] max-w-[8px]" />
          ))}
        </span>
      );
    }
  }
}
