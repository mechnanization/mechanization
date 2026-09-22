'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { Building2, ChevronDown, Loader2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getBuilding, type BuildingDetail } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { cn } from '@/lib/utils';
import { groupUnitsByFloor, layoutFloor, withDeclaredBasements } from './building-unit-forms';
import { HELD_DOT, UnitHoldingsGrid } from './unit-holdings-grid';

/** One thing this citizen holds in the building — a flat's card, placed by its census unit. */
export interface BuildingHolding {
  key: string;
  /** The census `Unit` the card's line is linked to; null for a line typed by hand. */
  unitId: string | null;
  /** `OWNER` · `TENANT` · `FREE_OCCUPANT` — what they are to it. */
  occupancyType: string;
  /** Ended lines are history: listed, never marked on the matrix as held. */
  ended: boolean;
  /** The card the file shows for this line — its facts as label-and-value rows. */
  card: ReactNode;
}

/**
 * One building on a citizen's file — folded shut until opened.
 *
 * A household holding flats in several buildings used to read as a run of
 * cards, one per flat, with nothing to say which building each was in or where
 * in it. Grouped by building, each opens onto that building's own matrix with
 * the citizen's flats marked — owned, rented, occupied — so «the flat on the
 * third floor of Z-3-43-A» is something seen rather than assembled from rows.
 * Tapping one of theirs shows its card below: the same rows the file shows
 * everywhere else.
 *
 * ## Only this citizen's flats are shown as anything
 *
 * Every other flat in the building is drawn as its code and nothing more —
 * not its state, not who lives in it. The matrix page prints occupants' names
 * on the tiles because that page is about the building; this one is about one
 * person, and a neighbour's name and tenancy do not belong on their file.
 *
 * ## Loaded when opened
 *
 * The matrix is a read of the whole building, so it is not made until the
 * section is opened — a file listing flats in six buildings should not fetch
 * six buildings to show six closed headings.
 */
export function BuildingHoldings({
  tenant,
  token,
  base,
  locale,
  buildingId,
  buildingCode,
  subtitle,
  holdings,
  renderGrid,
}: {
  tenant: string;
  token: string | null;
  /** `/{tenant}/{locale}/{adminPath}` — where an expired session is sent. */
  base: string;
  locale: string;
  buildingId: string;
  buildingCode: string | null;
  /** The building's name or its painted number, where there is one. */
  subtitle: string | null;
  holdings: BuildingHolding[];
  /** Lays out cards not placed on the matrix, the way the rest of the file does. */
  renderGrid: (cards: ReactNode[]) => ReactNode;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [open, setOpen] = useState(false);
  // Mounted on the first open and kept: closing it again should not throw the
  // matrix away and re-read it on the next open.
  const [opened, setOpened] = useState(false);

  const live = holdings.filter((holding) => !holding.ended);
  const roles = [...new Set(live.map((holding) => holding.occupancyType))];

  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open;
        setOpen(next);
        if (next) setOpened(true);
      }}
      className="group overflow-hidden rounded-lg border bg-card"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 transition-colors hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180"
          aria-hidden
        />
        <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="flex min-w-0 flex-1 flex-col gap-y-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-x-3">
          <p className="min-w-0 truncate text-sm font-semibold">
            <bdi dir="ltr" className="font-mono">
              {buildingCode ?? (en ? 'Building' : 'منشأة')}
            </bdi>
            {subtitle ? <span className="ms-2 font-normal text-muted-foreground">{subtitle}</span> : null}
          </p>
          <p className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            <span>{en ? `${live.length} unit(s)` : `${live.length} وحدة`}</span>
            {roles.map((role) => (
              <span key={role} className="inline-flex items-center gap-1">
                <span aria-hidden className={cn('size-2 rounded-full', HELD_DOT[role] ?? 'bg-muted-foreground')} />
                {labels.occupancyType[role as never] ?? role}
              </span>
            ))}
          </p>
        </div>
      </summary>

      {opened ? (
        <div className="border-t p-4">
          <HoldingsMatrix
            tenant={tenant}
            token={token}
            base={base}
            locale={locale}
            buildingId={buildingId}
            holdings={holdings}
            renderGrid={renderGrid}
          />
        </div>
      ) : null}
    </details>
  );
}

function HoldingsMatrix({
  tenant,
  token,
  base,
  locale,
  buildingId,
  holdings,
  renderGrid,
}: {
  tenant: string;
  token: string | null;
  base: string;
  locale: string;
  buildingId: string;
  holdings: BuildingHolding[];
  renderGrid: (cards: ReactNode[]) => ReactNode;
}) {
  const en = locale === 'en';
  const [selected, setSelected] = useState<string | null>(null);

  const { data: building, loading, error } = useStaffQuery<BuildingDetail>({
    queryKey: ['staff', tenant, 'citizen-building-holdings', buildingId],
    token,
    tenant,
    base,
    queryFn: (tok, signal) => getBuilding(tenant, tok, buildingId, signal),
    errorMessage: en ? 'Could not load this building.' : 'تعذّر تحميل هذا المبنى.',
  });

  /** unitId → the holding on it, for the live lines only. */
  const held = useMemo(() => {
    const map = new Map<string, BuildingHolding>();
    for (const holding of holdings) {
      if (holding.unitId && !holding.ended) map.set(holding.unitId, holding);
    }
    return map;
  }, [holdings]);

  const floors = useMemo(
    () =>
      building
        ? withDeclaredBasements(groupUnitsByFloor(building.units), building.basementsCount).map(
            ({ floor, units }) => ({ floor, ...layoutFloor(units) }),
          )
        : [],
    [building],
  );

  /*
    What cannot be placed on the matrix: a line typed by hand with no census
    unit, a unit the census no longer lists, and ended lines, which are
    history. Listed under it as the ordinary cards, so nothing on the file
    becomes unreachable by being grouped.
  */
  const placedIds = useMemo(
    () => new Set((building?.units ?? []).map((unit) => unit.id)),
    [building],
  );
  // With no building to draw — the read failed — every card is listed, so a
  // lost connection never makes a flat disappear from the file.
  const unplaced = building
    ? holdings.filter(
        (holding) => holding.ended || !holding.unitId || !placedIds.has(holding.unitId),
      )
    : holdings;
  const chosen = selected ? held.get(selected) : undefined;
  const heldRoles = useMemo(
    () => new Map([...held].map(([unitId, holding]) => [unitId, holding.occupancyType])),
    [held],
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {en ? 'Loading the building…' : 'جاري تحميل المبنى…'}
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {building && floors.length > 0 ? (
        <UnitHoldingsGrid
          floors={floors}
          held={heldRoles}
          selectedUnitId={selected}
          onSelect={setSelected}
          locale={locale}
        />
      ) : null}

      {/* The flat tapped on the matrix: its card, as label-and-value rows. */}
      {chosen ? <div>{chosen.card}</div> : null}

      {unplaced.length > 0 ? renderGrid(unplaced.map((holding) => holding.card)) : null}
    </div>
  );
}
