'use client';

import { useState } from 'react';
import { ChevronDown, ChevronUp, Eye, EyeOff, Info, Layers, Type } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ZoneSummary } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/**
 * Static, non-draggable Sector Legend aligned at the top level with the search bar.
 * Staff can collapse and expand it with arrow buttons (▲ / ▼) without hiding the zones from the map.
 */
export function ZoneLegend({
  zones,
  visible,
  onVisibleChange,
  labelsVisible = true,
  onLabelsVisibleChange,
  activeZoneId,
  onSelectZone,
  onOpenZoneInfo,
  locale = 'ar',
}: {
  zones: ZoneSummary[];
  visible: boolean;
  onVisibleChange: (visible: boolean) => void;
  /** Whether the sector text labels are shown on the map. */
  labelsVisible?: boolean;
  onLabelsVisibleChange?: (visible: boolean) => void;
  /** Highlighted row, when the map is filtered to one sector. */
  activeZoneId?: string | null;
  onSelectZone?: (zoneId: string | null) => void;
  onOpenZoneInfo?: (zone: ZoneSummary) => void;
  locale?: string;
}) {
  const isEnglish = locale === 'en';
  const [collapsed, setCollapsed] = useState(false);
  const hasZones = zones.length > 0;

  return (
    <div
      className={cn(
        'w-full overflow-hidden rounded-xl border border-border/80 bg-card/95 shadow-md backdrop-blur select-none transition-all duration-200',
      )}
    >
      {/* Header aligned at top-3 */}
      <div className="flex items-center justify-between gap-1.5 border-b border-border/60 px-2.5 py-1.5 bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <span className="flex items-center gap-1 text-xs font-bold text-foreground truncate">
            <Layers className="size-3.5 text-primary shrink-0" aria-hidden />
            <span>{isEnglish ? 'Sectors' : 'القطاعات'}</span>
            <span className="text-xs text-muted-foreground font-normal">({zones.length})</span>
          </span>
        </div>

        {/* Action Controls: Arrow Collapse / Expand + Toggle Names + Map Layer Visibility */}
        <div className="flex items-center gap-0.5 shrink-0">
          {/* Arrow Collapse Button (Collapses the UI list without hiding zones on the map) */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={
              collapsed
                ? (isEnglish ? 'Expand sectors list' : 'توسيع قائمة القطاعات')
                : (isEnglish ? 'Collapse sectors list' : 'طي قائمة القطاعات')
            }
            title={
              collapsed
                ? (isEnglish ? 'Expand sectors list' : 'توسيع قائمة القطاعات')
                : (isEnglish ? 'Collapse sectors list' : 'طي قائمة القطاعات')
            }
            className="size-7 text-muted-foreground hover:text-foreground cursor-pointer sm:size-6"
          >
            {collapsed ? (
              <ChevronDown className="size-3.5" aria-hidden />
            ) : (
              <ChevronUp className="size-3.5" aria-hidden />
            )}
          </Button>

          {/* Toggle Sector Names / Labels Visibility on Map */}
          {onLabelsVisibleChange ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={!hasZones}
              onClick={() => onLabelsVisibleChange(!labelsVisible)}
              aria-label={
                labelsVisible
                  ? (isEnglish ? 'Hide sector names' : 'إخفاء أسماء القطاعات')
                  : (isEnglish ? 'Show sector names' : 'إظهار أسماء القطاعات')
              }
              title={
                labelsVisible
                  ? (isEnglish ? 'Hide sector names' : 'إخفاء أسماء القطاعات')
                  : (isEnglish ? 'Show sector names' : 'إظهار أسماء القطاعات')
              }
              className={cn(
                'size-7 cursor-pointer transition-colors sm:size-6',
                labelsVisible
                  ? 'text-primary hover:text-primary/80 font-bold'
                  : 'text-muted-foreground/40 hover:text-foreground',
              )}
            >
              <Type className="size-3.5" aria-hidden />
            </Button>
          ) : null}

          {/* Toggle Layer Visibility on Map */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={!hasZones}
            onClick={() => onVisibleChange(!visible)}
            aria-label={
              visible
                ? (isEnglish ? 'Hide sectors from map' : 'إخفاء طبقة القطاعات')
                : (isEnglish ? 'Show sectors on map' : 'إظهار طبقة القطاعات')
            }
            title={
              visible
                ? (isEnglish ? 'Hide sectors from map' : 'إخفاء طبقة القطاعات')
                : (isEnglish ? 'Show sectors on map' : 'إظهار طبقة القطاعات')
            }
            className="size-7 text-muted-foreground hover:text-foreground cursor-pointer sm:size-6"
          >
            {visible ? (
              <Eye className="size-3.5" aria-hidden />
            ) : (
              <EyeOff className="size-3.5 text-muted-foreground/60" aria-hidden />
            )}
          </Button>
        </div>
      </div>

      {/* Sector List (hidden when collapsed, but zones remain visible on the map) */}
      {!collapsed && !hasZones ? (
        <p className="px-3 py-3 text-center text-xs text-muted-foreground">
          {isEnglish ? 'No sectors created yet' : 'لا توجد قطاعات بعد'}
        </p>
      ) : null}

      {!collapsed && hasZones ? (
        <ul className="max-h-40 overflow-y-auto p-1 space-y-0.5 sm:max-h-56">
          {zones.map((zone) => {
            const active = activeZoneId === zone.id;
            return (
              <li
                key={zone.id}
                className={cn(
                  'group/item flex items-center justify-between gap-1 rounded-lg px-1 transition-colors',
                  active ? 'bg-accent font-semibold' : 'hover:bg-accent/60',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelectZone?.(active ? null : zone.id)}
                  disabled={!onSelectZone}
                  className={cn(
                    'flex min-w-0 flex-1 items-center gap-2 py-1.5 ps-1 text-start text-xs transition-colors',
                    active ? 'font-bold text-foreground' : 'text-muted-foreground group-hover/item:text-foreground',
                    onSelectZone ? 'cursor-pointer' : 'cursor-default',
                  )}
                >
                  <span
                    className="size-3 shrink-0 rounded-sm border border-black/20 shadow-2xs"
                    style={{ backgroundColor: zone.color }}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1 truncate">{zone.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground font-mono" dir="ltr">
                    {zone.parcelCount}
                  </span>
                </button>

                {onOpenZoneInfo ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenZoneInfo(zone);
                    }}
                    title={isEnglish ? `View ${zone.name} info` : `معلومات ومساحة ${zone.name}`}
                    aria-label={isEnglish ? `View ${zone.name} info` : `معلومات ${zone.name}`}
                    className="size-7 text-muted-foreground/60 hover:text-primary hover:bg-background/80 shrink-0 cursor-pointer sm:size-6"
                  >
                    <Info className="size-3.5" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}