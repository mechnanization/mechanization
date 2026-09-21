'use client';

import { getLabels } from '@mechanization/shared-schemas';
import type { UnitWithOccupants } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { floorLabel, type LaidOutUnit } from './building-unit-forms';

/**
 * The colour of a held flat, by what the citizen is to it.
 *
 * Green for what they own, blue for what they rent, amber for what they occupy
 * on sufferance — the same three hues the rest of the census gives these
 * three, so a reader who knows the matrix page reads this one without a key.
 */
export const HELD_CLASS: Record<string, string> = {
  OWNER: 'bg-emerald-600/15 text-emerald-700 ring-emerald-600/50 hover:bg-emerald-600/25 dark:text-emerald-400',
  TENANT: 'bg-sky-500/15 text-sky-700 ring-sky-500/50 hover:bg-sky-500/25 dark:text-sky-400',
  FREE_OCCUPANT: 'bg-amber-500/15 text-amber-700 ring-amber-500/50 hover:bg-amber-500/25 dark:text-amber-400',
};

export const HELD_DOT: Record<string, string> = {
  OWNER: 'bg-emerald-600',
  TENANT: 'bg-sky-500',
  FREE_OCCUPANT: 'bg-amber-500',
};

/**
 * A building's matrix with one person's flats lit and every other flat locked.
 *
 * Drawn as the matrix page draws it — floors top-down, each unit on the
 * columns it was painted across, left to right whatever the page's direction,
 * because the columns are a plan of the building and not a line of text. The
 * floor labels sit outside the strip that scrolls, so a wide floor never
 * scrolls its own name away.
 *
 * Every flat that is not theirs is dimmed, disabled and shows its code and
 * nothing else — not its state, not who lives in it. Theirs are coloured by
 * what they are to it, and a tap selects one; the caller shows what it is.
 *
 * Shared by the citizen's file and the registration form, so a flat held reads
 * the same on both.
 */
export function UnitHoldingsGrid({
  floors,
  held,
  selectedUnitId,
  onSelect,
  locale,
}: {
  floors: Array<{ floor: number; blocks: Array<LaidOutUnit<UnitWithOccupants>>; width: number }>;
  /** unitId → `OWNER` · `TENANT` · `FREE_OCCUPANT`, for the flats that are theirs. */
  held: ReadonlyMap<string, string>;
  selectedUnitId: string | null;
  onSelect: (unitId: string | null) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const roles = [...new Set(held.values())];

  return (
    <div className="space-y-2">
      {/* The key, for the colours this building actually uses. */}
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {roles.map((role) => (
          <span key={role} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn('size-2.5 rounded-sm', HELD_DOT[role] ?? 'bg-muted-foreground')} />
            {labels.occupancyType[role as never] ?? role}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm bg-muted ring-1 ring-inset ring-border" />
          {en ? 'Other units' : 'وحدات أخرى'}
        </span>
      </p>

      <div dir="ltr" className="flex items-stretch gap-2 rounded-lg border bg-muted/10 p-2">
        <div className="flex shrink-0 flex-col gap-1.5">
          {floors.map(({ floor }) => (
            <div
              key={floor}
              className="flex h-12 w-14 items-center justify-end text-[11px] font-medium tabular-nums text-muted-foreground sm:w-20"
            >
              {floorLabel(floor, en)}
            </div>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden overscroll-x-contain pb-1 [scrollbar-width:thin]">
          <div className="flex flex-col gap-1.5">
            {floors.map(({ floor, blocks, width }) => (
              <div
                key={floor}
                className="grid h-12 gap-1.5"
                style={{ gridTemplateColumns: `repeat(${width}, minmax(2.75rem, 1fr))` }}
              >
                {blocks.map(({ unit, startCol, endCol }) => {
                  const role = held.get(unit.id);
                  const selected = unit.id === selectedUnitId;
                  return (
                    <button
                      key={unit.id}
                      type="button"
                      disabled={!role}
                      onClick={() => onSelect(selected ? null : unit.id)}
                      aria-pressed={role ? selected : undefined}
                      style={{ gridColumn: `${startCol} / ${endCol + 1}` }}
                      className={cn(
                        'flex h-full flex-col items-center justify-center gap-0.5 rounded-md px-1 text-center ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        role
                          ? cn('cursor-pointer', HELD_CLASS[role] ?? HELD_CLASS.OWNER)
                          : 'cursor-default bg-muted/40 text-muted-foreground/60 ring-border',
                        selected && 'ring-2 ring-primary',
                      )}
                    >
                      <span className="font-mono text-xs font-bold">{unit.unitCode}</span>
                      {role ? (
                        <span className="block max-w-full truncate text-[10px] font-medium leading-tight">
                          {labels.occupancyType[role as never] ?? role}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
