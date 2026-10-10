'use client';

import { use, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Plus, Printer, Receipt } from 'lucide-react';
import { TREASURY_ADMIN_ROLES, TREASURY_WORK_ROLES } from '@mechanization/shared-schemas';
import {
  getExpenseCategories,
  getExpenses,
  getTreasuryOverview,
  logApiError,
  voidExpense,
  type ExpenseVoucherView,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { FilterSelect } from '@/components/ui/filter-controls';
import { PageHeader } from '@/components/ui/page-header';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { Field } from '@/components/ui/field';

const PAGE_SIZE = 50;

/**
 * النفقات — what the municipality spent, and the «أمر صرف» behind each figure.
 *
 * Recording is paying (docs/finance.md §5.1): there is no queue of drafts to
 * work through, so the register is the whole screen and «سجّل نفقة» is the one
 * action on it. A mistake is cancelled, never edited, and a cancelled voucher
 * stays in the list greyed and struck through rather than disappearing — an
 * auditor asking what happened to PV-000012 is owed the answer, not a gap.
 *
 * It sits under `/finance`, so `canAccessPath` matches the `/finance` nav row by
 * prefix and the page inherits `TREASURY_READ_ROLES` (CODE-4). The server
 * enforces the same three lists.
 */
export default function ExpensesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.expenses');
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);

  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const canVoid = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [categoryId, setCategoryId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [voiding, setVoiding] = useState<ExpenseVoucherView | null>(null);

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const categories = useStaffQuery({
    queryKey: ['treasury', tenant, 'expense-categories'],
    queryFn: (accessToken, signal) => getExpenseCategories(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    reference: true,
    errorMessage: t('loadError'),
  });

  const list = useStaffQuery({
    queryKey: ['treasury', tenant, 'expenses', categoryId, accountId, includeVoid],
    queryFn: (accessToken, signal) =>
      getExpenses(
        tenant,
        accessToken,
        {
          categoryId: categoryId || undefined,
          accountId: accountId || undefined,
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

  const accounts = overview.data?.accounts ?? [];
  const tableLabels = useTableLabels({ empty: t('empty'), emptyHint: t('emptyHint') });

  const columns = useMemo<ColumnDef<ExpenseVoucherView>[]>(
    () => [
      {
        id: 'voucher',
        header: t('columns.voucher'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              {/* A voucher number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */}
              <span dir="ltr" className="font-mono text-xs font-medium">
                {row.original.voucherNumber}
              </span>
              {row.original.status === 'VOID' ? (
                <Badge variant="soft-warning">{t('cancelled')}</Badge>
              ) : null}
            </div>
            <p className="truncate font-medium text-foreground">{row.original.payee}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.description}</p>
          </div>
        ),
      },
      {
        id: 'category',
        header: t('columns.category'),
        cell: ({ row }) => <span className="text-sm">{row.original.category.name}</span>,
      },
      {
        id: 'account',
        header: t('columns.account'),
        cell: ({ row }) => <span className="text-sm">{row.original.account.name}</span>,
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.occurredAt)}</span>,
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
              A cancelled voucher moved no money in the end, so its figure is
              struck through as well as dimmed: the strike is the signal that
              survives a greyscale screen and a printout (COL-3).
            */
            className={cn(
              'font-semibold',
              row.original.status === 'VOID' && 'text-muted-foreground line-through',
            )}
          />
        ),
      },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-1 max-sm:w-full max-sm:flex-col">
            {/* Every voucher prints, a cancelled one too: its paper says so (`ExpenseVoucherDocument`). */}
            <Button asChild variant="ghost" size="sm" className="max-sm:w-full">
              <Link
                href={`${base}/finance/expenses/${row.original.id}/print?print=1`}
                aria-label={t('printFor', { number: row.original.voucherNumber })}
              >
                <Printer className="size-4" aria-hidden />
                {t('print')}
              </Link>
            </Button>
            {canVoid && row.original.status === 'RECORDED' ? (
              <Button
                variant="ghost"
                size="sm"
                className="max-sm:w-full"
                onClick={() => setVoiding(row.original)}
              >
                <Ban className="size-4" aria-hidden />
                {t('void')}
              </Button>
            ) : null}
          </div>
        ),
      },
    ],
    [t, locale, canVoid, base],
  );

  const totals = list.data?.totals ?? [];

  /* «المصروف بالليرة», not «المصروف بـ LBP»: a sentence, not a code glued to a preposition (TXT-5). */
  const spentLabel = (currency: string): string =>
    currency === 'LBP' ? t('spentInLBP') : currency === 'USD' ? t('spentInUSD') : t('spentInOther', { currency });

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={Receipt}
        title={t('title')}
        actions={
          canRecord && overview.data?.active ? (
            <Button asChild>
              <Link href={`${base}/finance/expenses/new`}>
                <Plus className="size-4" aria-hidden />
                {t('record')}
              </Link>
            </Button>
          ) : undefined
        }
      />

      {overview.data && !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : null}

      {list.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={list.error} onRetry={list.refetch} />
          </CardContent>
        </Card>
      ) : (
        <>
          {totals.length > 0 ? (
            <StatStrip>
              {totals.map((total) => (
                <StatItem
                  key={total.currency}
                  label={spentLabel(total.currency)}
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
            searchable={false}
            sortable={false}
            paginated={false}
            loading={list.loading}
            error={null}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label={t('filters.category')}
                  value={categoryId}
                  onChange={setCategoryId}
                  allLabel={t('filters.allCategories')}
                  options={(categories.data ?? []).map((category) => ({
                    value: category.id,
                    label: category.name,
                  }))}
                />
                <FilterSelect
                  label={t('filters.account')}
                  value={accountId}
                  onChange={setAccountId}
                  allLabel={t('filters.allAccounts')}
                  options={accounts.map((account) => ({ value: account.id, label: account.name }))}
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
        <VoidExpenseDialog
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
 * «إلغاء سند الصرف» — the manager's cancellation.
 *
 * `ConfirmDialog` with `destructive={false}` on purpose (DES-4): nothing is
 * lost. The voucher stays, the money comes back, and the copy says both, so the
 * manager is not warned about a consequence that does not happen.
 */
function VoidExpenseDialog({
  tenant,
  token,
  voucher,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  voucher: ExpenseVoucherView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.voidDialog');
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
      await voidExpense(tenant, token, { id: voucher.id, reason: reason.trim() });
      onDone();
    } catch (caught) {
      logApiError(caught);
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
      <Field htmlFor="void-reason" label={t('reason')} error={error ?? undefined} required>
        <Textarea
          id="void-reason"
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
