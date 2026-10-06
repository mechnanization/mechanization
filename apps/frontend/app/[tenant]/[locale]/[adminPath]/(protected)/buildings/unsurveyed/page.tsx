'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, CalendarClock, Footprints, Grid3x3, ScanSearch, UserPlus } from 'lucide-react';
import { getLabels, seesAllStaffWork } from '@mechanization/shared-schemas';
import { getUnsurveyedUnits, type UnsurveyedUnitRow } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { CITIZEN_RECORD_EDIT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ActionTooltip } from '@/components/ui/tooltip';
import { floorLabel } from '@/components/admin/building-unit-forms';
import { WORKLIST_OWNER_PARAM, WorklistOwnerFilter } from '@/components/admin/worklist-owner-filter';

/** Whose work, in the URL — see `WorklistOwnerFilter`. */
const URL_STATE = { owner: WORKLIST_OWNER_PARAM };

/**
 * «وحدات غير ممسوحة» — the units still waiting for someone to go in and
 * record who lives there: no survey answer yet, nobody recorded in them, and
 * no reading saying nobody can live there (that flat waits for a re-inspection
 * instead — «بانتظار إعادة الكشف»).
 *
 * Each officer's own list. Units have no creator and nothing assigns them,
 * so an officer's units are those of the buildings they put on the census;
 * the roles that see all staff work (`seesAllStaffWork`) get everyone's, with
 * who added each building, and may narrow to one officer or to buildings whose
 * officer is gone. The server narrows it — this page only says which.
 *
 * Ordered the way a round is walked, building by building, top floor down.
 * From a row the officer opens that unit in its building's matrix (to log the
 * visit, confirm it empty, add who lives there) or goes straight to a new
 * file pointed at it.
 */
