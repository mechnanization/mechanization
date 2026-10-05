'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import { Building2, Footprints, Grid3x3, ScanSearch, UserPlus } from 'lucide-react';
import { getLabels, seesAllStaffWork } from '@mechanization/shared-schemas';
import { getUnsurveyedUnits, type UnsurveyedUnitRow } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { CITIZEN_RECORD_EDIT_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useTabSearch, useUrlPagination } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { ActionTooltip } from '@/components/ui/tooltip';
import { BuildingUnitMatrixDrawer } from '@/components/admin/building-unit-matrix-drawer';
import { floorLabel } from '@/components/admin/building-unit-forms';

/**
 * «وحدات غير ممسوحة» — the units still waiting for someone to go in and
 * record who lives there: no survey answer yet, and no citizen linked.
 *
 * Each officer's own list. Units have no creator and nothing assigns them,
 * so an officer's units are those of the buildings they put on the census;
 * the roles that see all staff work (`seesAllStaffWork`) get everyone's, with
 * who added each building. The server narrows it — this page only says which.
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
  const en = locale === 'en';
  const base = `/${tenant}/${locale}/${adminPath}`;
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  // Taken as an admin until the session is read, so the header does not flip on every load.
  const seesAll = user ? seesAllStaffWork(user.role) : true;
  const canRegister = user ? hasRole(CITIZEN_RECORD_EDIT_ROLES, user.role) : false;

  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const [search, setSearch] = useTabSearch(tenant, 'buildings-unsurveyed');
  /** The unit whose building's matrix is open, if any. */
  const [matrix, setMatrix] = useState<{ buildingId: string; unitId: string } | null>(null);

  const query = useStaffQuery({
    queryKey: ['buildings', 'unsurveyed-units', tenant, search, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getUnsurveyedUnits(
        tenant,
        accessToken,
        {
          search: search || undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: en ? 'Could not load the unsurveyed units.' : 'تعذّر تحميل الوحدات غير الممسوحة.',
    keepPrevious: true,
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  // An empty list is the good outcome, so it says so.
  const tableLabels = useTableLabels(
    en
      ? {
          searchPlaceholder: 'Search by building code, name, parcel or unit',
          empty: 'Every unit has been surveyed.',
          emptyHint: seesAll
            ? 'No unit is waiting for a visit or for its residents.'
            : 'No unit in the buildings you added is waiting for a visit or for its residents.',
        }
      : {
          searchPlaceholder: 'ابحث برمز المبنى أو اسمه أو رقم العقار أو الوحدة',
          empty: 'كل الوحدات ممسوحة.',
          emptyHint: seesAll
            ? 'لا وحدة بانتظار زيارة أو تسجيل ساكنيها.'
            : 'لا وحدة في المباني التي أضفتَها بانتظار زيارة أو تسجيل ساكنيها.',
        },
  );

  const columns = useMemo<ColumnDef<UnsurveyedUnitRow>[]>(
    () => [
      {
        id: 'unit',
        header: en ? 'Unit' : 'الوحدة',
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
              <Building2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <bdi dir="ltr" className="font-mono">
                {row.original.buildingCode} · {row.original.unitCode}
              </bdi>
            </p>
            <p
              className="truncate ps-5 text-xs text-muted-foreground"
              title={row.original.buildingName ?? undefined}
            >
              {[
                row.original.buildingName,
                en ? `Parcel ${row.original.parcelNumber}` : `عقار ${row.original.parcelNumber}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        ),
      },
      {
        id: 'floor',
        header: en ? 'Floor' : 'الطابق',
        cell: ({ row }) => <span className="text-sm">{floorLabel(row.original.floor, en)}</span>,
      },
      {
        id: 'type',
        header: en ? 'Type' : 'النوع',
        cell: ({ row }) => (
          <span className="text-sm">{labels.unitType[row.original.unitType] ?? row.original.unitType}</span>
        ),
      },
      {
        id: 'survey',
        header: en ? 'Survey' : 'المسح',
        cell: ({ row }) => (
          <div className="space-y-0.5">
            <CellTag tone={row.original.surveyStatus === 'NOT_SURVEYED' ? 'muted' : 'warning'}>
              {labels.surveyStatus[row.original.surveyStatus] ?? row.original.surveyStatus}
            </CellTag>
            {/* The count, not the status: three unanswered doors are a different visit from none. */}
            {row.original.visitCount > 0 ? (
              <p className="flex items-center gap-1 text-xs text-muted-foreground">
                <Footprints className="size-3 shrink-0" aria-hidden />
                {en
                  ? `${row.original.visitCount} attempt${row.original.visitCount === 1 ? '' : 's'}`
                  : `${row.original.visitCount} محاولة`}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'lastVisit',
        header: en ? 'Last visit' : 'آخر زيارة',
        cell: ({ row }) =>
          row.original.lastVisitAt ? (
            <span className="text-sm tabular-nums">{formatDate(row.original.lastVisitAt)}</span>
          ) : (
            <CellTag tone="muted">{en ? 'Never' : 'لم تُزَر'}</CellTag>
          ),
      },
      ...(seesAll
        ? ([
            {
              id: 'addedBy',
              header: en ? 'Building added by' : 'أضاف المبنى',
              cell: ({ row }) =>
                row.original.addedByName ? (
                  <span className="text-sm">{row.original.addedByName}</span>
                ) : (
                  <CellTag tone="muted">—</CellTag>
                ),
            },
          ] satisfies ColumnDef<UnsurveyedUnitRow>[])
        : []),
      {
        id: 'actions',
        header: en ? 'Actions' : 'الإجراءات',
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const unit = row.original;
          const name = `${unit.buildingCode} · ${unit.unitCode}`;
          return (
            <div className="flex items-center justify-end gap-1.5">
              <ActionTooltip label={en ? 'Open in the unit matrix' : 'فتح في مصفوفة الوحدات'}>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label={en ? `Open ${name} in the unit matrix` : `فتح ${name} في مصفوفة الوحدات`}
                  onClick={() => setMatrix({ buildingId: unit.buildingId, unitId: unit.unitId })}
                >
                  <Grid3x3 className="size-4" aria-hidden />
                </Button>
              </ActionTooltip>
              {canRegister ? (
                <ActionTooltip label={en ? 'Register a citizen in this unit' : 'تسجيل مواطن في هذه الوحدة'}>
                  <Link
                    href={`${base}/citizens/new?buildingId=${encodeURIComponent(unit.buildingId)}&unitId=${encodeURIComponent(unit.unitId)}&residence=RESIDENT`}
                    aria-label={en ? `Register a citizen in ${name}` : `تسجيل مواطن في ${name}`}
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
    [en, base, labels, seesAll, canRegister],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={ScanSearch}
        title={en ? 'Unsurveyed units' : 'وحدات غير ممسوحة'}
        subtitle={
          en
            ? `${seesAll ? 'Units in every building' : 'Units in the buildings you added'} with no survey answer and nobody registered in them yet — building by building, top floor down.`
            : `${seesAll ? 'وحدات في كل المباني' : 'وحدات في المباني التي أضفتَها'} لم يُسجَّل مسحها ولا ساكنوها بعد — مبنى مبنى، من الطابق الأعلى نزولاً.`
        }
      />

      <Card className="overflow-hidden">
        <CardHeader className="border-b px-4 py-3.5 sm:px-6">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <ScanSearch className="size-5 text-warning" aria-hidden />
            {en ? 'Waiting for a visit' : 'بانتظار الزيارة'}
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

      {token ? (
        <BuildingUnitMatrixDrawer
          open={matrix !== null}
          onClose={() => setMatrix(null)}
          tenant={tenant}
          token={token}
          buildingId={matrix?.buildingId ?? null}
          focusUnitId={matrix?.unitId ?? null}
          canWrite={canRegister}
          // A visit or an occupancy logged there can take the unit off this list.
          onChanged={() => void query.refetch()}
          registerHref={(buildingId, unitId, residence) =>
            `${base}/citizens/new?buildingId=${encodeURIComponent(buildingId)}&unitId=${encodeURIComponent(unitId)}&residence=${residence}`
          }
          citizenHref={(citizenId) => `${base}/citizens/${citizenId}`}
          locale={locale}
        />
      ) : null}
    </div>
  );
}
