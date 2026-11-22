'use client';

import type { ReactNode } from 'react';
import {
  Coffee,
  Drumstick,
  Factory,
  Flag,
  Fuel,
  GraduationCap,
  Hammer,
  HeartPulse,
  Pill,
  Scissors,
  Shield,
  ShoppingCart,
  Sparkles,
  UtensilsCrossed,
  Wheat,
  Zap,
  Droplet,
  type LucideIcon,
} from 'lucide-react';
import type { UnitFigure } from '@mechanization/shared-schemas';
import { cn } from '@/lib/utils';

/*
  The drawings of the default unit types (migration 0111; the user's request of
  2026-11-21: each drawn on its own, not with the plain front of its base).

  Each is the front of one unit in the building elevation, drawn in the same two
  inks as `UnitFace` in `property-illustrations.tsx`: grey for the wall, a dark
  cut for every opening, `foreground` at an alpha for signs and trim. Tokens only
  (COL-7). Sized in percentages of the unit's box, so one drawing serves a unit
  one column wide and four. The elevation is `dir="ltr"`, so the physical
  `left-`/`right-` here are deliberate.

  `UNIT_FIGURE_ART` is a `Record<UnitFigure, …>`: a key added to the shared list
  without a drawing here does not compile.
*/

/** An opening in a wall — the same cut `UnitFace` makes. */
const OPENING = 'bg-background/75';
/** Frames, rails, slats and signs drawn over an opening or a panel. */
const TRIM = 'bg-foreground/35';

interface Look {
  /** The columns the unit spans: more of them, more windows, stripes or stalls. */
  columns: number;
  /** Painted in its role's colour: the ink stays dark on it. */
  lit: boolean;
}
type Art = (look: Look) => ReactNode;

/** A stronger ink than the trim, for what a drawing is *of*: a dome, a pump, a sign's glyph. */
const strong = (lit: boolean) => (lit ? 'bg-foreground/85' : 'bg-foreground/55');
const glyphInk = (lit: boolean) => (lit ? 'text-foreground' : 'text-foreground/75');

/**
 * The unit's box. A size container, so the drawing is laid out on a stage no
 * wider than 1.9 times its height, centred: a unit four columns wide draws the
 * same dome or pediment as one column wide, not a stretched one. Vertical
 * offsets are in `cqh` (the stage's height), never `%` — a percentage margin
 * or padding is a share of the *width*, which is what flattened them.
 */
function Box({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="absolute inset-0 flex justify-center" style={{ containerType: 'size' }}>
      <span className="relative flex h-full flex-col" style={{ width: 'min(100cqw, 190cqh)' }}>
        {children}
      </span>
    </span>
  );
}

/** The sign band along the top of a front, carrying a glyph. */
function Sign({ icon: Icon, lit }: { icon: LucideIcon; lit: boolean }) {
  return (
    <span className={cn('flex h-[26%] min-h-[6px] shrink-0 items-center justify-center', OPENING)}>
      <Icon className={cn('h-[88%] max-h-[11px] w-auto', glyphInk(lit))} strokeWidth={2.75} />
    </span>
  );
}

/** The scalloped awning of a shop front, in alternating stripes. */
function Awning({ columns }: { columns: number }) {
  return (
    <span className="flex h-[15%] min-h-[3px] shrink-0">
      {Array.from({ length: Math.min(12, columns * 4) }, (_, i) => (
        <span key={i} className={cn('flex-1 rounded-b-full', i % 2 === 0 ? 'bg-foreground/45' : 'bg-foreground/15')} />
      ))}
    </span>
  );
}

/** The ground-floor strip a front's openings stand in, bottom-aligned. */
function Openings({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('flex min-h-0 flex-1 items-end justify-evenly gap-[3px] px-[5%] pt-[3px]', className)}>
      {children}
    </span>
  );
}

function Cross({ lit, className }: { lit: boolean; className: string }) {
  return (
    <span className={cn('relative block shrink-0', className)}>
      <span className={cn('absolute inset-x-0 top-1/2 h-[34%] -translate-y-1/2', strong(lit))} />
      <span className={cn('absolute inset-y-0 left-1/2 w-[34%] -translate-x-1/2', strong(lit))} />
    </span>
  );
}

