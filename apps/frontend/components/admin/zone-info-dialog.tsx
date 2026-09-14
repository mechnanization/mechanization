'use client';

import { useMemo } from 'react';
import {
  Building2,
  ExternalLink,
  Layers,
  Maximize2,
} from 'lucide-react';
import type { FeatureCollection } from 'geojson';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { RegisteredParcel, ZoneSummary } from '@/lib/api-client';
import { computeGeoJsonArea, formatArea } from '@/lib/map-geometry';
import Link from 'next/link';

export function ZoneInfoDialog({
  zone,
  open,
  onOpenChange,
  zonesGeoJson,
  tenant,
  locale = 'ar',
}: {
  zone: ZoneSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zonesGeoJson: FeatureCollection | null;
  parcels?: RegisteredParcel[];
  tenant: string;
  locale?: string;
}) {
  const isEnglish = locale === 'en';

  const zoneFeature = useMemo(() => {
    if (!zone || !zonesGeoJson) return null;
    return zonesGeoJson.features.find((f) => f.properties?.zoneId === zone.id) ?? null;
  }, [zone, zonesGeoJson]);

  const area = useMemo(() => {
    if (!zoneFeature) return null;
    return computeGeoJsonArea(zoneFeature.geometry);
  }, [zoneFeature]);

  if (!zone) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md overflow-hidden p-0">
        <DialogHeader className="border-b p-4 pb-3 bg-muted/20">
          <div className="flex items-center gap-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-xl text-white font-bold shadow-xs"
              style={{ backgroundColor: zone.color }}
            >
              <Layers className="size-5" />
            </span>
            <div>
              <DialogTitle className="text-base font-bold flex items-center gap-2">
                <span>{zone.name}</span>
                <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-mono font-normal text-muted-foreground">
                  {zone.code}
                </span>
              </DialogTitle>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isEnglish ? 'Sector & Cadastral Zone Details' : 'تفاصيل ومعلومات القطاع العقاري'}
              </p>
            </div>
          </div>
        </DialogHeader>

        <div className="p-4 space-y-4">
          {/* Key Geographic Metrics Grid */}
          <div className="grid grid-cols-2 gap-2.5">
            {/* Area Metric */}
            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Maximize2 className="size-3.5 text-primary" />
                <span>{isEnglish ? 'Estimated Area' : 'المساحة التقديرية'}</span>
              </div>
              <p className="mt-1 text-sm font-bold text-foreground">
                {area && area.squareMeters > 0
                  ? formatArea(area.squareMeters, locale)
                  : (isEnglish ? 'Not calculated' : 'غير محددة')}
              </p>
              {area && area.squareKilometers > 0.01 ? (
                <p className="text-[11px] text-muted-foreground mt-0.5 font-medium">
                  {area.squareKilometers.toFixed(2)} {isEnglish ? 'km²' : 'كم²'}
                </p>
              ) : null}
            </div>

            {/* Parcels Metric */}
            <div className="rounded-xl border border-border/80 bg-card p-3 shadow-xs">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Building2 className="size-3.5 text-primary" />
                <span>{isEnglish ? 'Cadastral Parcels' : 'العقارات في القطاع'}</span>
              </div>
              <p className="mt-1 text-base font-bold text-foreground">
                {zone.parcelCount}{' '}
                <span className="text-xs font-normal text-muted-foreground">
                  {isEnglish ? 'parcels' : 'عقار'}
                </span>
              </p>
            </div>
          </div>

          {/* Description / Notes if available */}
          {zone.description ? (
            <div className="rounded-xl border border-border/60 bg-muted/40 p-3 text-xs text-muted-foreground">
              <span className="font-semibold text-foreground block mb-1">
                {isEnglish ? 'Description / Notes:' : 'ملاحظات ووصف القطاع:'}
              </span>
              <p className="leading-relaxed">{zone.description}</p>
            </div>
          ) : null}

          {/* Footer Actions */}
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/60">
            <Link
              href={`/t/${tenant}/admin/zones`}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
            >
              <span>{isEnglish ? 'Manage & Edit Sectors' : 'إدارة وتعديل القطاعات'}</span>
              <ExternalLink className="size-3" />
            </Link>

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="h-8 text-xs font-semibold cursor-pointer"
            >
              {isEnglish ? 'Close' : 'إغلاق'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
