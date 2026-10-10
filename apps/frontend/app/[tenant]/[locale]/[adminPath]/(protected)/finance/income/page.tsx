'use client';

import { use, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CircleDollarSign, Plus, Tags } from 'lucide-react';
import { canReceiveIncome, TREASURY_ADMIN_ROLES, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getIncomeCategories,
  getIncomeVouchers,
  getTreasuryOverview,
  logApiError,
  voidIncomeVoucher,
  type IncomeVoucherView,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { incomeCategoryLabel } from '@/lib/income-category-label';
import { REGISTER_PERIODS, registerPeriodRange, type RegisterPeriod } from '@/lib/register-period';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { useTabSearch } from '@/lib/use-url-state';
import { cn } from '@/lib/utils';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { FilterSelect } from '@/components/ui/filter-controls';
import { PageHeader } from '@/components/ui/page-header';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

const PAGE_SIZE = 50;

/**
 * الإيرادات — money that reached the treasury without a citizen's bill, and the
 * «سند قبض» behind each figure. Design: docs/finance.md §4.
 *
 * The expense register's twin, laid out the same (UX-1): the totals of the
 * filtered set above, the register below, «تسجيل إيراد جديد» the one action. A
 * mistake is cancelled, never edited, and a cancelled voucher stays in the list
 * greyed and struck through, with its reason, rather than disappearing — an
 * auditor asking what happened to RV-2610-0004 is owed the answer, not a gap.
 *
 * Filters: a period (this month, last month, this year, last year), the
 * category, the currency and whether cancelled vouchers show; the search box
 * matches the voucher number, the payer, the description and the reference, on
 * the server, and commits on Enter. The term lives in tab storage, never the
 * URL (`useTabSearch`): it can hold a person's name.
 *
 * It has its own nav row, `/finance/income`, on `TREASURY_READ_ROLES`; the
 * server enforces the same three lists as the buttons here.
 */
export default function IncomePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.income');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);

  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const canVoid = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [search, setSearch] = useTabSearch(tenant, 'income');
  const [period, setPeriod] = useState<RegisterPeriod | ''>('');
  const [categoryId, setCategoryId] = useState('');
  const [currency, setCurrency] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [voiding, setVoiding] = useState<IncomeVoucherView | null>(null);

  const range = period ? registerPeriodRange(period) : null;

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  /*
    Stopped categories included: a voucher filed under one is still in the
    register, and a filter that could not name its category could not find it.
  */
  const categories = useStaffQuery({
    queryKey: ['treasury', tenant, 'income-categories', 'all'],
    queryFn: (accessToken, signal) =>
      getIncomeCategories(tenant, accessToken, { includeInactive: true }, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const list = useStaffQuery({
    queryKey: ['treasury', tenant, 'income', search, range?.from, range?.to, categoryId, currency, includeVoid],
    queryFn: (accessToken, signal) =>
      getIncomeVouchers(
        tenant,
        accessToken,
        {
          search: search || undefined,
          from: range?.from,
          to: range?.to,
          categoryId: categoryId || undefined,
          currency: currency || undefined,
          includeVoid,
          pageSize: PAGE_SIZE,
        },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });

  /** The currencies a voucher can be in: those of the wallets that may receive income. */
  const currencies = useMemo(() => {
    const seen = new Set<string>();
    for (const account of overview.data?.accounts ?? []) {
      if (canReceiveIncome(account.type)) seen.add(account.currency);
    }
    return [...seen].sort();
  }, [overview.data]);

  const tableLabels = useTableLabels({
    empty: t('empty'),
    emptyHint: t('emptyHint'),
    searchAriaLabel: t('searchPlaceholder'),
    searchPlaceholder: t('searchPlaceholder'),
  });

  const columns = useMemo<ColumnDef<IncomeVoucherView>[]>(
    () => [
      {
        id: 'voucher',
        header: t('columns.voucher'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => {
          const voucher = row.original;
          return (
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* A voucher number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */}
                <span dir="ltr" className="font-mono text-xs font-medium">
                  {voucher.voucherNumber}
                </span>
                {voucher.status === 'VOID' ? <Badge variant="soft-warning">{t('cancelled')}</Badge> : null}
              </div>
              <p className="line-clamp-2 text-xs text-muted-foreground">{voucher.description}</p>
              {voucher.status === 'VOID' && voucher.voidReason ? (
                <p className="text-xs text-muted-foreground">{t('voidReasonLine', { reason: voucher.voidReason })}</p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.occurredAt)}</span>,
      },
      {
        id: 'category',
        header: t('columns.category'),
        cell: ({ row }) => <span className="text-sm">{incomeCategoryLabel(row.original.category, locale)}</span>,
      },
      {
        id: 'payer',
        header: t('columns.payer'),
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm">{row.original.payerName ?? '—'}</p>
            {row.original.externalReference ? (
              <p dir="ltr" className="font-mono text-xs text-muted-foreground">
                {row.original.externalReference}
              </p>
            ) : null}
          </div>
        ),
      },
      {
        id: 'account',
        header: t('columns.account'),
        cell: ({ row }) => <span className="text-sm">{row.original.account.name}</span>,
      },
      {
        id: 'amount',
        header: t('columns.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.amount}
            currency={row.original.currency}
            locale={locale}
            /*
              A cancelled voucher brought nothing in the end, so its figure is
              struck through as well as dimmed: the strike is the signal that
              survives a greyscale screen and a printout (COL-3).
            */
            className={cn('font-semibold', row.original.status === 'VOID' && 'text-muted-foreground line-through')}
          />
        ),
      },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) =>
          canVoid && row.original.status === 'RECORDED' ? (
            <Button variant="ghost" size="sm" className="max-sm:w-full" onClick={() => setVoiding(row.original)}>
              <Ban className="size-4" aria-hidden />
              {t('void')}
            </Button>
          ) : null,
      },
    ],
    [t, locale, canVoid],
  );

  const totals = list.data?.totals ?? [];
  const activeFilters = [period, categoryId, currency, includeVoid ? 'void' : ''].filter(Boolean).length;

  /* «المقبوض بالليرة», not «المقبوض بـ LBP»: a sentence, not a code glued to a preposition (TXT-5). */
  const receivedLabel = (code: string): string =>
    code === 'LBP' ? t('receivedInLBP') : code === 'USD' ? t('receivedInUSD') : t('receivedInOther', { currency: code });
  const currencyLabel = (code: string): string =>
    code === 'LBP' ? t('filters.currencyLBP') : code === 'USD' ? t('filters.currencyUSD') : code;

  const clearFilters = (): void => {
    setPeriod('');
    setCategoryId('');
    setCurrency('');
    setIncludeVoid(false);
  };

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={CircleDollarSign}
        title={t('title')}
        actions={
          <>
            {/* Readable by everyone here; the page offers its write controls to the manager only. */}
            <Button asChild variant="outline">
              <Link href={`${base}/finance/income/categories`}>
                <Tags className="size-4" aria-hidden />
                {t('manageCategories')}
              </Link>
            </Button>
            {canRecord && overview.data?.active ? (
              <Button asChild>
                <Link href={`${base}/finance/income/new`}>
                  <Plus className="size-4" aria-hidden />
                  {t('record')}
                </Link>
              </Button>
            ) : null}
          </>
        }
      />

      {overview.data && !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : null}

      {/*
        `ErrorState` only when nothing has loaded (STA-1). A re-read that fails
        with vouchers on screen — the refresh after a void, a refocus — keeps
        them, and says so above them.
      */}
      {list.error && !list.data ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={list.error} onRetry={list.refetch} retryLabel={tCommon('retry')} />
          </CardContent>
        </Card>
      ) : (
        <>
          {list.error ? <RefreshFailedAlert message={list.error} onRetry={list.refetch} /> : null}

          {totals.length > 0 ? (
            <StatStrip>
              {totals.map((total) => (
                <StatItem
                  key={total.currency}
                  label={receivedLabel(total.currency)}
                  value={<TreasuryAmount amount={total.amount} currency={total.currency} locale={locale} />}
                />
              ))}
              <StatItem label={t('voucherCount')} value={String(list.data?.total ?? 0)} />
            </StatStrip>
          ) : null}

          <DataTable
            columns={columns}
            data={list.data?.vouchers ?? []}
            labels={tableLabels}
            getRowId={(voucher) => voucher.id}
            manualFiltering
            searchValue={search}
            onSearchChange={setSearch}
            sortable={false}
            paginated={false}
            loading={list.loading}
            error={null}
            activeFiltersCount={activeFilters}
            onClearFilters={clearFilters}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label={t('filters.period')}
                  value={period}
                  onChange={setPeriod}
                  allLabel={t('filters.allPeriods')}
                  options={REGISTER_PERIODS.map((value) => ({ value, label: t(`filters.periods.${value}`) }))}
                />
                <FilterSelect
                  label={t('filters.category')}
                  value={categoryId}
                  onChange={setCategoryId}
                  allLabel={t('filters.allCategories')}
                  options={(categories.data ?? []).map((category) => ({
                    value: category.id,
                    label: incomeCategoryLabel(category, locale),
                  }))}
                />
                <FilterSelect
                  label={t('filters.currency')}
                  value={currency}
                  onChange={setCurrency}
                  allLabel={t('filters.allCurrencies')}
                  options={currencies.map((code) => ({ value: code, label: currencyLabel(code) }))}
                />
                <FilterSelect
                  label={t('filters.status')}
                  value={includeVoid ? 'all' : ''}
                  onChange={(value) => setIncludeVoid(value === 'all')}
                  allLabel={t('filters.recordedOnly')}
                  options={[{ value: 'all', label: t('filters.includeCancelled') }]}
                />
              </div>
            }
          />

          {(list.data?.total ?? 0) > PAGE_SIZE ? (
            <Alert variant="info" title={t('truncatedTitle')}>
              {t('truncated', { shown: PAGE_SIZE, total: list.data?.total ?? 0 })}
            </Alert>
          ) : null}
        </>
      )}

      {voiding && token ? (
        <VoidIncomeDialog
          tenant={tenant}
          token={token}
          voucher={voiding}
          onDone={() => {
            setVoiding(null);
            void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
          }}
          onCancel={() => setVoiding(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * «إلغاء سند القبض» — the manager's cancellation.
 *
 * `destructive={false}` (DES-4): nothing is lost — the voucher stays, with its
 * reason. What it does is take the money back out of the wallet, and the copy
 * says so, along with the one refusal the manager may meet: a wallet that has
 * spent the money since. That refusal comes back from the server with the
 * figures named and is shown in the dialog, which stays open (STA-3).
 */
function VoidIncomeDialog({
  tenant,
  token,
  voucher,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  voucher: IncomeVoucherView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.income.voidDialog');
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    if (reason.trim().length < 5) {
      setError(t('reasonTooShort'));
      throw new Error(t('reasonTooShort'));
    }
    inFlight.current = true;
    try {
      await voidIncomeVoucher(tenant, token, { id: voucher.id, reason: reason.trim() });
      toast.success(t('success', { number: voucher.voucherNumber }));
      onDone();
    } catch (caught) {
      logApiError(caught);
      // Thrown back to `ConfirmDialog`, which shows the server's refusal inline (PRIM-16).
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('title', { number: voucher.voucherNumber })}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <Field htmlFor="income-void-reason" label={t('reason')} error={error ?? undefined} required>
        <Textarea
          id="income-void-reason"
          rows={2}
          maxLength={500}
          value={reason}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}
