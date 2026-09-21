'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  ChevronLeft,
  Coins,
  MapPin,
  Phone,
  Search,
  User,
  Users,
  X,
} from 'lucide-react';
import type { RegisteredParcel } from '@/lib/api-client';
import { getLabels } from '@mechanization/shared-schemas';
import { formatLbp, formatLbpCompact } from '@/lib/currency';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Arabic counts, which do not inflect the way English ones do.
 *
 * مواطن واحد / مواطنان / ٢ مواطنين / ٢٠ مواطناً — four forms, chosen by
 * the number rather than by whether it is one. Written once because the drawer
 * counts two different things in the same breath and the branching was
 * identical both times; getting it wrong in one place and right in the other
 * is the mistake this prevents.
 */
function countAr(n: number, forms: { one: string; two: string; few: string; many: string }): string {
  if (n === 1) return forms.one;
  if (n === 2) return forms.two;
  return n <= 10 ? `${n} ${forms.few}` : `${n} ${forms.many}`;
}

export function CitizenDetailDrawer({
  parcel,
  citizenHref,
  onClose,
  locale = 'ar',
}: {
  parcel: RegisteredParcel | null;
  /** Builds the tenant-scoped profile URL for a citizen id. */
  citizenHref: (citizenId: string) => string;
  onClose: () => void;
  locale?: string;
}) {
  const isEnglish = locale === 'en';
  const labels = getLabels(locale);
  const [query, setQuery] = useState('');
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (!parcel) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [parcel, onClose]);

  useEffect(() => {
    if (!parcel) return;
    setQuery('');
    headingRef.current?.focus();
  }, [parcel]);

  const registrants = parcel?.registrants ?? [];
  const financials = parcel?.financials;

  const filtered = useMemo(() => {
    const list = parcel?.registrants ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) return list;
    return list.filter(
      (registrant) =>
        registrant.fullName.toLowerCase().includes(needle) ||
        (registrant.phone ?? '').includes(needle),
    );
  }, [parcel?.registrants, query]);

  if (!parcel) return null;

  const citizenCount = registrants.length;
  const structureCount =
    parcel.structureCount ??
    registrants.reduce((sum, r) => sum + (r.structures?.length || 1), 0);

  const citizenText = isEnglish
    ? `${citizenCount} registered citizen${citizenCount === 1 ? '' : 's'}`
    : countAr(citizenCount, {
        one: 'مواطن واحد مسجّل',
        two: 'مواطنان مسجّلان',
        few: 'مواطنين مسجّلين',
        many: 'مواطناً مسجّلاً',
      });

  const structureText = isEnglish
    ? `${structureCount} structure${structureCount === 1 ? '' : 's'}`
    : countAr(structureCount, {
        one: 'عقار واحد',
        two: 'عقاران',
        few: 'عقارات',
        many: 'عقاراً',
      });

  const headerSubtitle = `${citizenText} • ${structureText}`;

  // Parcel-level financial status helpers
  const totalBilled = financials?.totalBilled ?? 0;
  const totalPaid = financials?.totalPaid ?? 0;
  const totalDue = financials?.totalDue ?? 0;
  const status = financials?.status ?? 'NO_BILLS';

  return (
    <section
      aria-label={
        isEnglish
          ? `Registrants on Parcel ${parcel.propertyNumber}`
          : `المسجّلون على العقار ${parcel.propertyNumber}`
      }
      className={cn(
        'absolute z-30 flex flex-col overflow-hidden bg-card shadow-2xl duration-300 animate-in border-border/80',
        'inset-x-0 bottom-0 max-h-[75dvh] rounded-t-2xl border-t slide-in-from-bottom',
        'sm:inset-y-0 sm:inset-x-auto sm:end-0 sm:max-h-none sm:w-[22rem] sm:rounded-none sm:border-s sm:border-t-0 sm:slide-in-from-bottom-0 sm:slide-in-from-right',
      )}
    >
      <div
        aria-hidden
        className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-border sm:hidden"
      />

      {/* Header */}
      <header className="flex shrink-0 items-start justify-between gap-3 border-b p-4 bg-muted/20">
        <div className="flex items-center gap-3 min-w-0">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary shadow-2xs"
          >
            <MapPin className="size-5" />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="truncate text-base font-bold leading-tight outline-none"
              >
                {isEnglish ? 'Parcel ' : 'العقار '}
                <span dir="ltr">#{parcel.propertyNumber}</span>
              </h2>
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="size-3.5 shrink-0" aria-hidden />
              <span>{headerSubtitle}</span>
            </p>
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={isEnglish ? 'Close' : 'إغلاق'}
          className="-me-1 size-8 shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
        >
          <X className="size-4" aria-hidden />
        </Button>
      </header>

      {/* Scrollable Content Container */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 space-y-3">
        {/* Top Financial Summary Card */}
        <div className="rounded-xl border border-border/80 bg-gradient-to-br from-card to-muted/30 p-3.5 shadow-xs space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-bold text-foreground">
              <Coins className="size-4 text-primary" />
              {isEnglish ? 'Parcel Fees & Bills' : 'إجمالي الرسوم والمطالبات'}
            </span>

            {status === 'PAID' ? (
              <Badge variant="soft-success" className="gap-1 px-2 py-0.5 text-xs font-semibold">
                <CheckCircle2 className="size-3" />
                {isEnglish ? 'Fully Paid' : 'مسدد بالكامل'}
              </Badge>
            ) : status === 'PARTIALLY_PAID' ? (
              <Badge variant="soft-warning" className="px-2 py-0.5 text-xs font-semibold">
                {isEnglish ? 'Partially Paid' : 'مسدد جزئياً'}
              </Badge>
            ) : status === 'UNPAID' ? (
              <Badge variant="soft-destructive" className="px-2 py-0.5 text-xs font-semibold">
                {isEnglish ? 'Unpaid' : 'غير مسدد'}
              </Badge>
            ) : (
              <Badge variant="soft-muted" className="px-2 py-0.5 text-xs">
                {isEnglish ? 'No Bills' : 'لا توجد رسوم'}
              </Badge>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1 border-t border-border/50 text-center">
            <div className="rounded-lg bg-muted/40 p-2">
              <p className="text-xs text-muted-foreground">
                {isEnglish ? 'Total' : 'الإجمالي'}
              </p>
              <p className="mt-0.5 text-xs font-bold text-foreground" title={formatLbp(totalBilled, locale)}>
                {totalBilled > 0 ? formatLbpCompact(totalBilled, locale) : '—'}
              </p>
            </div>

            <div className="rounded-lg bg-success/10 p-2">
              <p className="text-xs text-success">
                {isEnglish ? 'Paid' : 'المسدد'}
              </p>
              <p className="mt-0.5 text-xs font-bold text-success" title={formatLbp(totalPaid, locale)}>
                {totalPaid > 0 ? formatLbpCompact(totalPaid, locale) : '0'}
              </p>
            </div>

            <div className={cn(
              'rounded-lg p-2',
              totalDue > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted/40 text-muted-foreground'
            )}>
              <p className="text-xs">
                {isEnglish ? 'Remaining' : 'المتبقي'}
              </p>
              <p className="mt-0.5 text-xs font-bold" title={formatLbp(totalDue, locale)}>
                {totalDue > 0 ? formatLbpCompact(totalDue, locale) : (totalBilled > 0 ? '0' : '—')}
              </p>
            </div>
          </div>
        </div>

        {/* Search inside the sidebar */}
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-3.5 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={isEnglish ? 'Search by name or phone…' : 'ابحث بالاسم أو الهاتف…'}
            className="h-8.5 ps-8 text-xs bg-muted/40 rounded-lg border-border/80"
          />
        </div>

        {/* Occupants Section Title */}
        <div className="flex items-center justify-between px-1 pt-0.5">
          <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
            {isEnglish ? 'Registered Citizens' : 'المسجلون على هذا العقار'} ({filtered.length})
          </span>
        </div>

        {/* Occupants List */}
        {filtered.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {isEnglish ? 'No matching occupants found.' : 'لا نتائج مطابقة للبحث.'}
          </p>
        ) : (
          <div className="divide-y divide-border/70 rounded-xl border border-border/80 bg-card overflow-hidden shadow-xs">
            {filtered.map((registrant, idx) => (
              <Link
                key={registrant.citizenId || registrant.registrationId || idx}
                href={citizenHref(registrant.citizenId)}
                title={isEnglish ? `View profile of ${registrant.fullName}` : `عرض ملف ${registrant.fullName}`}
                className="group block px-3 py-2.5 transition-colors hover:bg-accent/60 cursor-pointer text-start"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary transition-transform group-hover:scale-105">
                      <User className="size-4" />
                    </span>

                    <span className="truncate text-xs font-bold text-foreground group-hover:text-primary transition-colors">
                      {registrant.fullName}
                    </span>

                    {registrant.phone ? (
                      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground shrink-0 ms-auto font-mono" dir="ltr">
                        <Phone className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
                        <span>{registrant.phone}</span>
                      </span>
                    ) : null}
                  </div>

                  <ChevronLeft
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground/60 transition-transform group-hover:-translate-x-0.5 rtl:rotate-180 rtl:group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </div>

                {/* Structures registered for this citizen on this parcel */}
                {registrant.structures && registrant.structures.length > 0 ? (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 ps-[2.625rem]">
                    {registrant.structures.map((s, sIdx) => {
                      const typeLabel =
                        labels.propertyType[s.propertyType as keyof typeof labels.propertyType] ??
                        s.propertyType;
                      const occupancyLabel =
                        labels.occupancyType[s.occupancyType as keyof typeof labels.occupancyType] ??
                        s.occupancyType;
                      const displayName = s.buildingName ? `${typeLabel} (${s.buildingName})` : typeLabel;

                      return (
                        <span
                          key={s.id || sIdx}
                          className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-2 py-0.5 text-xs font-medium text-foreground/85 border border-border/60"
                        >
                          <span>{displayName}</span>
                          {s.unitCount > 0 ? (
                            <span className="text-muted-foreground font-mono">
                              • {s.unitCount} {isEnglish ? 'units' : 'وحدات'}
                            </span>
                          ) : null}
                          <span className="text-muted-foreground/70 text-[9px]">
                            ({occupancyLabel})
                          </span>
                        </span>
                      );
                    })}
                  </div>
                ) : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}