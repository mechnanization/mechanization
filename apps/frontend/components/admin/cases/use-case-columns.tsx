'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import { CalendarClock, CheckCircle2, Grid3x3, Link2, Pencil, RotateCcw, Trash2, UserPlus } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { caseResidents, type CaseSummary } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { ActionTooltip } from '@/components/ui/tooltip';

/**
 * The cases table's columns — what happened, the property, its status, who
 * logged it and when — and the row's actions, which act through the callbacks
 * the page passes in. `canWrite` hides every action; `canDelete` the delete.
 */
export function useCaseColumns({
  locale,
  base,
  busyId,
  canWrite,
  canDelete,
  advanceStatus,
  openLink,
  setMatrix,
  setPendingDelete,
}: {
  locale: string;
  base: string;
  /** The case a status change or delete is in flight on; its row's actions are disabled. */
  busyId: string | null;
  canWrite: boolean;
  canDelete: boolean;
  advanceStatus: (item: CaseSummary) => Promise<void>;
  openLink: (item: CaseSummary | null) => void;
  setMatrix: (next: { buildingId: string; unitId: string | null } | null) => void;
  setPendingDelete: (item: CaseSummary | null) => void;
}): ColumnDef<CaseSummary>[] {
  const router = useRouter();
  const labels = getLabels(locale);

  return useMemo<ColumnDef<CaseSummary>[]>(
    () => [
      {
        accessorKey: 'notes',
        header: locale === 'en' ? 'What happened' : 'ماذا حصل',
        cell: ({ row }) => (
          <span className="block max-w-xs truncate" title={row.original.notes}>
            {row.original.notes}
          </span>
        ),
      },
      {
        // The property's identifier — the census code and the flat when the
        // case is pinned to them, else the number the officer wrote at the door.
        accessorKey: 'propertyNumber',
        header: locale === 'en' ? 'Property ID' : 'رقم العقار',
        cell: ({ row }) => {
          const item = row.original;
          const id = item.buildingCode
            ? item.unitCode
              ? `${item.buildingCode} · ${item.unitCode}`
              : item.buildingCode
            : item.propertyNumber;
          return id ? (
            <CellTag className="font-mono" dir="ltr" title={item.neighborhood ?? undefined}>
              {id}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          );
        },
      },
      {
        accessorKey: 'status',
        header: locale === 'en' ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const item = row.original;
          return (
            <div className="space-y-1">
              {item.status === 'RESOLVED' ? (
                <CellTag tone="success">
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  {labels.caseStatus.RESOLVED}
                </CellTag>
              ) : item.status === 'SCHEDULED' ? (
                <CellTag tone="warning">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {labels.caseStatus.SCHEDULED}
                </CellTag>
              ) : (
                <CellTag>{labels.caseStatus.OPEN}</CellTag>
              )}
              {/* The date is what «مجدولة» means; a status without it is a
                  promise nobody can plan around. */}
              {item.scheduledRevisitAt ? (
                <p className="text-xs text-muted-foreground">
                  {locale === 'en' ? 'Revisit ' : 'العودة '}
                  {formatDate(item.scheduledRevisitAt)}
                </p>
              ) : null}
              {item.resolvedCitizenName ? (
                <button
                  type="button"
                  onClick={() =>
                    router.push(`${base}/citizens/${item.resolvedCitizenId}`)
                  }
                  className="flex items-center gap-1 text-xs text-primary underline-offset-2 hover:underline"
                >
                  <Link2 className="size-3 shrink-0" aria-hidden />
                  {item.resolvedCitizenName}
                </button>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'createdByName',
        header: locale === 'en' ? 'Logged By' : 'سجّلها',
        cell: ({ row }) => row.original.createdByName ?? <span className="text-muted-foreground text-xs">—</span>,
      },
      {
        accessorKey: 'createdAt',
        header: locale === 'en' ? 'Date' : 'التاريخ',
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      {
        id: 'actions',
        header: locale === 'en' ? 'Actions' : 'إجراء',
        enableSorting: false,
        meta: { mobile: 'actions' },
        cell: ({ row }) => {
          const item = row.original;
          const busy = busyId === item.id;
          const residents = caseResidents(item);
          const occupied = residents.length > 0;
          const who = residents
            .map((person) => `${person.name} (${labels.occupancyType[person.role as never] ?? person.role})`)
            .join(locale === 'en' ? ', ' : '، ');
          const registerBlocked =
            locale === 'en'
              ? `Someone already lives on this unit, registered: ${who} — link the case to them instead.`
              : `الوحدة مسكونة ومسجَّلة: ${who} — اربط الحالة به بدلاً من تسجيل مواطن جديد.`;

          if (!canWrite) return null;

          return (
            <div className="flex items-center gap-1.5">
              {item.status === 'OPEN' ? (
                occupied ? (
                  /*
                    The flat is already owned, rented or lent to a registered
                    citizen: registering somebody new from the case would file a
                    second household on it. Closed, and the tooltip says who is
                    there and what to do instead. A focusable wrapper, because a
                    disabled button shows no tooltip and takes no focus.
                  */
                  <ActionTooltip label={registerBlocked}>
                    <span tabIndex={0} aria-label={registerBlocked} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-hidden
                        tabIndex={-1}
                        disabled
                        className="pointer-events-none"
                      >
                        <UserPlus className="size-4" aria-hidden />
                      </Button>
                    </span>
                  </ActionTooltip>
                ) : (
                <ActionTooltip label={locale === 'en' ? 'Register Citizen' : 'تسجيل المواطن'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    className="border-primary/40 text-primary hover:bg-primary/5"
                    aria-label={locale === 'en' ? 'Register Citizen' : 'تسجيل المواطن'}
                    disabled={busy}
                    onClick={() => router.push(`${base}/citizens/new?fromCaseId=${item.id}`)}
                  >
                    <UserPlus className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
                )
              ) : null}

              <ActionTooltip
                label={
                  occupied
                    ? locale === 'en'
                      ? `Link to a citizen — on this unit: ${who}`
                      : `ربط بمواطن — على الوحدة: ${who}`
                    : locale === 'en'
                      ? 'Link to Citizen'
                      : 'ربط بمواطن'
                }
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Link to Citizen' : 'ربط بمواطن'}
                  disabled={busy}
                  onClick={() => openLink(item)}
                >
                  <Link2 className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>

              {/* One tap, one step along OPEN → SCHEDULED → RESOLVED. The
                  label names where it goes, never where it is. */}
              <ActionTooltip
                label={
                  item.status === 'OPEN'
                    ? locale === 'en'
                      ? 'Schedule a revisit'
                      : 'جدولة زيارة'
                    : item.status === 'SCHEDULED'
                      ? locale === 'en'
                        ? 'Mark resolved'
                        : 'وضع علامة مُعالجة'
                      : locale === 'en'
                        ? 'Reopen'
                        : 'إعادة فتح'
                }
              >
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Advance status' : 'تقديم حالة المعاملة'}
                  disabled={busy}
                  onClick={() => void advanceStatus(item)}
                >
                  {item.status === 'OPEN' ? (
                    <CalendarClock className="size-4" aria-hidden />
                  ) : item.status === 'SCHEDULED' ? (
                    <CheckCircle2 className="size-4" aria-hidden />
                  ) : (
                    <RotateCcw className="size-4" aria-hidden />
                  )}
                </Button>
              </ActionTooltip>

              {/* A case pinned to a censused structure opens its matrix — the
                  fastest route from "somebody should go back" to the flat. */}
              {item.buildingId ? (
                <ActionTooltip label={locale === 'en' ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Open the unit matrix' : 'فتح مصفوفة الوحدات'}
                    disabled={busy}
                    onClick={() => setMatrix({ buildingId: item.buildingId!, unitId: item.unitId })}
                  >
                    <Grid3x3 className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}

              <ActionTooltip label={locale === 'en' ? 'Edit' : 'تعديل'}>
                <Button
                  variant="secondary"
                  size="icon-sm"
                  aria-label={locale === 'en' ? 'Edit' : 'تعديل'}
                  disabled={busy}
                  onClick={() => router.push(`${base}/cases/${item.id}/edit`)}
                >
                  <Pencil className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>

              {canDelete ? (
                <ActionTooltip label={locale === 'en' ? 'Delete' : 'حذف'}>
                  <Button
                    variant="outline"
                    size="icon-sm"
                    aria-label={locale === 'en' ? 'Delete' : 'حذف'}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    disabled={busy}
                    onClick={() => setPendingDelete(item)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
          );
        },
      },
    ],
    [busyId, canWrite, canDelete, locale, labels, advanceStatus, router, base, setMatrix, openLink, setPendingDelete],
  );
}
