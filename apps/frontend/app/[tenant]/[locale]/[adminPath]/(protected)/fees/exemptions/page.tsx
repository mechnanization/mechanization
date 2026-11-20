'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { Eye, Plus, ShieldCheck } from 'lucide-react';
import {
  FEE_EXEMPTION_LIST_STATUS,
  FEE_EXEMPTION_REASON,
  getLabels,
  type FeeExemptionListItem,
  type FeeExemptionReason,
} from '@mechanization/shared-schemas';
import { getFeeExemptionUnit, getFeeExemptions } from '@/lib/api-client';
import { formatDate, formatDay } from '@/lib/dates';
import { FEE_EXEMPTION_GRANT_ROLES, FEE_EXEMPTION_READ_ROLES, hasRole } from '@/lib/staff-roles';
import { applyUrlPatch, toSearch, type UrlValues } from '@/lib/url-state';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { AddFeeExemptionSheet } from '@/components/admin/fee-exemptions/add-fee-exemption-sheet';
import { FeeExemptionUnitCard } from '@/components/admin/fee-exemptions/fee-exemption-unit-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CellTag } from '@/components/ui/cell-tag';
import { DataTable } from '@/components/ui/data-table';
import { FilterSelect } from '@/components/ui/filter-controls';
import { PageHeader } from '@/components/ui/page-header';
import { ChipGroup } from '@/components/ui/segmented-control';
import { Sheet } from '@/components/ui/sheet';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';

/**
 * The list's state in the URL: which periods, the reason and the unit open in
 * the panel. Enums and an id only — the search term can hold a name and lives
 * in tab storage.
 */
const PAGE_URL = {
  status: param.oneOf(FEE_EXEMPTION_LIST_STATUS, 'OPEN'),
  reason: param.oneOf(['', ...FEE_EXEMPTION_REASON] as const, ''),
  unit: param.id(),
};
type PageUrl = UrlValues<typeof PAGE_URL>;

/**
 * «قائمة الإعفاء من الرسوم» — every unit exempt from fees, with its building,
 * parcel, type, who holds it now, the reason, the council's decision, who granted
 * it and when, and its last day; or, under «الإعفاءات المرفوعة», the periods
 * lifted, with who lifted them and why (migration 0104; the user's decisions of
 * 2026-11-16). Searched and paged on the server.
 *
 * Read by `FEE_EXEMPTION_READ_ROLES` (`GET fee-exemptions`): the list names the
 * people on the units, so it is never «مشاهد فقط», a collector or a field
 * inspector, and never the portal. The page sits under the `/fees` nav row and is
 * linked from the fees page; a role outside the set reaching it by its address is
 * told so here and the server refuses it anyway (CODE-4). Granting, amending and
 * lifting are the manager's (`FEE_EXEMPTION_GRANT_ROLES`), in the unit's panel and
 * in «إضافة إعفاء», which reaches the units through a person or a unit code.
 */