export default function UnsurveyedUnitsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const t = useTranslations('unsurveyed');
  const en = locale === 'en';
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  // Taken as an admin until the session is read, so the header does not flip on every load.
  const seesAll = user ? seesAllStaffWork(user.role) : true;
  const canRegister = user ? hasRole(CITIZEN_RECORD_EDIT_ROLES, user.role) : false;

  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const [search, setSearch] = useTabSearch(tenant, 'buildings-unsurveyed');
  const [{ owner }, setUrl] = useUrlState(URL_STATE);
  const narrow = (next: string) => {
    setUrl({ owner: next });
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const query = useStaffQuery({
    queryKey: ['buildings', tenant, 'unsurveyed-units', search, owner, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getUnsurveyedUnits(
        tenant,
        accessToken,
        {
          search: search || undefined,
          owner: seesAll && owner ? owner : undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    keepPrevious: true,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const ownerName = owner ? (items.find((row) => row.addedById === owner)?.addedByName ?? null) : null;

  // An empty list is the good outcome, so it says so.
  const tableLabels = useTableLabels({
    searchPlaceholder: t('searchPlaceholder'),
    empty: t('empty'),
    emptyHint: seesAll ? t('emptyHintAll') : t('emptyHintMine'),
  });

  const columns = useMemo<ColumnDef<UnsurveyedUnitRow>[]>(
    () => [
      {
        id: 'unit',
        header: t('columns.unit'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <bdi dir="ltr" className="font-mono">
                {row.original.buildingCode} · {row.original.unitCode}
              </bdi>
            </p>
            <p className="truncate ps-5 text-xs text-muted-foreground" title={row.original.buildingName ?? undefined}>
              {[row.original.buildingName, t('parcel', { number: row.original.parcelNumber })]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        ),
      },
      {
        id: 'floor',
        header: t('columns.floor'),
        cell: ({ row }) => <span className="text-sm">{floorLabel(row.original.floor, en)}</span>,
      },
      {
        id: 'type',
        header: t('columns.type'),
        cell: ({ row }) => (
          <span className="text-sm">{labels.unitType[row.original.unitType] ?? row.original.unitType}</span>
        ),
      },
      {
        id: 'survey',
        header: t('columns.survey'),
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <CellTag tone={row.original.surveyStatus === 'NOT_SURVEYED' ? 'muted' : 'warning'}>
              {labels.surveyStatus[row.original.surveyStatus] ?? row.original.surveyStatus}
            </CellTag>
            {/* The count, not the status: three unanswered doors are a different visit from none. */}
            {row.original.visitCount > 0 ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Footprints className="size-3 shrink-0" aria-hidden />
                {t('attempts', { count: row.original.visitCount })}
              </p>
            ) : null}
            {/* A refused or unreachable door is already booked: the same door, on the cases list too. */}
            {row.original.openCaseType ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <CalendarClock className="size-3 shrink-0" aria-hidden />
                {row.original.scheduledRevisitAt
                  ? t('revisitBooked', { date: formatDate(row.original.scheduledRevisitAt) })
                  : t('caseOpen')}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'lastVisit',
        header: t('columns.lastVisit'),
        cell: ({ row }) =>
          row.original.lastVisitAt ? (
            <span className="text-sm tabular-nums">{formatDate(row.original.lastVisitAt)}</span>
          ) : (
            <CellTag tone="muted">{t('neverVisited')}</CellTag>
          ),
      },
      ...(seesAll
        ? ([
            {
              id: 'addedBy',
              header: t('columns.addedBy'),
              cell: ({ row }) =>
                row.original.addedByName && row.original.addedById ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-sm"
                    onClick={() => narrow(row.original.addedById!)}
                    aria-label={t('narrowTo', { name: row.original.addedByName })}
                  >
                    {row.original.addedByName}
                  </Button>
                ) : (
                  <CellTag tone="muted">—</CellTag>
                ),
            },
          ] satisfies ColumnDef<UnsurveyedUnitRow>[])
        : []),
      {
        id: 'actions',
        header: t('columns.actions'),
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const unit = row.original;
          const name = `${unit.buildingCode} · ${unit.unitCode}`;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <ActionTooltip label={t('openMatrix')}>
                {/* The full-page matrix, with `?unit=` selecting this unit there. */}
                <Link
                  href={`${base}/buildings/${encodeURIComponent(unit.buildingId)}/matrix?unit=${encodeURIComponent(unit.unitId)}`}
                  aria-label={t('openMatrixFor', { name })}
                  className={buttonVariants({ variant: 'outline', size: 'icon-sm' })}
                >
                  <Grid3x3 className="size-4" aria-hidden />
                </Link>
              </ActionTooltip>
              {canRegister ? (
                <ActionTooltip label={t('register')}>
                  <Link
                    href={`${base}/citizens/new?buildingId=${encodeURIComponent(unit.buildingId)}&unitId=${encodeURIComponent(unit.unitId)}&residence=RESIDENT`}
                    aria-label={t('registerIn', { name })}
                    className={cn(
                      buttonVariants({ variant: 'outline', size: 'icon-sm' }),
                      'border-primary/40 text-primary hover:bg-primary/5',
                    )}
                  >
                    <UserPlus className="size-4" aria-hidden />
                  </Link>
                </ActionTooltip>
              ) : null}
            </div>
          );
        },
      },
    ],
    // `narrow` closes over setters that never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, en, base, labels, seesAll, canRegister],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={ScanSearch} title={t('title')} subtitle={seesAll ? t('subtitleAll') : t('subtitleMine')} />

      {seesAll ? <WorklistOwnerFilter value={owner} onChange={narrow} ownerName={ownerName} /> : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <ScanSearch className="size-5 text-warning" aria-hidden />
            {t('waiting')}
            {query.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({total})</span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* One frame: the card's (BAN-4). */}
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.unitId}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<ScanSearch className="size-10 text-muted-foreground/60" />}
            manualPagination
            manualFiltering
            sortable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            searchValue={search}
            onSearchChange={setSearch}
          />
        </CardContent>
      </Card>
    </div>
  );
}
