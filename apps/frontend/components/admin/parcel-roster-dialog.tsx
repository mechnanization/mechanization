'use client';

import { useEffect, useState } from 'react';
import { Building2, Loader2, Users } from 'lucide-react';
import { getLabels, isUnoccupied } from '@mechanization/shared-schemas';
import { getParcelRoster, logApiError, type ParcelRoster } from '@/lib/api-client';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/**
 * Who is on this parcel.
 *
 * The registrar's natural question — «مين على العقار ١٥٥٣؟» — answered without
 * making the register store the answer that way. A parcel row owning a list of
 * units, each naming its occupant, is the obvious design and the wrong one
 * here: every fee is raised against a `citizenId`, so an owner recorded as a
 * name on a unit is an owner nobody can bill, and the register would hold two
 * answers to "who owns this" that disagree the moment either is edited.
 *
 * So this is computed from the citizen-keyed data on every open. It is always
 * current, and there is nothing to keep in step.
 */
export function ParcelRosterDialog({
  open,
  onOpenChange,
  tenant,
  token,
  propertyNumber,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string;
  propertyNumber: string;
  locale?: string;
}) {
  const labels = getLabels(locale);
  const [roster, setRoster] = useState<ParcelRoster | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !propertyNumber) return;
    let cancelled = false;

    setLoading(true);
    setError(null);
    setRoster(null);

    getParcelRoster(tenant, token, propertyNumber)
      .then((result) => {
        if (!cancelled) setRoster(result);
      })
      .catch((caught) => {
        logApiError(caught);
        if (!cancelled) {
          setError(
            locale === 'en'
              ? 'Could not load this parcel.'
              : 'تعذّر تحميل بيانات هذا العقار.',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, tenant, token, propertyNumber, locale]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-5 shrink-0 text-primary" aria-hidden />
            {locale === 'en' ? `Parcel ${propertyNumber}` : `العقار ${propertyNumber}`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {roster
              ? locale === 'en'
                ? `${roster.citizenCount} citizen(s), ${roster.structureCount} structure(s) registered here.`
                : `${roster.citizenCount} مواطن، و${roster.structureCount} منشأة مسجّلة على هذا العقار.`
              : locale === 'en'
                ? 'Everyone registered on this parcel number.'
                : 'جميع المسجَّلين على رقم العقار هذا.'}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            {locale === 'en' ? 'Loading…' : 'جارٍ التحميل…'}
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            {error}
          </p>
        ) : null}

        {roster && roster.citizens.length === 0 ? (
          <p className="py-8 text-center text-xs text-muted-foreground">
            {locale === 'en'
              ? 'Nobody is registered on this parcel yet.'
              : 'لا يوجد مسجَّلون على هذا العقار بعد.'}
          </p>
        ) : null}

        <div className="space-y-3">
          {roster?.citizens.map((citizen) => (
            <div
              key={citizen.citizenId}
              className="rounded-lg border border-border/80 bg-card p-3 space-y-2"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Users className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  {citizen.fullName}
                  {!citizen.isActive ? (
                    <Badge variant="outline" className="text-xs">
                      {locale === 'en' ? 'Inactive' : 'غير مفعّل'}
                    </Badge>
                  ) : null}
                </p>
                {citizen.referenceNumber ? (
                  <Badge variant="outline" className="font-mono text-xs" dir="ltr">
                    {citizen.referenceNumber}
                  </Badge>
                ) : null}
              </div>

              <ul className="space-y-1.5">
                {citizen.structures.map((structure) => (
                  <li
                    key={structure.propertyEntryId}
                    className="rounded-md bg-muted/40 px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-medium">
                      {labels.propertyType?.[structure.propertyType as never] ??
                        structure.propertyType}
                    </span>
                    {structure.buildingName ? ` — ${structure.buildingName}` : ''}
                    <span className="text-muted-foreground">
                      {' · '}
                      {labels.occupancyType?.[structure.occupancyType as never] ??
                        structure.occupancyType}
                    </span>

                    {/*
                      Units are listed whichever shape they are stored in — a
                      building's own rows, or the single unit that sits flat on
                      a house or a plot. The screen should not expose which of
                      the two the register happened to use.
                    */}
                    <ul className="mt-1 flex flex-wrap gap-1">
                      {structure.units.map((unit, unitIndex) => {
                        /*
                          An unoccupied unit is tinted, not merely labelled.

                          «شو في فاضي بالعقار ١٥٥٣؟» is the same question as
                          «مين على العقار ١٥٥٣؟» asked from the other end, and
                          this list is the only screen holding every card on
                          the parcel at once. Picking the empty ones out of a
                          run of grey chips has to be possible without reading
                          each one — which, given «شاغرة» and «مشغولة» differ by
                          two letters, it otherwise is not.

                          A unit with no recorded status renders plain: nobody
                          was asked, which is not a claim that it is occupied.
                        */
                        const empty = isUnoccupied(unit.unitStatus);

                        return (
                          <li
                            key={unit.id ?? unitIndex}
                            className={cn(
                              'rounded px-1.5 py-0.5 text-xs ring-1',
                              empty
                                ? 'bg-warning/10 text-warning ring-warning/40'
                                : 'bg-background text-muted-foreground ring-border/60',
                            )}
                          >
                            {unit.unitType
                              ? (labels.unitType?.[unit.unitType as never] ?? unit.unitType)
                              : (locale === 'en' ? 'Unit' : 'وحدة')}
                            {unit.floor ? ` · ${locale === 'en' ? 'floor' : 'طابق'} ${unit.floor}` : ''}
                            {unit.unitArea ? ` · ${unit.unitArea} ${locale === 'en' ? 'm²' : 'م²'}` : ''}
                            {unit.unitStatus
                              ? ` · ${labels.unitStatus?.[unit.unitStatus as never] ?? unit.unitStatus}`
                              : ''}
                          </li>
                        );
                      })}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
