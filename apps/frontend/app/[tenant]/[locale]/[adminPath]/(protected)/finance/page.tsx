'use client';

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Banknote,
  ChevronLeft,
  HandCoins,
  Landmark,
  Lock,
  Smartphone,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import {
  getLabels,
  TREASURY_ADMIN_ROLES,
  type TreasuryAccountType,
  type TreasuryRate,
} from '@mechanization/shared-schemas';
import { getTreasuryOverview, type TreasuryAccountView, type TreasuryOverview } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { activeAccounts } from '@/lib/treasury-accounts';
import { convertAmount, totalInCurrency, usableRate } from '@/lib/treasury-convert';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { ActivateTreasuryDialog } from '@/components/admin/finance/activate-treasury-dialog';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * «الخزينة» — where the municipality's money is and what each place holds.
 *
 * ## The balances are a statement, not a row of tiles
 *
 * One card reads the way an accountant writes it on paper: each wallet on its
 * own line with its balance in its own currency, and under the last line the
 * total. The converted total used to be a second card of its own, as large as
 * everything else on the page; now it is the footer of the list it adds up, and
 * each foreign-currency line shows its «≈» equivalent, so the figure can be
 * checked against the lines above it instead of taken on trust (FRM-5).
 *
 * The four wallets were a `StatStrip` before (2026-10-08): four equal cells,
 * each an icon in a circle over a number. That is the same-size icon grid BAN-6
 * refuses, only framed, and it left no room for the equivalent. Each line here
 * keeps what the strip got right:
 *
 *  - the whole line is one stretched link to the wallet's statement, named by
 *    the wallet, so the keyboard reaches it and there is one control per line;
 *  - a fifth wallet is a fifth line, with no layout to break;
 *  - the icon follows the wallet's *type*, never its position, so «صندوق النقد»
 *    is a banknote and «Whish» a phone-wallet whichever order they arrive in.
 *
 * Each wallet keeps its own currency and its own real balance. The converted
 * total is one extra figure at the municipality's own rate; it never replaces
 * a wallet's.
 *
 * What collectors still hold is not here at all: it is not the treasury's
 * until it is handed in, and it has its own page, «الجباة والتحصيل»
 * (`/finance/collectors`), where it is received into the safe. That page and
 * the expense register («النفقات») are reached from the sidebar, not from
 * buttons here. The one exception is `OrdersNotice`: when requests or
 * urgent payments are waiting for the manager's payment order, a line says so
 * and leads straight to that queue.
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
  const tCommon = useTranslations('common');
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
      <PageHeader icon={Landmark} title={t('title')} />

      {/*
        A failed re-read with the treasury already on screen keeps it there, an
        open activation dialog included: swapping the page for an error panel
        unmounted it mid-entry.
      */}
      {query.error && overview ? <RefreshFailedAlert message={query.error} onRetry={query.refetch} /> : null}

      {query.error && !overview ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={query.error} onRetry={query.refetch} retryLabel={tCommon('retry')} />
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
          <OrdersNotice
            href={`${base}/finance/expenses?view=queue`}
            requests={overview.pendingExpenseRequests}
            urgent={overview.vouchersAwaitingOrder}
          />

          <BalancesCard overview={overview} base={base} locale={locale} />
        </>
      )}

      {activating && overview && token ? (
        <ActivateTreasuryDialog
          tenant={tenant}
          token={token}
          locale={locale}
          // The server asks for the opening balance of every active wallet, and only those.
          accounts={activeAccounts(overview)}
          onClose={() => setActivating(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * «بانتظار أمر الصرف» — a line to the queue when something is waiting for the
 * manager's payment order.
 *
 * Two debts, counted apart: requests an accountant prepared (nothing has left a
 * wallet) and urgent payments made before the order (the money has moved,
 * art. 35). Both lead to the same queue on the expense register, and the notice
 * is gone when neither has anything in it. Shown to everyone who reads the
 * treasury: it is a fact about the treasury, and for the manager it is the next
 * thing to do.
 */
function OrdersNotice({
  href,
  requests,
  urgent,
}: {
  href: string;
  requests: number;
  urgent: number;
}): React.JSX.Element | null {
  const t = useTranslations('finance.orders');
  if (requests <= 0 && urgent <= 0) return null;

  /*
    Underlined, in the alert's own text colour: `text-primary` on this tint measures
    4.03:1 in the dark theme, under COL-4's 4.5:1, and the underline is what says
    «link» without leaning on colour (COL-3).
  */
  const link =
    'inline-flex min-h-6 items-center font-medium underline underline-offset-4 hover:no-underline coarse:min-h-touch';
  // No live region: the note is in the page when it loads, not news that arrived after (A11Y-5).
  return (
    <Alert variant="warning">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        {requests > 0 ? (
          <Link href={href} className={link}>
            {t('requests', { count: requests })}
          </Link>
        ) : null}
        {urgent > 0 ? (
          <Link href={href} className={link}>
            {t('urgent', { count: urgent })}
          </Link>
        ) : null}
      </div>
    </Alert>
  );
}

/** The shape the statement leaves, so the page does not jump when the balances land. */
function BalancesSkeleton(): React.JSX.Element {
  return (
    <Card className="overflow-hidden">
      <div className="border-b px-4 py-3 sm:px-5">
        <Skeleton className="h-5 w-32" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
            <Skeleton className="size-10 rounded-lg" />
            <Skeleton className="h-4 w-36" />
            <Skeleton className="ms-auto h-5 w-28" />
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t bg-muted/30 px-4 py-4 sm:px-5">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-8 w-48" />
      </div>
    </Card>
  );
}

/**
 * Which picture a wallet gets, by what it is.
 *
 * Whish has no mark of its own here on purpose: its logo is a third party's
 * trademark, and drawing it from memory would put a wrong version of somebody
 * else's brand on a municipal screen. A phone-wallet says what it is. If the
 * municipality supplies the official mark, it replaces `Smartphone` here.
 */
const WALLET_ICON: Record<TreasuryAccountType, LucideIcon> = {
  CASH_SAFE: Banknote,
  WHISH_ACCOUNT: Smartphone,
  BANK_ACCOUNT: Landmark,
  COLLECTOR_CUSTODY: HandCoins,
  PETTY_CASH: Wallet,
};

/**
 * «أرصدة الخزينة» — the wallets, one per line, and their total in the footer.
 *
 * The currency the total is shown in is chosen here and also drives each
 * line's «≈» equivalent, so the switch changes the whole statement at once.
 */
function BalancesCard({
  overview,
  base,
  locale,
}: {
  overview: TreasuryOverview;
  base: string;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance');
  const [chosen, setChosen] = useState<string | null>(null);

  const { rate, accounts } = overview;
  const currencies = useMemo(
    () => [rate.baseCurrency, ...(rate.secondaryCurrency ? [rate.secondaryCurrency] : [])],
    [rate.baseCurrency, rate.secondaryCurrency],
  );
  const target = chosen && currencies.includes(chosen) ? chosen : rate.baseCurrency;

  /*
    «الرئيسي» marks the wallet a payment of that kind is routed to. While every
    wallet is one — the four seeded today — saying so on each line tells the
    reader nothing (UX-3). It appears the moment a municipality adds a second
    cash box, which is exactly when it starts to matter.
  */
  const marksPrimary = accounts.some((account) => !account.isPrimary);

  return (
    <section aria-labelledby="treasury-balances">
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b px-4 py-3 sm:px-5">
          <h2 id="treasury-balances" className="text-base font-semibold">
            {t('accounts.heading')}
          </h2>
          {overview.goLiveAt ? (
            <p className="text-xs text-muted-foreground">
              {t('accounts.goLive', { date: formatDate(overview.goLiveAt) })}
            </p>
          ) : null}
        </div>

        {accounts.length === 0 ? (
          <EmptyState icon={Wallet} title={t('accounts.empty')} description={t('accounts.emptyHint')} />
        ) : (
          <>
            <ul className="divide-y">
              {accounts.map((account) => (
                <WalletLine
                  key={account.id}
                  account={account}
                  href={`${base}/finance/accounts/${account.id}`}
                  primaryLabel={marksPrimary && account.isPrimary ? t('accounts.primary') : null}
                  target={target}
                  rate={rate}
                  locale={locale}
                />
              ))}
            </ul>
            <TotalFooter
              accounts={accounts}
              rate={rate}
              currencies={currencies}
              target={target}
              onTargetChange={setChosen}
              locale={locale}
            />
          </>
        )}
      </Card>
    </section>
  );
}

/**
 * One wallet: its icon, its name, its balance in its own currency, and — when
 * that currency is not the one the total is in — what it comes to at the rate.
 *
 * The balance carries `tabular-nums` through `TreasuryAmount` (TYP-4). A
 * negative one is a refusal the ledger should have prevented: its minus sign
 * says so, and the colour only repeats it (COL-3).
 */
function WalletLine({
  account,
  href,
  primaryLabel,
  target,
  rate,
  locale,
}: {
  account: TreasuryAccountView;
  href: string;
  primaryLabel: string | null;
  target: string;
  rate: TreasuryRate;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.view');
  const Icon = WALLET_ICON[account.type] ?? Wallet;
  const equivalent = account.currency === target ? null : convertAmount(account.balance, account.currency, target, rate);

  return (
    <li className="relative flex items-center gap-3 px-4 py-3.5 transition-colors duration-150 hover:bg-muted/30 sm:px-5">
      <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <Icon className="size-5" />
      </span>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        {/* The stretched link: its `::after` covers the line, so the whole line opens the statement. */}
        <Link
          href={href}
          title={account.name}
          className="min-w-0 truncate font-medium after:absolute after:inset-0 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
        >
          {account.name}
        </Link>
        {primaryLabel ? <Badge variant="soft-muted">{primaryLabel}</Badge> : null}
      </div>

      <div className="shrink-0 text-end">
        <TreasuryAmount
          amount={account.balance}
          currency={account.currency}
          locale={locale}
          className={account.balance < 0 ? 'text-lg font-semibold text-destructive' : 'text-lg font-semibold'}
        />
        {equivalent !== null ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            <bdi>{t('equivalent', { amount: formatMoney(equivalent, target, locale) })}</bdi>
          </p>
        ) : null}
      </div>

      <ChevronLeft aria-hidden className="size-4 shrink-0 text-muted-foreground ltr:rotate-180" />
    </li>
  );
}

/**
 * «مجموع الأرصدة بعد التحويل» — every balance added up in the chosen currency
 * at the municipality's rate, as the last line of the statement.
 *
 * Under the figure, one line says which rate produced it and when that rate
 * was set (FRM-5). The lines above are the truth; this is a convenience, and
 * the rate line is what keeps it honest about that.
 */
function TotalFooter({
  accounts,
  rate,
  currencies,
  target,
  onTargetChange,
  locale,
}: {
  accounts: TreasuryAccountView[];
  rate: TreasuryRate;
  currencies: string[];
  target: string;
  onTargetChange: (currency: string) => void;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.view');
  const pair = usableRate(rate);

  const options = useMemo(
    () =>
      currencies.map((currency) => ({
        value: currency,
        label: currency === 'LBP' ? t('inLBP') : currency === 'USD' ? t('inUSD') : t('inOther', { currency }),
      })),
    [currencies, t],
  );

  const converted = useMemo(
    () =>
      totalInCurrency(
        accounts.map((account) => ({ currency: account.currency, amount: account.balance })),
        target,
        rate,
      ),
    [accounts, target, rate],
  );

  const figure = (chunks: React.ReactNode): React.ReactNode => (
    <bdi className="font-medium text-foreground tabular-nums">{chunks}</bdi>
  );

  return (
    <div className="space-y-3 border-t bg-muted/30 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1.5">
          <h3 className="text-sm font-medium text-muted-foreground">{t('totalLabel')}</h3>
          {pair && converted ? (
            <p className="text-2xl font-bold leading-tight sm:text-3xl">
              <TreasuryAmount amount={converted.total} currency={converted.currency} locale={locale} wrap />
            </p>
          ) : null}
        </div>
        {options.length > 1 ? (
          <SegmentedControl
            aria-label={t('aria')}
            size="sm"
            fullWidth={false}
            value={target}
            onChange={onTargetChange}
            options={options}
            disabled={!pair}
          />
        ) : null}
      </div>

      {pair && converted ? (
        <>
          <p className="text-xs text-muted-foreground">
            {rate.exchangeRateUpdatedAt
              ? t.rich('rateLine', {
                  unit: formatMoney(1, pair.secondary, locale),
                  rate: formatMoney(pair.exchangeRate, pair.base, locale),
                  date: formatDate(rate.exchangeRateUpdatedAt),
                  v: figure,
                })
              : t.rich('rateLineUndated', {
                  unit: formatMoney(1, pair.secondary, locale),
                  rate: formatMoney(pair.exchangeRate, pair.base, locale),
                  v: figure,
                })}
          </p>
          {converted.skipped.length > 0 ? (
            <Alert variant="warning" live="status" title={t('skippedTitle')}>
              {t('skipped', { currencies: converted.skipped.join(', ') })}
            </Alert>
          ) : null}
        </>
      ) : (
        <Alert variant="warning" title={t('noRateTitle')}>
          {t('noRateBody')}
        </Alert>
      )}
    </div>
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
  // What activation will ask for: every active wallet, and only those.
  const accounts = activeAccounts(overview);
  const hasAccounts = accounts.length > 0;

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
              {accounts.map((account) => (
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
