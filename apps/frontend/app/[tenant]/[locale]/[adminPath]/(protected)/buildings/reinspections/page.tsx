'use client';

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, CalendarClock, Grid3x3 } from 'lucide-react';
import { getLabels, seesAllStaffWork, type ReinspectionRow } from '@mechanization/shared-schemas';
import { getReinspections } from '@/lib/api-client';
import { reinspectOverdue } from '@/lib/damage-reading';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ActionTooltip } from '@/components/ui/tooltip';
import { WORKLIST_OWNER_PARAM, WorklistOwnerFilter } from '@/components/admin/worklist-owner-filter';

/** Whose work, in the URL — see `WorklistOwnerFilter`. */
const URL_STATE = { owner: WORKLIST_OWNER_PARAM };

/**
 * «بانتظار إعادة الكشف» — the flats and structures whose current damage
 * reading says nobody can live in them, waiting for the visit after repair.
 *
 * The follow-up a re-inspection date needs: without a list, a planned day is
 * found only by opening the exact unit, and passes unnoticed. Each row's flat
 * is exempt from every fee until a visit reads it habitable (decisions of
 * 2026-10-05 and 2026-10-07), so a missed one is also a bill nobody issues. Planned days first, the most overdue
 * at the top, then the readings no day was set for. A whole-building reading is
 * one row, one visit — not one row per flat.
 *
 * Each officer sees the readings they recorded; the roles that see all staff
 * work see everyone's and may narrow to one officer or to readings whose
 * officer is gone. Gone from the list when the next reading of the target is
 * recorded — whatever it finds — from the matrix.
 */
export default function ReinspectionsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const t = useTranslations('reinspections');
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  const seesAll = user ? seesAllStaffWork(user.role) : true;

  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const [search, setSearch] = useTabSearch(tenant, 'buildings-reinspections');
  const [{ owner }, setUrl] = useUrlState(URL_STATE);
  const narrow = (next: string) => {
    setUrl({ owner: next });
    setPagination((current) => ({ ...current, pageIndex: 0 }));
  };

  const query = useStaffQuery({
    queryKey: ['buildings', tenant, 'reinspections', search, owner, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getReinspections(
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
  const overdue = query.data?.overdue ?? 0;
  const ownerName = owner ? (items.find((row) => row.assessedById === owner)?.assessedByName ?? null) : null;

  const tableLabels = useTableLabels({
    searchPlaceholder: t('searchPlaceholder'),
    empty: t('empty'),
    emptyHint: seesAll ? t('emptyHintAll') : t('emptyHintMine'),
  });

  const columns = useMemo<ColumnDef<ReinspectionRow>[]>(
    () => [
      {
        id: 'target',
        header: t('columns.target'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <bdi dir="ltr" className="font-mono">
                {row.original.unitCode ? `${row.original.buildingCode} · ${row.original.unitCode}` : row.original.buildingCode}
              </bdi>
            </p>
            <p className="truncate ps-5 text-xs text-muted-foreground" title={row.original.buildingName ?? undefined}>
              {[
                row.original.target === 'BUILDING' ? t('wholeBuilding') : null,
                row.original.buildingName,
                row.original.parcelNumber ? t('parcel', { number: row.original.parcelNumber }) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        ),
      },
      {
        id: 'level',
        header: t('columns.level'),
        cell: ({ row }) => (
          <CellTag tone="warning">
            {(labels.damageLevel as Record<string, string>)[row.original.level] ?? row.original.level}
          </CellTag>
        ),
      },
      {
        id: 'due',
        header: t('columns.due'),
        cell: ({ row }) => {
          const due = row.original.reinspectAt;
          if (!due) return <CellTag tone="muted">{t('noDate')}</CellTag>;
          return reinspectOverdue(due) ? (
            <CellTag tone="destructive">{t('overdue', { date: formatDate(due) })}</CellTag>
          ) : (
            <span className="text-sm tabular-nums">{formatDate(due)}</span>
          );
        },
      },
      {
        id: 'assessedAt',
        header: t('columns.assessedAt'),
        cell: ({ row }) => <span className="text-sm tabular-nums">{formatDate(row.original.assessedAt)}</span>,
      },
      ...(seesAll
        ? ([
            {
              id: 'assessedBy',
              header: t('columns.assessedBy'),
              cell: ({ row }) =>
                row.original.assessedByName && row.original.assessedById ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-sm"
                    onClick={() => narrow(row.original.assessedById!)}
                    aria-label={t('narrowTo', { name: row.original.assessedByName })}
                  >
                    {row.original.assessedByName}
                  </Button>
                ) : (
                  <CellTag tone="muted">—</CellTag>
                ),
            },
          ] satisfies ColumnDef<ReinspectionRow>[])
        : []),
      {
        id: 'actions',
        header: t('columns.actions'),
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const reading = row.original;
          const unit = reading.unitId ? `?unit=${encodeURIComponent(reading.unitId)}` : '';
          return (
            <div className="flex items-center justify-end">
              <ActionTooltip label={t('openMatrix')}>
                {/* Where the next reading is recorded — the matrix, on the flat itself when it is one. */}
                <Link
                  href={`${base}/buildings/${encodeURIComponent(reading.buildingId)}/matrix${unit}`}
                  aria-label={t('openMatrixFor', { name: reading.unitCode ?? reading.buildingCode })}
                  className={buttonVariants({ variant: 'outline', size: 'icon-sm' })}
                >
                  <Grid3x3 className="size-4" aria-hidden />
                </Link>
              </ActionTooltip>
            </div>
          );
        },
      },
    ],
    // `narrow` closes over setters that never change identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, base, labels, seesAll],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={CalendarClock} title={t('title')} />

      {seesAll ? <WorklistOwnerFilter value={owner} onChange={narrow} ownerName={ownerName} /> : null}

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold">
            <CalendarClock className="size-5 text-warning" aria-hidden />
            {t('waiting')}
            {query.data ? (
              <span className="text-sm font-normal tabular-nums text-muted-foreground">({total})</span>
            ) : null}
            {overdue > 0 ? <CellTag tone="destructive">{t('overdueCount', { count: overdue })}</CellTag> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable
            className="rounded-none border-0 shadow-none"
            columns={columns}
            data={items}
            labels={tableLabels}
            getRowId={(row) => row.assessmentId}
            loading={query.loading}
            error={query.error}
            onRetry={query.refetch}
            emptyIcon={<CalendarClock className="size-10 text-muted-foreground/60" />}
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
