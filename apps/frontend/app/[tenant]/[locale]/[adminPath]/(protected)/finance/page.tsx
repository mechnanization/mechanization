'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, HandCoins, Landmark, Lock, Receipt } from 'lucide-react';
import { getLabels, TREASURY_ADMIN_ROLES } from '@mechanization/shared-schemas';
import { getTreasuryOverview, type TreasuryAccountView, type TreasuryOverview } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { totalInCurrency, usableRate } from '@/lib/treasury-convert';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { ActivateTreasuryDialog } from '@/components/admin/finance/activate-treasury-dialog';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * «الخزينة» — where the municipality's money is and what each place holds.
 *
 * ## Why a register and not a row of balance cards
 *
 * The wallets were four equal cards with a big number each, which is the
 * hero-metric grid BAN-6 refuses, and it broke down three ways: the card was a
 * `div` with `onClick`, so the keyboard could not open a statement and the
 * screen reader was told nothing was there; a nested button inside that click
 * target made the same wallet two overlapping controls; and the grid has no
 * answer for the fifth wallet, which the design already expects (a bank
 * account, a petty-cash fund). A register answers all three — `DataTable` gives
 * the rows a real link each, phone cards for free, and one more wallet is one
 * more row — and it is the pattern every other list in this portal uses, which
 * is the point of UX-1.
 *
 * Each wallet keeps its own currency and its own real balance. The converted
 * total below is one extra line at the municipality's own rate; it never
 * replaces a wallet's figure. What collectors still hold is drawn apart from
 * the safe and is in no total.
 *
 * Reading is `TREASURY_READ_ROLES` (the `/finance` nav row and the server both
 * enforce it); activating is the manager's alone, so the control is shown to
 * `TREASURY_ADMIN_ROLES` and everybody else is told who does it.
 */
export default function FinancePage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance');
  const { token, user } = useStaffSession(tenant, base);
  const canActivate = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [activating, setActivating] = useState(false);

  const query = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const overview = query.data;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={Landmark} title={t('title')} subtitle={t('subtitle')} />

      {query.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={query.error} onRetry={query.refetch} />
          </CardContent>
        </Card>
      ) : !overview ? (
        <BalancesSkeleton />
      ) : !overview.active ? (
        <SetupState
          overview={overview}
          locale={locale}
          canActivate={canActivate}
          onActivate={() => setActivating(true)}
        />
      ) : (
        <>
          <section aria-labelledby="treasury-balances" className="space-y-3">
            <h2 id="treasury-balances" className="text-base font-semibold">
              {t('accounts.heading')}
            </h2>
            <WalletRegister accounts={overview.accounts} base={base} locale={locale} loading={false} />
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <Link href={`${base}/finance/expenses`}>
                  <Receipt className="size-4" aria-hidden />
                  {t('accounts.openExpenses')}
                </Link>
              </Button>
            </div>
            {overview.goLiveAt ? (
              <p className="text-xs text-muted-foreground">
                {t('accounts.goLive', { date: formatDate(overview.goLiveAt) })}
              </p>
            ) : null}
          </section>

          <ConvertedTotal overview={overview} locale={locale} />
          <HeldByCollectors held={overview.heldByCollectors} locale={locale} />
        </>
      )}

      {activating && overview && token ? (
        <ActivateTreasuryDialog
          tenant={tenant}
          token={token}
          locale={locale}
          accounts={overview.accounts}
          onClose={() => setActivating(false)}
        />
      ) : null}
    </div>
  );
}

/** The shape the register leaves, so the page does not jump when the balances land. */
function BalancesSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <div className="space-y-px overflow-hidden rounded-lg border bg-border">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center justify-between gap-4 bg-card px-4 py-3.5">
            <div className="space-y-2">
              <Skeleton className="h-4 w-36" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The wallets, one row each, with the balance at the far edge and a link into
 * the statement.
 *
 * The balance is `text-base font-semibold` rather than the card's old
 * `text-2xl font-bold`: in a column the figures read against each other, and
 * the size that made one number a headline makes four of them shout. It keeps
 * `tabular-nums` through `TreasuryAmount`, so the digits line up down the
 * column (TYP-4).
 */