const TRIANGLE = { clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' } as const;
const SAW = { clipPath: 'polygon(0 100%, 0 0, 100% 100%)' } as const;

/** A row of columns standing under a pediment — a bank's, a hall's. */
function Colonnade({ count }: { count: number }) {
  return (
    <span className="flex min-h-0 flex-1 items-stretch justify-evenly px-[8%]">
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={cn('w-[7%] max-w-[4px]', TRIM)} />
      ))}
    </span>
  );
}

function Flagpole({ className, lit }: { className: string; lit: boolean }) {
  return (
    <span className={cn('absolute', className)}>
      <span className={cn('absolute inset-y-0 left-0 w-px', strong(lit))} />
      <span className={cn('absolute left-px top-0 h-[40%] w-[80%] rounded-r-[1px]', strong(lit))} />
    </span>
  );
}

/**
 * The drawings, one per default unit type. Where two types are the same thing in
 * the street (a bakery and its oven, a workshop and an atelier) they are still
 * two drawings: the oven shows the mouth and the chimney, the bakery its shelf.
 */
const UNIT_FIGURE_ART: Record<UnitFigure, Art> = {
  // ── Public buildings, utilities, places of worship ──────────────────────────
  SCHOOL: ({ columns, lit }) => (
    <Box>
      <Flagpole lit={lit} className="right-[9%] top-0 h-[44%] w-[22%]" />
      <Sign icon={GraduationCap} lit={lit} />
      <Openings>
        {Array.from({ length: Math.min(5, columns + 2) }, (_, i) => (
          <span key={i} className={cn('rounded-t-[1px]', OPENING, i === Math.floor(Math.min(5, columns + 2) / 2) ? 'h-[92%] w-[16%]' : 'h-[62%] w-[12%]')} />
        ))}
      </Openings>
    </Box>
  ),
  ELECTRICITY: ({ columns, lit }) => (
    <Box>
      <Sign icon={Zap} lit={lit} />
      <Openings className="gap-[4px]">
        {Array.from({ length: Math.min(4, columns + 1) }, (_, i) => (
          // A transformer cabinet: a louvred box.
          <span key={i} className={cn('flex h-[88%] w-[24%] flex-col justify-evenly rounded-[1px] px-[2px]', OPENING)}>
            <span className={cn('h-px w-full', TRIM)} />
            <span className={cn('h-px w-full', TRIM)} />
            <span className={cn('h-px w-full', TRIM)} />
          </span>
        ))}
      </Openings>
      {/* The hazard strip along the foot. */}
      <span
        className="h-[8%] min-h-[2px] shrink-0 text-foreground/55"
        style={{ backgroundImage: 'repeating-linear-gradient(45deg, currentColor 0 2px, transparent 2px 5px)' }}
      />
    </Box>
  ),
  WATER: ({ lit }) => (
    <Box>
      <Sign icon={Droplet} lit={lit} />
      <Openings className="gap-[6px]">
        {/* A tank with the water line in it, a standpipe beside it. */}
        <span className={cn('relative h-[90%] w-[34%] overflow-hidden rounded-t-full', OPENING)}>
          <span className={cn('absolute inset-x-0 bottom-0 h-[55%]', TRIM)} />
          <span className={cn('absolute inset-x-[15%] top-[38%] h-px', strong(lit))} />
        </span>
        <span className="flex h-[90%] w-[8%] flex-col items-center">
          <span className={cn('h-[18%] w-full rounded-t-full', strong(lit))} />
          <span className={cn('w-[40%] flex-1', TRIM)} />
        </span>
      </Openings>
    </Box>
  ),
  SERAIL: ({ columns, lit }) => (
    <Box>
      <Flagpole lit={lit} className="left-[48%] top-0 h-[32%] w-[24%]" />
      {/* A pediment over a colonnade, the flag on its peak. */}
      <span className="mx-auto mt-[12cqh] h-[24%] w-[84%] shrink-0 bg-foreground/40" style={TRIANGLE} />
      <span className={cn('mx-auto h-[6%] min-h-[1px] w-[88%] shrink-0', strong(lit))} />
      <Colonnade count={Math.min(7, columns * 2 + 2)} />
    </Box>
  ),
  MUNICIPAL: ({ columns, lit }) => (
    <Box>
      <Sign icon={Flag} lit={lit} />
      <Openings>
        <span className={cn('h-[60%] w-[13%] rounded-t-[1px]', OPENING)} />
        {/* A round-arched double door, a clock face over it. */}
        <span className="relative flex h-[100%] w-[24%] flex-col items-center justify-end">
          <span className={cn('mb-[5cqh] aspect-square w-[34%] rounded-full border border-foreground/50', OPENING)} />
          <span className={cn('h-[56%] w-full rounded-t-full', OPENING)} />
        </span>
        {columns > 1 ? <span className={cn('h-[60%] w-[13%] rounded-t-[1px]', OPENING)} /> : null}
      </Openings>
    </Box>
  ),
  POLICE: ({ lit }) => (
    <Box>
      <Sign icon={Shield} lit={lit} />
      <Openings>
        {/* The patrol light over a barred window and the door. */}
        <span className="relative h-[70%] w-[26%]">
          <span className={cn('absolute -top-[26%] left-1/2 size-[3px] -translate-x-1/2 rounded-full', strong(lit))} />
          <span className={cn('flex h-full w-full justify-evenly rounded-[1px]', OPENING)}>
            {[0, 1, 2].map((i) => (
              <span key={i} className={cn('h-full w-px', TRIM)} />
            ))}
          </span>
        </span>
        <span className={cn('h-[92%] w-[18%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  SECURITY: ({ lit }) => (
    <Box>
      {/* A guard post and the barrier across the road, red-white in the dark. */}
      <span className={cn('mx-[10%] mt-[12cqh] flex h-[46%] shrink-0 items-center justify-center rounded-t-[2px]', OPENING)}>
        <Shield className={cn('h-[80%] max-h-[10px] w-auto', glyphInk(lit))} strokeWidth={2.75} />
      </span>
      <span className="relative mt-auto h-[34%] shrink-0">
        <span className={cn('absolute bottom-0 left-[14%] h-full w-[7%]', strong(lit))} />
        <span
          className="absolute left-[14%] right-[6%] top-[10%] h-[26%] text-foreground/60"
          style={{ backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 3px, transparent 3px 6px)' }}
        />
      </span>
    </Box>
  ),
  MOSQUE: ({ columns, lit }) => (
    <Box>
      {/* The dome with its crescent, the minaret beside it, arched windows below. */}
      <span className={cn('absolute left-[18%] top-[18%] h-[30%] w-[42%] rounded-t-full', strong(lit))} />
      <span className={cn('absolute left-[36%] top-[3%] size-[3px] rounded-full', strong(lit))} />
      <span className="absolute inset-y-0 right-[8%] flex w-[11%] max-w-[9px] flex-col items-center">
        <span className={cn('h-[16%] w-[70%] rounded-t-full', strong(lit))} />
        <span className={cn('h-[6%] w-full', strong(lit))} />
        <span className={cn('w-[55%] flex-1', TRIM)} />
      </span>
      <span className="absolute bottom-0 left-[6%] flex h-[46%] w-[62%] items-end justify-evenly">
        {Array.from({ length: Math.min(5, columns + 2) }, (_, i) => (
          <span key={i} className={cn('w-[16%] rounded-t-full', OPENING, i % 2 === 0 ? 'h-[78%]' : 'h-[100%]')} />
        ))}
      </span>
    </Box>
  ),
  CHURCH: ({ lit }) => (
    <Box>
      {/* A bell tower with its cross, a gabled nave with a rose window and an arched door. */}
      <span className="absolute inset-y-0 left-[8%] flex w-[20%] flex-col items-center">
        <Cross lit={lit} className="size-[5px]" />
        <span className={cn('h-[20%] w-full', strong(lit))} style={TRIANGLE} />
        <span className={cn('w-[70%] flex-1', TRIM)}>
          <span className={cn('mx-auto mt-[6cqh] block h-[22%] w-[40%] rounded-t-full', OPENING)} />
        </span>
      </span>
      <span className={cn('absolute left-[34%] top-[16%] h-[34%] w-[58%]', strong(lit))} style={TRIANGLE} />
      <span className={cn('absolute bottom-0 left-[36%] h-[50%] w-[54%]', TRIM)}>
        <span className={cn('absolute left-1/2 top-[10%] aspect-square h-[30%] -translate-x-1/2 rounded-full', OPENING)} />
        <span className={cn('absolute bottom-0 left-1/2 h-[56%] w-[26%] -translate-x-1/2 rounded-t-full', OPENING)} />
      </span>
    </Box>
  ),
  WORSHIP: ({ lit }) => (
    <Box>
      {/* A hall: a deep arched doorway with a lamp over it, steps to the street. */}
      <span className="mx-auto mt-[6cqh] flex size-[6px] shrink-0 items-center justify-center">
        <Sparkles className={cn('size-full', glyphInk(lit))} strokeWidth={2.75} />
      </span>
      <Openings className="items-end">
        <span className={cn('h-[40%] w-[12%] rounded-t-[1px]', OPENING)} />
        <span className={cn('h-[96%] w-[30%] rounded-t-full', OPENING)} />
        <span className={cn('h-[40%] w-[12%] rounded-t-[1px]', OPENING)} />
      </Openings>
      <span className="mx-auto flex w-[50%] shrink-0 flex-col gap-px pb-[2px]">
        <span className={cn('h-[2px] w-full', TRIM)} />
        <span className={cn('mx-auto h-[2px] w-[70%]', TRIM)} />
      </span>
    </Box>
  ),
  BANK: ({ columns, lit }) => (
    <Box>
      {/* A pediment with a coin in it, four columns, the steps. */}
      <span className="relative mx-auto mt-[5cqh] h-[26%] w-[86%] shrink-0 bg-foreground/40" style={TRIANGLE}>
        <span className={cn('absolute bottom-[18%] left-1/2 size-[4px] -translate-x-1/2 rounded-full', OPENING)} />
      </span>
      <span className={cn('mx-auto h-[5%] min-h-[1px] w-[90%] shrink-0', strong(lit))} />
      <Colonnade count={Math.min(6, columns + 3)} />
      <span className={cn('mx-auto h-[8%] min-h-[2px] w-[96%] shrink-0', TRIM)} />
    </Box>
  ),

  // ── Health ──────────────────────────────────────────────────────────────────
  DISPENSARY: ({ lit }) => (
    <Box>
      {/* A cross over a wide glass door, with a ramp to it. */}
      <span className={cn('flex h-[30%] min-h-[6px] shrink-0 items-center justify-center', OPENING)}>
        <Cross lit={lit} className="h-[88%] max-h-[11px] aspect-square" />
      </span>
      <Openings className="items-stretch pt-[3px]">
        <span className={cn('w-[52%] rounded-t-[2px]', OPENING)}>
          <span className={cn('mx-auto block h-full w-px', TRIM)} />
        </span>
        <span className="mt-auto h-[40%] w-[22%] bg-foreground/25" style={{ clipPath: 'polygon(0 100%, 100% 0, 100% 100%)' }} />
      </Openings>
    </Box>
  ),
  HEALTH_CENTRE: ({ columns, lit }) => (
    <Box>
      <Sign icon={HeartPulse} lit={lit} />
      {/* A canopy over the entrance, windows either side. */}
      <span className="relative flex min-h-0 flex-1 items-end justify-evenly px-[5%] pt-[3px]">
        <span className={cn('h-[56%] w-[16%] rounded-t-[1px]', OPENING)} />
        <span className="relative h-full w-[30%]">
          <span className={cn('absolute inset-x-[-8%] top-[10%] h-[10%]', strong(lit))} />
          <span className={cn('absolute inset-x-0 bottom-0 h-[70%] rounded-t-[1px]', OPENING)} />
        </span>
        {columns > 1 ? <span className={cn('h-[56%] w-[16%] rounded-t-[1px]', OPENING)} /> : null}
      </span>
    </Box>
  ),

  // ── Shop fronts ─────────────────────────────────────────────────────────────
  RESTAURANT: ({ columns, lit }) => (
    <Box>
      <Sign icon={UtensilsCrossed} lit={lit} />
      <Awning columns={columns} />
      <Openings>
        {/* A table laid for two behind the glass, and the door. */}
        <span className={cn('relative h-[96%] flex-1 rounded-t-[2px]', OPENING)}>
          <span className={cn('absolute bottom-[34%] left-[22%] right-[22%] h-[8%]', TRIM)} />
          <span className={cn('absolute bottom-0 left-[46%] h-[34%] w-px', TRIM)} />
          <span className={cn('absolute bottom-0 left-[12%] h-[46%] w-[10%]', TRIM)} />
          <span className={cn('absolute bottom-0 right-[12%] h-[46%] w-[10%]', TRIM)} />
        </span>
        <span className={cn('h-[88%] w-[18%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  CAFE: ({ columns, lit }) => (
    <Box>
      <Sign icon={Coffee} lit={lit} />
      <Awning columns={columns} />
      <Openings className="items-end justify-around">
        {/* Round tables on the pavement under their parasols. */}
        {Array.from({ length: Math.min(3, columns + 1) }, (_, i) => (
          <span key={i} className="flex h-[92%] w-[24%] flex-col items-center justify-end">
            <span className={cn('h-[34%] w-full rounded-t-full', strong(lit))} />
            <span className={cn('h-[40%] w-px', TRIM)} />
            <span className={cn('h-[8%] w-[70%] rounded-full', TRIM)} />
          </span>
        ))}
      </Openings>
    </Box>
  ),
  PHARMACY: ({ columns, lit }) => (
    <Box>
      {/* A big cross over the door; the window is shelves of boxes. */}
      <span className={cn('flex h-[30%] min-h-[7px] shrink-0 items-center justify-center gap-[2px]', OPENING)}>
        <Cross lit={lit} className="h-[88%] max-h-[12px] aspect-square" />
        <Pill className={cn('h-[70%] max-h-[8px] w-auto', glyphInk(lit))} strokeWidth={2.75} />
      </span>
      <Awning columns={columns} />
      <Openings>
        <span className={cn('flex h-[96%] flex-1 flex-col justify-evenly rounded-t-[2px] px-[4%]', OPENING)}>
          {[0, 1].map((row) => (
            <span key={row} className="flex items-end gap-[2px]">
              {Array.from({ length: Math.min(6, columns * 3) }, (_, i) => (
                <span key={i} className={cn('w-[10%] flex-1', TRIM, i % 2 === 0 ? 'h-[3px]' : 'h-[2px]')} />
              ))}
            </span>
          ))}
        </span>
        <span className={cn('h-[88%] w-[16%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  BAKERY: ({ columns, lit }) => (
    <Box>
      <Sign icon={Wheat} lit={lit} />
      <Awning columns={columns} />
      <Openings>
        {/* Loaves on the shelf behind the glass. */}
        <span className={cn('flex h-[96%] flex-1 items-end justify-evenly rounded-t-[2px] pb-[10cqh]', OPENING)}>
          {Array.from({ length: Math.min(5, columns * 2 + 1) }, (_, i) => (
            <span key={i} className={cn('h-[3px] w-[14%] rounded-full', strong(lit))} />
          ))}
        </span>
        <span className={cn('h-[88%] w-[16%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  OVEN: ({ lit }) => (
    <Box>
      {/* A brick oven: the mouth with its fire, the chimney above. */}
      <span className="mx-auto flex h-[34%] w-[16%] shrink-0 items-end justify-center">
        <span className={cn('h-full w-full', TRIM)} />
      </span>
      <span className={cn('mx-[8%] flex min-h-0 flex-1 items-end justify-center rounded-t-[3px]', TRIM)}>
        <span className={cn('flex h-[78%] w-[48%] items-end justify-center rounded-t-full', OPENING)}>
          <span className={cn('h-[48%] w-[70%] rounded-t-full', strong(lit))} />
        </span>
      </span>
    </Box>
  ),
  FUEL: ({ lit }) => (
    <Box>
      {/* The canopy on two pillars, a pump under it. */}
      <span className={cn('relative mt-[10cqh] flex h-[20%] min-h-[4px] shrink-0 items-center justify-center', strong(lit))}>
        <Fuel className="h-[110%] max-h-[10px] w-auto text-background" strokeWidth={2.75} />
      </span>
      <span className="relative flex min-h-0 flex-1 items-end justify-around px-[8%]">
        <span className={cn('absolute bottom-0 left-[10%] top-0 w-[4%] max-w-[2px]', TRIM)} />
        <span className={cn('absolute bottom-0 right-[10%] top-0 w-[4%] max-w-[2px]', TRIM)} />
        <span className={cn('relative flex h-[76%] w-[22%] flex-col items-center rounded-t-[1px] pt-[8cqh]', OPENING)}>
          <span className={cn('h-[28%] w-[60%]', TRIM)} />
          <span className={cn('absolute -right-[22%] top-[28%] h-[40%] w-[14%] rounded-r-full border-r border-foreground/55')} />
        </span>
      </span>
    </Box>
  ),
  SUPERMARKET: ({ columns, lit }) => (
    <Box>
      <Sign icon={ShoppingCart} lit={lit} />
      <Awning columns={columns} />
      <Openings>
        {/* Sliding double doors with a gap between, a rack of trolleys beside. */}
        <span className="flex h-[92%] flex-1 items-stretch justify-center gap-px">
          <span className={cn('w-[34%] rounded-t-[2px]', OPENING)} />
          <span className={cn('w-[34%] rounded-t-[2px]', OPENING)} />
        </span>
        <span className="flex h-[48%] w-[22%] flex-col justify-end gap-px">
          <span className={cn('h-px w-full', TRIM)} />
          <span className={cn('h-px w-[80%]', TRIM)} />
          <span className={cn('h-px w-[60%]', TRIM)} />
        </span>
      </Openings>
    </Box>
  ),
  BUTCHER: ({ columns, lit }) => (
    <Box>
      <Sign icon={Drumstick} lit={lit} />
      <Awning columns={columns} />
      <Openings>
        {/* Cuts hung on hooks behind the glass. */}
        <span className={cn('relative flex h-[96%] flex-1 items-start justify-evenly overflow-hidden rounded-t-[2px] pt-[3cqh]', OPENING)}>
          <span className={cn('absolute inset-x-[6%] top-[4%] h-px', TRIM)} />
          {Array.from({ length: Math.min(5, columns * 2 + 1) }, (_, i) => (
            <span key={i} className="mt-[4cqh] flex w-[12%] flex-col items-center">
              <span className={cn('h-[3px] w-px', TRIM)} />
              <span className={cn('h-[5px] w-full rounded-b-full', strong(lit))} />
            </span>
          ))}
        </span>
        <span className={cn('h-[88%] w-[16%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  BARBER: ({ lit }) => (
    <Box>
      <Sign icon={Scissors} lit={lit} />
      <Openings>
        {/* The striped pole, and the mirror with its chair. */}
        <span
          className="h-[92%] w-[12%] shrink-0 rounded-t-full text-foreground/60"
          style={{ backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 2px, transparent 2px 5px)' }}
        />
        <span className={cn('relative h-[92%] flex-1 rounded-t-[2px]', OPENING)}>
          <span className={cn('absolute left-[28%] top-[14%] h-[48%] w-[26%] rounded-full border border-foreground/45')} />
          <span className={cn('absolute bottom-0 left-[56%] h-[34%] w-[20%] rounded-t-[2px]', TRIM)} />
        </span>
      </Openings>
    </Box>
  ),
  BEAUTY: ({ lit }) => (
    <Box>
      <Sign icon={Sparkles} lit={lit} />
      <Openings>
        {/* A tall oval mirror, a chair in front of it, a door. */}
        <span className={cn('relative h-[92%] flex-1 rounded-t-[2px]', OPENING)}>
          <span className={cn('absolute left-[22%] top-[10%] h-[68%] w-[30%] rounded-full border border-foreground/45')} />
          <span className={cn('absolute bottom-0 left-[58%] h-[30%] w-[18%] rounded-t-full', TRIM)} />
        </span>
        <span className={cn('h-[88%] w-[18%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),

  // ── Workshops and production ────────────────────────────────────────────────
  WORKSHOP: ({ lit }) => (
    <Box>
      <Sign icon={Hammer} lit={lit} />
      {/* A roller door left half raised, the dark of the workshop under it. */}
      <Openings className="px-[8%]">
        <span className={cn('relative h-[96%] w-full overflow-hidden rounded-t-[2px]', OPENING)}>
          <span className="absolute inset-x-0 top-0 flex h-[56%] flex-col justify-evenly">
            {[0, 1, 2].map((i) => (
              <span key={i} className={cn('h-px w-full', TRIM)} />
            ))}
          </span>
          <span className={cn('absolute inset-x-0 top-[56%] h-[6%]', strong(lit))} />
        </span>
      </Openings>
    </Box>
  ),
  ATELIER: ({ columns, lit }) => (
    <Box>
      {/* A big window on a workbench, tools hung on the wall beside it. */}
      <span className="mx-[8%] mt-[8cqh] flex h-[16%] shrink-0 items-center justify-evenly">
        {Array.from({ length: Math.min(6, columns * 2 + 2) }, (_, i) => (
          <span key={i} className={cn('w-px', TRIM, i % 2 === 0 ? 'h-full' : 'h-[70%]')} />
        ))}
      </span>
      <Openings>
        <span className={cn('relative h-[92%] flex-1 rounded-t-[2px]', OPENING)}>
          <span className={cn('absolute inset-x-[8%] bottom-[26%] h-[8%]', strong(lit))} />
          <span className={cn('absolute bottom-0 left-[12%] h-[26%] w-[6%]', TRIM)} />
          <span className={cn('absolute bottom-0 right-[12%] h-[26%] w-[6%]', TRIM)} />
        </span>
        <span className={cn('h-[84%] w-[16%] rounded-t-[2px]', OPENING)} />
      </Openings>
    </Box>
  ),
  PLANT: ({ columns, lit }) => (
    <Box>
      {/* A sawtooth roof, a short stack, a loading door. */}
      <span className="relative mt-[5cqh] flex h-[34%] shrink-0 px-[4%]">
        {Array.from({ length: Math.min(6, columns + 2) }, (_, i) => (
          <span key={i} className={cn('h-full flex-1', i % 2 === 0 ? 'bg-foreground/45' : 'bg-foreground/30')} style={SAW} />
        ))}
        <span className={cn('absolute -top-[10%] right-[8%] h-[70%] w-[8%]', strong(lit))} />
      </span>
      <Openings className="px-[10%]">
        <span className={cn('h-[88%] w-[42%] rounded-t-[1px]', OPENING)}>
          <span className={cn('mx-auto block h-full w-px', TRIM)} />
        </span>
        <span className={cn('h-[44%] w-[16%] rounded-t-[1px]', OPENING)} />
      </Openings>
    </Box>
  ),
  FACTORY: ({ lit }) => (
    <Box>
      {/* Two tall chimneys with their smoke, a sign, the loading door. */}
      <span className="relative mt-[2cqh] h-[46%] shrink-0">
        <span className={cn('absolute bottom-0 left-[14%] h-full w-[9%]', strong(lit))} />
        <span className={cn('absolute bottom-0 left-[34%] h-[78%] w-[9%]', strong(lit))} />
        <span className={cn('absolute left-[10%] top-[-4%] size-[3px] rounded-full', TRIM)} />
        <span className={cn('absolute left-[18%] top-[-14%] size-[2px] rounded-full', TRIM)} />
        <span className={cn('absolute right-[10%] top-[40%] flex h-[56%] w-[34%] items-center justify-center', OPENING)}>
          <Factory className={cn('h-[90%] w-auto', glyphInk(lit))} strokeWidth={2.75} />
        </span>
      </span>
      <Openings className="px-[8%]">
        <span className={cn('h-[84%] w-[26%] rounded-t-[1px]', OPENING)} />
        <span className={cn('h-[84%] w-[26%] rounded-t-[1px]', OPENING)} />
        <span className={cn('h-[58%] w-[16%] rounded-t-[1px]', OPENING)} />
      </Openings>
    </Box>
  ),
};

/** Whether a drawing exists for `figure` — every `UNIT_FIGURE` key has one; a stored key from a newer build does not. */
export function hasUnitFigure(figure: string | null | undefined): figure is UnitFigure {
  return figure != null && Object.prototype.hasOwnProperty.call(UNIT_FIGURE_ART, figure);
}

/** The front of one unit, drawn as its type's figure. Fills the unit's box. */
export function UnitFigureFront({ figure, columns, lit }: { figure: UnitFigure; columns: number; lit: boolean }) {
  return <>{UNIT_FIGURE_ART[figure]({ columns, lit })}</>;
}