export default function FeeExemptionsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('feeExemptions');
  const tExemption = useTranslations('feeExemption');
  const tCommon = useTranslations('common');
  const labels = getLabels(locale);
  const { token, user } = useStaffSession(tenant, base);
  const canRead = user ? hasRole(FEE_EXEMPTION_READ_ROLES, user.role) : false;
  const canGrant = user ? hasRole(FEE_EXEMPTION_GRANT_ROLES, user.role) : false;

  const [url, setUrl] = useUrlState(PAGE_URL);
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 25 });
  const [search, setSearch] = useTabSearch(tenant, 'fee-exemptions');
  const [adding, setAdding] = useState(false);
  /** A new narrowing starts again from the first page, in the same URL write. */
  const narrow = (patch: Partial<PageUrl>) => setUrl(patch, { clear: ['page'] });

  const query = useStaffQuery({
    queryKey: ['fee-exemptions', tenant, url.status, url.reason, search, pagination.pageIndex, pagination.pageSize],
    queryFn: (accessToken, signal) =>
      getFeeExemptions(
        tenant,
        accessToken,
        {
          status: url.status,
          reason: url.reason || undefined,
          q: search || undefined,
          page: pagination.pageIndex + 1,
          pageSize: pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    // A role outside the set is refused by the server; it is not asked.
    token: canRead ? token : null,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;

  // ── the unit panel, pushed onto history like «طلبات المعاملات» ──────────────

  const pushed = useRef(false);
  useEffect(() => {
    const onPop = () => {
      pushed.current = false;
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const openUnit = useCallback((id: string) => {
    const current = new URLSearchParams(window.location.search);
    const href = `${window.location.pathname}${toSearch(applyUrlPatch(current, PAGE_URL, { unit: id }))}`;
    if (current.get('unit')) {
      window.history.replaceState(null, '', href);
    } else {
      window.history.pushState(null, '', href);
      pushed.current = true;
    }
  }, []);

  const closeUnit = () => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
      return;
    }
    setUrl({ unit: '' });
  };

  const unit = useStaffQuery({
    queryKey: ['fee-exemption-unit', tenant, url.unit],
    queryFn: (accessToken, signal) => getFeeExemptionUnit(tenant, accessToken, url.unit, signal),
    tenant,
    base,
    token: canRead && url.unit ? token : null,
    errorMessage: t('unitLoadError'),
  });

  // ── the table ────────────────────────────────────────────────────────────────

  const filtered = Boolean(url.reason || search);
  const tableLabels = useTableLabels({
    loadError: t('loadError'),
    searchPlaceholder: t('searchPlaceholder'),
    empty: filtered ? t('emptyFiltered') : url.status === 'LIFTED' ? t('emptyLifted') : t('empty'),
    emptyHint: filtered ? t('emptyFilteredHint') : url.status === 'LIFTED' ? undefined : t('emptyHint'),
  });

  const lifted = url.status === 'LIFTED';
  const columns = useMemo<ColumnDef<FeeExemptionListItem>[]>(
    () => [
      {
        id: 'unit',
        header: t('columns.unit'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <bdi dir="ltr" className="block font-mono text-xs font-medium">
              {row.original.reference}
            </bdi>
            <span className="block text-xs text-muted-foreground">
              {row.original.unitType ? labels.unitType[row.original.unitType] : '—'}
            </span>
          </div>
        ),
      },
      {
        id: 'building',
        header: t('columns.building'),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5 text-sm">
            <span className="block max-w-48 truncate" title={row.original.building.name ?? undefined}>
              {row.original.building.name ?? <bdi dir="ltr">{row.original.building.code}</bdi>}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t('parcel', { number: row.original.building.parcelNumber })}
            </span>
          </div>
        ),
      },
      {
        id: 'holders',
        header: t('columns.holders'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) =>
          row.original.holders.length > 0 ? (
            <span className="block max-w-56 text-sm">
              {row.original.holders.map((holder) => holder.name).join('، ')}
            </span>
          ) : (
            <CellTag tone="muted">{t('noHolders')}</CellTag>
          ),
      },
      {
        id: 'reason',
        header: t('columns.reason'),
        meta: { cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <span className="block text-sm">{labels.feeExemptionReason[row.original.period.reason]}</span>
            {row.original.period.note ? (
              <span className="block max-w-56 truncate text-xs text-muted-foreground" title={row.original.period.note}>
                {row.original.period.note}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: 'decision',
        header: t('columns.decision'),
        meta: { mobile: 'hide' },
        cell: ({ row }) =>
          row.original.period.decisionRef ? (
            <CellTag className="font-mono" dir="ltr">
              {row.original.period.decisionRef}
            </CellTag>
          ) : (
            <CellTag tone="muted">—</CellTag>
          ),
      },
      {
        id: 'granted',
        header: t('columns.granted'),
        meta: { mobile: 'hide' },
        cell: ({ row }) => (
          <div className="space-y-0.5 text-sm">
            <span className="block whitespace-nowrap tabular-nums">{formatDate(row.original.period.grantedAt)}</span>
            <span className="block text-xs text-muted-foreground">
              {row.original.period.grantedBy?.name ?? tExemption('unknownGrantor')}
            </span>
          </div>
        ),
      },
      lifted
        ? {
            id: 'lifted',
            header: t('columns.lifted'),
            meta: { cellClassName: 'whitespace-normal' },
            cell: ({ row }) => (
              <div className="space-y-0.5 text-sm">
                <span className="block whitespace-nowrap tabular-nums">
                  {row.original.period.liftedAt ? formatDate(row.original.period.liftedAt) : '—'}
                </span>
                <span className="block max-w-56 truncate text-xs text-muted-foreground" title={row.original.period.liftReason ?? undefined}>
                  {[row.original.period.liftedBy?.name, row.original.period.liftReason].filter(Boolean).join(' — ')}
                </span>
              </div>
            ),
          }
        : {
            id: 'until',
            header: t('columns.until'),
            cell: ({ row }) =>
              row.original.period.validUntil ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="whitespace-nowrap text-sm tabular-nums">{formatDay(row.original.period.validUntil)}</span>
                  {/* The word carries the state; the colour only repeats it (COL-3). */}
                  {row.original.ended ? <Badge variant="soft-warning">{t('ended')}</Badge> : null}
                </div>
              ) : (
                <CellTag tone="muted">{tExemption('noEnd')}</CellTag>
              ),
          },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 text-xs max-sm:w-full"
            aria-label={t('openOf', { reference: row.original.reference })}
            onClick={() => openUnit(row.original.unitId)}
          >
            <Eye className="size-3.5" aria-hidden />
            {t('open')}
          </Button>
        ),
      },
    ],
    [t, tExemption, labels, lifted, openUnit],
  );

  if (user && !canRead) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />
        <PageHeader icon={ShieldCheck} title={t('title')} />
        <EmptyState title={t('noAccess')} description={t('noAccessHint')} />
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />

      <PageHeader
        icon={ShieldCheck}
        title={t('title')}
        actions={
          canGrant ? (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" aria-hidden />
              {t('add')}
            </Button>
          ) : null
        }
      />

      <ChipGroup
        size="sm"
        aria-label={t('statusFilter')}
        value={url.status}
        onChange={(value) => narrow({ status: value as PageUrl['status'] })}
        options={[
          { value: 'OPEN', label: t('statusOpen') },
          { value: 'LIFTED', label: t('statusLifted') },
        ]}
      />

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={items}
        labels={tableLabels}
        getRowId={(row) => row.period.id}
        loading={query.loading || !user}
        error={query.error}
        onRetry={query.refetch}
        emptyIcon={<ShieldCheck className="size-10 text-muted-foreground/60" />}
        manualPagination
        manualFiltering
        sortable={false}
        pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
        totalRowCount={total}
        pagination={pagination}
        onPaginationChange={setPagination}
        searchValue={search}
        onSearchChange={(term) => {
          setSearch(term);
          setPagination((current) => (current.pageIndex === 0 ? current : { ...current, pageIndex: 0 }));
        }}
        activeFiltersCount={url.reason ? 1 : 0}
        onClearFilters={() => narrow({ reason: '' })}
        filterBar={
          <FilterSelect
            label={t('reasonFilter')}
            value={url.reason}
            onChange={(value) => narrow({ reason: value as FeeExemptionReason | '' })}
            allLabel={t('allReasons')}
            options={FEE_EXEMPTION_REASON.map((value) => ({ value, label: labels.feeExemptionReason[value] }))}
          />
        }
      />

      <Sheet
        open={Boolean(url.unit)}
        onClose={closeUnit}
        title={unit.data ? t('unitTitle', { reference: unit.data.reference }) : t('unitLoading')}
        closeLabel={t('close')}
      >
        {unit.error && !unit.data ? (
          <ErrorState compact title={unit.error} onRetry={unit.refetch} retryLabel={tCommon('retry')} />
        ) : unit.data ? (
          <FeeExemptionUnitCard tenant={tenant} token={token} locale={locale} unit={unit.data} canGrant={canGrant} />
        ) : (
          <LoadingState compact label={t('unitLoading')} />
        )}
      </Sheet>

      {canGrant ? (
        <AddFeeExemptionSheet
          open={adding}
          onClose={() => setAdding(false)}
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          canGrant={canGrant}
        />
      ) : null}
    </div>
  );
}