function WalletRegister({
  accounts,
  base,
  locale,
  loading,
}: {
  accounts: TreasuryAccountView[];
  base: string;
  locale: string;
  loading: boolean;
}): React.JSX.Element {
  const t = useTranslations('finance.accounts');
  const labels = getLabels(locale);
  const tableLabels = useTableLabels({ empty: t('empty'), emptyHint: t('emptyHint') });

  /*
    «الحساب الرئيسي» marks the wallet a payment of that kind is routed to. While
    every wallet is one — the four seeded today — the badge is on every row and
    tells the reader nothing, which is the noise UX-3 separates from density. It
    earns its place the moment a municipality adds a second cash box, and that is
    exactly when it appears.
  */
  const marksPrimary = accounts.some((account) => !account.isPrimary);

  const columns = useMemo<ColumnDef<TreasuryAccountView>[]>(
    () => [
      {
        id: 'wallet',
        header: t('wallet'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate font-medium text-foreground">{row.original.name}</span>
              {marksPrimary && row.original.isPrimary ? (
                <Badge variant="soft-default" className="shrink-0">
                  {t('primary')}
                </Badge>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {labels.treasuryAccountType[row.original.type]}
              {row.original.ownerName ? ` · ${row.original.ownerName}` : ''}
            </p>
          </div>
        ),
      },
      {
        id: 'currency',
        header: t('currency'),
        cell: ({ row }) => (
          <span dir="ltr" className="font-medium tabular-nums">
            {row.original.currency}
          </span>
        ),
      },
      {
        id: 'balance',
        header: t('balance'),
        meta: { align: 'end' },
        cell: ({ row }) => (
          <TreasuryAmount
            amount={row.original.balance}
            currency={row.original.currency}
            locale={locale}
            /* A negative balance is a refusal the ledger should have prevented: name it, never only colour it (COL-3). */
            className={row.original.balance < 0 ? 'text-base font-semibold text-destructive' : 'text-base font-semibold'}
          />
        ),
      },
      {
        id: 'open',
        header: t('actions'),
        enableSorting: false,
        meta: { mobile: 'actions', align: 'end' },
        cell: ({ row }) => (
          <Button asChild variant="ghost" size="sm" className="max-sm:w-full">
            <Link href={`${base}/finance/accounts/${row.original.id}`}>
              <span className="truncate">{t('openStatement')}</span>
              {/* Drawn pointing left for Arabic; flipped for English (RTL-3). */}
              <ChevronLeft className="size-4 ltr:rotate-180" aria-hidden />
            </Link>
          </Button>
        ),
      },
    ],
    [t, labels, locale, base, marksPrimary],
  );

  return (
    <DataTable
      columns={columns}
      data={accounts}
      labels={tableLabels}
      getRowId={(account) => account.id}
      searchable={false}
      sortable={false}
      paginated={false}
      loading={loading}
      error={null}
    />
  );
}

/** Before activation: nothing credits a wallet, so there are no balances to show, only what to do. */
function SetupState({
  overview,
  locale,
  canActivate,
  onActivate,
}: {
  overview: TreasuryOverview;
  locale: string;
  canActivate: boolean;
  onActivate: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.setup');
  const labels = getLabels(locale);
  const hasAccounts = overview.accounts.length > 0;

  return (
    <Card>
      <CardContent className="p-0">
        <EmptyState
          icon={Lock}
          title={t('title')}
          description={canActivate ? (hasAccounts ? t('adminBody') : t('noAccounts')) : t('otherBody')}
          action={canActivate && hasAccounts ? <Button onClick={onActivate}>{t('activate')}</Button> : undefined}
        />
        {canActivate && hasAccounts ? (
          <div className="border-t px-4 py-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">{t('accountsHeading')}</p>
            <ul className="flex flex-wrap gap-2">
              {overview.accounts.map((account) => (
                <li key={account.id}>
                  <Badge variant="soft-muted">
                    {account.name} · {labels.treasuryAccountType[account.type]} · {account.currency}
                  </Badge>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * One extra line: every balance added up in the chosen currency at the
 * municipality's rate. The register above is the truth; this is a convenience,
 * and it says which rate it used and when that rate was set (FRM-5).
 */
function ConvertedTotal({ overview, locale }: { overview: TreasuryOverview; locale: string }): React.JSX.Element {
  const t = useTranslations('finance.view');
  const [chosen, setChosen] = useState<string | null>(null);

  const { rate } = overview;
  const pair = usableRate(rate);
  const options = useMemo(() => {
    const label = (currency: string): string =>
      currency === 'LBP' ? t('inLBP') : currency === 'USD' ? t('inUSD') : t('inOther', { currency });
    return [rate.baseCurrency, ...(rate.secondaryCurrency ? [rate.secondaryCurrency] : [])].map((currency) => ({
      value: currency,
      label: label(currency),
    }));
  }, [rate.baseCurrency, rate.secondaryCurrency, t]);

  const target = chosen && options.some((option) => option.value === chosen) ? chosen : rate.baseCurrency;
  const converted = useMemo(
    () =>
      totalInCurrency(
        overview.accounts.map((account) => ({ currency: account.currency, amount: account.balance })),
        target,
        rate,
      ),
    [overview.accounts, target, rate],
  );

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
        <CardTitle className="text-base">{t('totalLabel')}</CardTitle>
        <SegmentedControl
          aria-label={t('aria')}
          size="field"
          fullWidth={false}
          value={target}
          onChange={setChosen}
          options={options}
          disabled={!pair}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {pair && converted ? (
          <>
            <p className="text-2xl font-bold">
              <TreasuryAmount amount={converted.total} currency={converted.currency} locale={locale} />
            </p>
            {converted.skipped.length > 0 ? (
              <Alert variant="warning" live="status" title={t('skippedTitle')}>
                {t('skipped', { currencies: converted.skipped.join(', ') })}
              </Alert>
            ) : null}
            <SummaryList>
              <SummaryRow label={t('rateLabel')}>
                {t('rateUsed', {
                  unit: formatMoney(1, pair.secondary, locale),
                  rate: formatMoney(pair.exchangeRate, pair.base, locale),
                })}
              </SummaryRow>
              {rate.exchangeRateUpdatedAt ? (
                <SummaryRow label={t('rateUpdatedLabel')}>{formatDate(rate.exchangeRateUpdatedAt)}</SummaryRow>
              ) : null}
            </SummaryList>
            <p className="text-xs text-muted-foreground">{t('totalHint')}</p>
          </>
        ) : (
          <Alert variant="warning" title={t('noRateTitle')}>
            {t('noRateBody')}
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

/** What collectors have taken in and not handed over. Drawn apart: not the safe, and not in the total. */
function HeldByCollectors({
  held,
  locale,
}: {
  held: TreasuryOverview['heldByCollectors'];
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.held');
  return (
    <section aria-labelledby="treasury-held" className="rounded-lg border border-dashed bg-muted/20 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <HandCoins className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div>
            <h2 id="treasury-held" className="text-base font-semibold">
              {t('title')}
            </h2>
            <p className="text-xs text-muted-foreground">{t('hint')}</p>
          </div>
          {held.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('none')}</p>
          ) : (
            <ul className="flex flex-wrap gap-x-6 gap-y-1">
              {held.map((entry) => (
                <li key={entry.currency} className="text-lg font-semibold">
                  <TreasuryAmount amount={entry.amount} currency={entry.currency} locale={locale} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
