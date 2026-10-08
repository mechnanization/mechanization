'use client';

import { use, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Banknote,
  HandCoins,
  Landmark,
  Lock,
  Smartphone,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { getLabels, TREASURY_ADMIN_ROLES, type TreasuryAccountType } from '@mechanization/shared-schemas';
import { getTreasuryOverview, type TreasuryAccountView, type TreasuryOverview } from '@/lib/api-client';
import { formatMoney } from '@/lib/currency';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { totalInCurrency, usableRate } from '@/lib/treasury-convert';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { ActivateTreasuryDialog } from '@/components/admin/finance/activate-treasury-dialog';
import { CollectorCustodyPanel } from '@/components/admin/finance/collector-custody-panel';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { EmptyState, ErrorState } from '@/components/ui/states';

/**
 * «الخزينة» — where the municipality's money is and what each place holds.
 *
 * ## The wallets are a strip, not a grid of cards
 *
 * The four wallets sit side by side, two cash boxes and two Whish accounts, each
 * with its icon and its balance. They are a `StatStrip` — one framed bar split
 * into equal cells — rather than four free-standing cards, which is the
 * same-size icon card grid BAN-6 refuses as page structure. The strip is one
 * object among the page's three, which is what keeps it a summary rather than
 * the layout.
 *
 * An earlier version had exactly four such cards and was replaced by a table
 * for three faults, all of which the strip answers rather than repeats:
 *
 *  - the card was a `div` with `onClick`, so the keyboard could not open a
 *    statement — each cell here is a real link (`StatItem`'s `href`);
 *  - a nested button made one wallet two overlapping controls — there is one
 *    stretched link per cell and nothing else in it;
 *  - the grid had no answer for a fifth wallet — the strip takes as many
 *    columns as there are wallets, and wraps two-up on a phone.
 *
 * The icon follows the wallet's *type*, never its position, so «صندوق النقد»
 * is a banknote and «Whish» a phone-wallet whichever order they arrive in, and a
 * bank account added later gets its own without a code change.
 *
 * Each wallet keeps its own currency and its own real balance. The converted
 * total below is one extra figure at the municipality's own rate; it never
 * replaces a wallet's. What collectors still hold is drawn apart from the safe
 * and is in no total.
 *
 * The expense register is reached from the sidebar («النفقات»), not from a
 * button here.
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
      <PageHeader icon={Landmark} title={t('title')} />

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
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id="treasury-balances" className="text-base font-semibold">
                {t('accounts.heading')}
              </h2>
              {overview.goLiveAt ? (
                <p className="text-xs text-muted-foreground">
                  {t('accounts.goLive', { date: formatDate(overview.goLiveAt) })}
                </p>
              ) : null}
            </div>
            <WalletStrip accounts={overview.accounts} base={base} locale={locale} />
          </section>

          <ConvertedTotal overview={overview} locale={locale} />
          <CollectorCustodyPanel tenant={tenant} base={base} token={token} locale={locale} role={user?.role} />
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

/** The shape the strip leaves, so the page does not jump when the balances land. */
function BalancesSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-32" />
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="flex flex-col items-center gap-2.5 bg-card px-3 py-4">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-3 w-20" />
          </div>
        ))}
      </div>
    </div>
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
 * The wallets, side by side: icon, balance, name — and the whole cell opens
 * the statement.
 *
 * The balance carries `tabular-nums` through `StatItem` (TYP-4). A negative one
 * is a refusal the ledger should have prevented: its minus sign says so, and the
 * colour only repeats it (COL-3).
 */
function WalletStrip({
  accounts,
  base,
  locale,
}: {
  accounts: TreasuryAccountView[];
  base: string;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.accounts');

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState icon={Wallet} title={t('empty')} description={t('emptyHint')} />
        </CardContent>
      </Card>
    );
  }

  /*
    «الرئيسي» marks the wallet a payment of that kind is routed to. While every
    wallet is one — the four seeded today — saying so on each cell tells the
    reader nothing (UX-3). It appears the moment a municipality adds a second
    cash box, which is exactly when it starts to matter.
  */
  const marksPrimary = accounts.some((account) => !account.isPrimary);

  return (
    <StatStrip>
      {accounts.map((account) => (
        <StatItem
          key={account.id}
          icon={WALLET_ICON[account.type] ?? Wallet}
          href={`${base}/finance/accounts/${account.id}`}
          label={marksPrimary && account.isPrimary ? `${account.name} · ${t('primary')}` : account.name}
          value={<TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />}
          className={account.balance < 0 ? 'text-destructive' : undefined}
        />
      ))}
    </StatStrip>
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
 * «مجموع الأرصدة بعد التحويل» — every balance added up in the chosen currency
 * at the municipality's rate.
 *
 * Laid out as a figure and its provenance: the total large at the top with the
 * currency switch beside it, then a footer that says which rate produced it and
 * when that rate was set (FRM-5). The wallets above are the truth; this is a
 * convenience, and the footer is what keeps it honest about that.
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
    <section aria-labelledby="treasury-total">
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 space-y-2">
              <h2 id="treasury-total" className="text-sm font-medium text-muted-foreground">
                {t('totalLabel')}
              </h2>
              {pair && converted ? (
                <p className="text-2xl font-bold leading-none tracking-tight sm:text-3xl">
                  <TreasuryAmount amount={converted.total} currency={converted.currency} locale={locale} />
                </p>
              ) : null}
            </div>
            <SegmentedControl
              aria-label={t('aria')}
              size="field"
              fullWidth={false}
              value={target}
              onChange={setChosen}
              options={options}
              disabled={!pair}
            />
          </div>

          {pair && converted ? (
            <>
              {converted.skipped.length > 0 ? (
                <div className="px-5 pb-4">
                  <Alert variant="warning" live="status" title={t('skippedTitle')}>
                    {t('skipped', { currencies: converted.skipped.join(', ') })}
                  </Alert>
                </div>
              ) : null}

              {/* The provenance: which rate, set when — the two facts that make the figure checkable. */}
              <dl className="grid grid-cols-1 gap-px border-t bg-border sm:grid-cols-2">
                <div className="bg-muted/30 px-5 py-3">
                  <dt className="text-xs text-muted-foreground">{t('rateLabel')}</dt>
                  <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                    {t('rateUsed', {
                      unit: formatMoney(1, pair.secondary, locale),
                      rate: formatMoney(pair.exchangeRate, pair.base, locale),
                    })}
                  </dd>
                </div>
                {rate.exchangeRateUpdatedAt ? (
                  <div className="bg-muted/30 px-5 py-3">
                    <dt className="text-xs text-muted-foreground">{t('rateUpdatedLabel')}</dt>
                    <dd className="mt-0.5 text-sm font-semibold tabular-nums">
                      {formatDate(rate.exchangeRateUpdatedAt)}
                    </dd>
                  </div>
                ) : null}
              </dl>
              <p className="border-t px-5 py-3 text-xs text-muted-foreground">{t('totalHint')}</p>
            </>
          ) : (
            <div className="px-5 pb-5">
              <Alert variant="warning" title={t('noRateTitle')}>
                {t('noRateBody')}
              </Alert>
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
