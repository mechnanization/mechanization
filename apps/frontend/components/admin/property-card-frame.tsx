'use client';

import { Fragment, isValidElement, type ReactNode } from 'react';
import {
  Briefcase,
  Building,
  Building2,
  Car,
  Columns3,
  House,
  LandPlot,
  MapPin,
  SquareDashed,
  Stethoscope,
  Store,
  Tent,
  Warehouse,
  type LucideIcon,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { Badge } from '@/components/ui/badge';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { StatStrip } from '@/components/ui/stat-strip';
import { SummaryList } from '@/components/ui/summary-list';
import type { PropertyTone } from '@/components/admin/property-illustrations';
import { occupancyDot } from '@/lib/occupancy';
import { cn } from '@/lib/utils';

/** Each property type's icon. */
export const PROPERTY_ICON: Record<string, LucideIcon> = {
  BUILDING: Building2,
  HOUSE: House,
  LAND: LandPlot,
  TENT: Tent,
};

/** Every unit type the census knows, each with its own icon. */
export const UNIT_ICON: Record<string, LucideIcon> = {
  APARTMENT: Building,
  INDEPENDENT_HOUSE: House,
  CLINIC: Stethoscope,
  OFFICE: Briefcase,
  SHOP: Store,
  WAREHOUSE: Warehouse,
  GARAGE: Car,
  PILOTIS: Columns3,
  EMPTY_FLOOR: SquareDashed,
};

/**
 * One property, as a card: its picture in a side panel, then its title, its
 * figures and a switch between its sections. Shared by the citizen's
 * properties page and «فحص الملف», so a property reads the same wherever it
 * is shown (UX-1); each screen supplies its own sections as children
 * (`CardPanels` of `CardPanel`s), then whatever follows them.
 */
export function PropertyCardFrame({
  picture,
  grayscale = false,
  badgeStart,
  badgesEnd,
  icon: Icon,
  tone,
  title,
  neighbourhood,
  zone,
  stats,
  tabs,
  tab,
  onTab,
  locale = 'ar',
  children,
}: {
  /** The drawing (`PropertyScene`). */
  picture: ReactNode;
  /** An ended card's picture is greyed; its text is not, so it stays readable (COL-4). */
  grayscale?: boolean;
  /** Over the picture, at the start edge — the role. */
  badgeStart?: ReactNode;
  /** Over the picture, at the end edge — the building's condition, an end date. */
  badgesEnd?: ReactNode;
  icon: LucideIcon;
  tone: PropertyTone;
  title: ReactNode;
  neighbourhood?: string | null;
  zone?: string | null;
  /** `StatItem`s; the strip is left out when there are none. */
  stats?: ReactNode;
  tabs: Array<{ value: string; label: string }>;
  tab: string;
  onTab: (value: string) => void;
  locale?: string;
  children: ReactNode;
}) {
  const en = locale === 'en';
  return (
    <article className="flex flex-col overflow-hidden rounded-lg border bg-card shadow-sm md:flex-row">
      {/* ── The picture, with its badges over the sky ────────────── */}
      <div className="relative h-64 shrink-0 border-b bg-muted/40 md:order-last md:h-auto md:min-h-[22rem] md:w-80 md:border-b-0 md:border-s lg:w-96">
        <div
          className={cn(
            'absolute inset-x-8 bottom-10 top-12 overflow-hidden md:inset-x-10 md:bottom-14 md:top-16',
            grayscale && 'grayscale',
          )}
        >
          {picture}
        </div>
        <div className="absolute inset-x-3 top-3 flex items-start justify-between gap-2">
          {badgeStart}
          <div className="flex flex-wrap justify-end gap-1.5">{badgesEnd}</div>
        </div>
      </div>

      {/* ── The info column: title, figures, the switch, the open section ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
          Drawn as the page header is: the tile centred on the two lines beside
          it, the place on the second line with the zone as a badge — which
          keeps one baseline where «حي · حي» separated by a dot did not.
        */}
        <div className="flex items-center gap-3 px-4 pt-4">
          <span
            aria-hidden
            className={cn(
              'flex size-10 shrink-0 items-center justify-center rounded-lg',
              tone === 'owner' ? 'bg-success/10 text-success' : 'bg-info/10 text-info',
            )}
          >
            <Icon className="size-5" />
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="truncate text-lg font-bold leading-tight">{title}</h2>
            {neighbourhood || zone ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                {neighbourhood ? (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <MapPin className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{neighbourhood}</span>
                  </span>
                ) : null}
                {zone ? <Badge variant="soft-muted">{zone}</Badge> : null}
              </div>
            ) : null}
          </div>
        </div>

        {stats ? <StatStrip className="mx-4 mt-3">{statItems(stats)}</StatStrip> : null}

        <div className="mx-4 mt-4">
          <SegmentedControl
            size="sm"
            aria-label={en ? 'Section' : 'القسم'}
            value={tab}
            onChange={onTab}
            options={tabs}
          />
        </div>

        {children}
      </div>
    </article>
  );
}

/**
 * The figures as separate children. `StatStrip` sets its columns by counting
 * its children, and a fragment of four figures counts as one — every figure
 * then stacked in a single column.
 */
function statItems(stats: ReactNode): ReactNode {
  return isValidElement<{ children?: ReactNode }>(stats) && stats.type === Fragment ? stats.props.children : stats;
}

/**
 * The sections of a `PropertyCardFrame`, laid in one grid cell, only the open
 * one visible. The cell is as tall as the tallest, so nothing is ever cut off
 * or scrolled, and switching tab or unit never changes the block's size.
 */
export function CardPanels({ children }: { children: ReactNode }) {
  return <div className="mx-4 my-3 grid">{children}</div>;
}

/**
 * One section's facts. Every panel sits in the same grid cell; inactive ones
 * stay laid out but `invisible` — out of sight, focus order and the
 * accessibility tree alike — so the block is always as tall as its tallest
 * panel and switching section never moves the page. The section switch is a
 * radio group (SegmentedControl), so these are plain regions, not tab panels.
 */
export function CardPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div aria-hidden={!active} className={cn('rounded-lg border px-3 [grid-area:1/1]', !active && 'invisible')}>
      <SummaryList>{children}</SummaryList>
    </div>
  );
}

/** A unit's status, with the dot the occupancy colours use. */
export function UnitStatusLine({ status, locale = 'ar' }: { status: string | null | undefined; locale?: string }) {
  const dot = occupancyDot(status);
  const text = status ? ((getLabels(locale).unitStatus as Record<string, string>)[status] ?? status) : null;
  if (!text) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn(
          'size-2.5 shrink-0 rounded-full',
          dot === 'occupied' && 'bg-success',
          dot === 'vacant' && 'bg-muted-foreground/50',
          dot === 'seasonal' && 'border-2 border-success',
        )}
      />
      {text}
    </span>
  );
}
