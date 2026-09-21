'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  BadgeDollarSign,
  Clock,
  HandCoins,
  Home,
  Receipt,
  RefreshCw,
  TrendingUp,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getStaff } from '@/lib/api-client';
import type { StaffSummary } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ActionTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** Every figure on this screen is USD with two decimals, and only here. */
function money(value: number, locale: string): string {
  return value.toLocaleString(locale === 'en' ? 'en-US' : 'en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Every field inspector's earnings on one screen, with the payout beside them.
 *
 * This replaces a page that showed one inspector at a time behind a row of
 * switcher buttons. The question an administrator actually arrives with is
 * «who is owed what», and that is a comparison — answering it by clicking
 * through five dashboards and holding five numbers in your head is how a
 * payout gets made twice. The totals at the top are the same sum the cards
 * below add up to, so a figure that looks wrong can be traced to the row that
 * made it.
 *
 * Only `FIELD_INSPECTOR` accounts appear. The commission is $1 per registered
 * property and the backend computes it for every staff row, so widening this
 * list is a one-word change — but a card that reads «$0.00» for an accountant
 * who was never going to survey anything is a row to scroll past, not
 * information.
 */
export function InspectorEarningsRoster({
  tenant,
  locale,
  base,
  token,
}: {
  tenant: string;
  locale: string;
  /** `/{tenant}/{locale}/{adminPath}` — what every admin link hangs off. */
  base: string;
  token: string | null;
}): React.JSX.Element {
  const isAr = locale !== 'en';
  const labels = getLabels(locale);
  const queryClient = useQueryClient();

  const [payoutFor, setPayoutFor] = useState<StaffSummary | null>(null);

  /*
    The same query key the staff directory uses, deliberately. Both screens
    read `GET /staff`, so sharing the key means recording a payout here also
    corrects the earnings shown there — and React Query serves this list from
    cache when an administrator arrives from that page.
  */
  const { data, loading, fetching, error, refetch } = useStaffQuery<{ items: StaffSummary[] }>({
    queryKey: ['staff', tenant],
    queryFn: (tok, signal) => getStaff(tenant, tok, signal),
    tenant,
    base,
    token,
    errorMessage: isAr ? 'تعذّر تحميل قائمة الموظفين' : 'Failed to load the staff list',
  });

  const inspectors = useMemo(() => {
    const rows = (data?.items ?? []).filter((row) => row.role === 'FIELD_INSPECTOR');
    /*
      Largest outstanding balance first, because that is the column this page
      exists to clear. Disabled accounts sink to the bottom whatever they are
      owed — they cannot register anything more, so their balance is a loose
      end rather than a queue. Name breaks the tie so the order is stable
      between refreshes instead of following whatever the database returned.
    */
    return rows.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      const pending = (b.pendingBalance ?? 0) - (a.pendingBalance ?? 0);
      if (pending !== 0) return pending;
      return a.fullName.localeCompare(b.fullName, isAr ? 'ar' : 'en');
    });
  }, [data, isAr]);

  const totals = useMemo(
    () =>
      inspectors.reduce(
        (sum, row) => ({
          citizens: sum.citizens + (row.registeredCitizensCount ?? 0),
          properties: sum.properties + (row.registeredPropertiesCount ?? 0),
          earned: sum.earned + (row.totalEarnings ?? 0),
          paid: sum.paid + (row.paidBalance ?? 0),
          pending: sum.pending + (row.pendingBalance ?? 0),
        }),
        { citizens: 0, properties: 0, earned: 0, paid: 0, pending: 0 },
      ),
    [inspectors],
  );

  const header = (
    <PageHeader
      icon={BadgeDollarSign}
      title={isAr ? 'أرباح المسح الميداني' : 'Field survey earnings'}
      subtitle={
        isAr
          ? 'ما استحقّه كل مفتش ميداني عن مسحه، وما سُلّم له منه — بمعدل 1.00$ لكل عقار أو وحدة'
          : 'What each field inspector has earned on their survey and what has been handed over — $1.00 per property or unit'
      }
      actions={
        <ActionTooltip label={isAr ? 'تحديث البيانات' : 'Refresh'}>
          <Button variant="outline" size="icon-sm" disabled={fetching} onClick={() => refetch()}>
            <RefreshCw className={`size-4 ${fetching ? 'animate-spin' : ''}`} aria-hidden />
            <span className="sr-only">{isAr ? 'تحديث' : 'Refresh'}</span>
          </Button>
        </ActionTooltip>
      }
    />
  );

  if (loading || !token) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {header}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton
              key={index}
              className={cn('h-24 rounded-lg', index === 4 && 'col-span-2 xl:col-span-1')}
            />
          ))}
        </div>
        <Skeleton className="h-52 rounded-xl" />
        <Skeleton className="h-52 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {header}
        <Card>
          <CardContent className="p-0">
            <ErrorState description={error} onRetry={() => refetch()} />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {header}

      {/*
        The whole municipality's position, above the rows that make it up.
        One accent, on the balance still owed — it is the only figure here that
        asks somebody to do something.

        Two across until there is room for five: the fifth, the balance owed,
        then takes the whole last row instead of sitting alone at half width.
        Five across waits for `xl` because the sidebar takes a quarter of a
        laptop, and a dollar figure in five columns of what is left wraps.
      */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Stat
          icon={UsersRound}
          label={isAr ? 'المفتشون الميدانيون' : 'Field inspectors'}
          value={inspectors.length.toLocaleString(locale)}
        />
        <Stat
          icon={Home}
          label={isAr ? 'العقارات والوحدات' : 'Properties & units'}
          value={totals.properties.toLocaleString(locale)}
          note={`${totals.citizens.toLocaleString(locale)} ${isAr ? 'مواطن مسجَّل' : 'citizens registered'}`}
        />
        <Stat
          icon={TrendingUp}
          label={isAr ? 'إجمالي الأرباح' : 'Total earned'}
          value={`$${money(totals.earned, locale)}`}
        />
        <Stat
          icon={Wallet}
          label={isAr ? 'إجمالي المدفوع' : 'Total paid'}
          value={`$${money(totals.paid, locale)}`}
        />
        <Stat
          icon={Clock}
          label={isAr ? 'إجمالي المتبقي' : 'Total pending'}
          value={`$${money(totals.pending, locale)}`}
          emphasis
          className="col-span-2 xl:col-span-1"
        />
      </div>

      {inspectors.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={UsersRound}
              title={isAr ? 'لا يوجد مفتشون ميدانيون' : 'No field inspectors'}
              description={
                isAr
                  ? 'أضف حساباً بدور «مفتش ميداني» من صفحة الموظفين ليظهر هنا برصيده.'
                  : 'Create an account with the Field Inspector role on the staff page and it will appear here with its balance.'
              }
              action={
                <Button asChild variant="outline" size="sm">
                  <Link href={`${base}/staff`}>{isAr ? 'إدارة الموظفين' : 'Manage staff'}</Link>
                </Button>
              }
            />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {inspectors.map((inspector) => (
            <InspectorCard
              key={inspector.id}
              inspector={inspector}
              base={base}
              locale={locale}
              roleLabel={
                labels.staffRole?.[inspector.role as never] ?? inspector.role
              }
              onPay={() => setPayoutFor(inspector)}
            />
          ))}
        </div>
      )}

      <InspectorPayoutDialog
        open={payoutFor !== null}
        onOpenChange={(next) => !next && setPayoutFor(null)}
        tenant={tenant}
        token={token}
        locale={locale}
        staff={payoutFor ? { id: payoutFor.id, name: payoutFor.fullName } : null}
        onRecorded={async () => {
          setPayoutFor(null);
          /*
            Both keys: this list holds the balances that just changed, and the
            inspector's own dashboard holds the payout log the new row belongs
            in. Invalidating only the first leaves a dashboard that still shows
            yesterday's total the next time it is opened from here.
          */
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['staff', tenant] }),
            queryClient.invalidateQueries({ queryKey: ['staff', tenant, 'inspector-profile'] }),
          ]);
        }}
      />
    </div>
  );
}

/**
 * One inspector: who they are, what they surveyed, what they are owed, and the
 * two things an administrator does about it.
 */
function InspectorCard({
  inspector,
  base,
  locale,
  roleLabel,
  onPay,
}: {
  inspector: StaffSummary;
  base: string;
  locale: string;
  roleLabel: string;
  onPay: () => void;
}): React.JSX.Element {
  const isAr = locale !== 'en';
  const citizens = inspector.registeredCitizensCount ?? 0;
  const properties = inspector.registeredPropertiesCount ?? 0;
  const earned = inspector.totalEarnings ?? 0;
  const paid = inspector.paidBalance ?? 0;
  const pending = inspector.pendingBalance ?? 0;

  const facts: Array<{ label: string; value: string; className?: string }> = [
    { label: isAr ? 'الصفة' : 'Role', value: roleLabel },
    {
      label: isAr ? 'الحساب' : 'Account',
      value: inspector.isActive ? (isAr ? 'فعّال' : 'Active') : isAr ? 'معطّل' : 'Disabled',
      // «معطّل» is the one thing here nobody should miss — as text, not a pill.
      className: inspector.isActive
        ? 'text-emerald-700 dark:text-emerald-400'
        : 'text-destructive',
    },
    ...(inspector.email
      ? [{ label: isAr ? 'البريد' : 'Email', value: inspector.email }]
      : []),
    { label: isAr ? 'انضم في' : 'Joined', value: formatDate(inspector.createdAt) },
    {
      label: isAr ? 'آخر دخول' : 'Last login',
      value: inspector.lastLoginAt
        ? formatDate(inspector.lastLoginAt)
        : isAr
          ? 'لم يدخل بعد'
          : 'never',
    },
  ];

  const figures: Array<{ label: string; value: string; className?: string }> = [
    { label: isAr ? 'المواطنون' : 'Citizens', value: citizens.toLocaleString(locale) },
    {
      label: isAr ? 'العقارات والوحدات' : 'Properties & units',
      value: properties.toLocaleString(locale),
    },
    { label: isAr ? 'إجمالي الأرباح' : 'Earned', value: `$${money(earned, locale)}` },
    {
      label: isAr ? 'المدفوع' : 'Paid',
      value: `$${money(paid, locale)}`,
      className: 'text-emerald-600 dark:text-emerald-400',
    },
    {
      label: isAr ? 'المتبقي المستحق' : 'Pending',
      value: `$${money(pending, locale)}`,
      className: cn(
        'font-bold',
        pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
      ),
    },
  ];

  return (
    <Card className="overflow-hidden border-border/70">
      <CardHeader className="space-y-4 border-b bg-muted/20 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-lg font-bold text-primary"
            >
              {inspector.fullName.charAt(0)}
            </span>
            {/*
              The name is the way into the full dashboard — the survey log, the
              property-type breakdown, every payout. Two buttons already sit on
              this card; a third labelled «عرض» would compete with the one that
              actually moves money.
            */}
            <Link
              href={`${base}/inspector/profile/${inspector.id}`}
              className="min-w-0 truncate text-base font-bold hover:underline"
            >
              {inspector.fullName}
            </Link>
          </div>

          {/* Two equal columns: the same width whatever each label says, full width on a phone. */}
          <div className="grid w-full grid-cols-2 gap-2 sm:w-auto">
            <Button
              size="sm"
              className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-800"
              onClick={onPay}
            >
              <HandCoins className="size-4" aria-hidden />
              {isAr ? 'تسجيل دفعة' : 'Pay'}
            </Button>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`${base}/inspector/profile/${inspector.id}/payouts`}>
                <Receipt className="size-4" aria-hidden />
                {isAr ? 'سجل الدفعات' : 'History'}
              </Link>
            </Button>
          </div>
        </div>

        {/*
          Rows on a phone — label at the start, value at the far edge, a rule
          between each — and five columns across from `lg`, each value under
          its label, so a wide card reads in one line instead of a narrow
          column of mostly empty space beside the name.
        */}
        <dl className="divide-y divide-border/60 text-xs lg:grid lg:grid-cols-5 lg:gap-4 lg:divide-y-0 lg:border-t lg:border-border/60 lg:pt-3">
          {facts.map((fact) => (
            <div
              key={fact.label}
              className="flex items-center justify-between gap-4 py-2 lg:block lg:min-w-0 lg:py-0"
            >
              <dt className="shrink-0 text-muted-foreground">{fact.label}</dt>
              <dd
                title={fact.value}
                className={cn(
                  'min-w-0 truncate text-end text-sm font-semibold lg:mt-1 lg:text-start',
                  fact.className,
                )}
              >
                <bdi>{fact.value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </CardHeader>

      <CardContent className="p-0">
        {/*
          The same five measures for every inspector, in the same places, so one
          card reads against the next. A grid rather than a table: five columns
          across from `sm`, and on a phone two by two with the balance owed —
          the figure this page exists to clear — across the whole last row,
          instead of a table that scrolls it out of sight. The hairlines are the
          gaps showing the border colour through.

          Values in `<bdi>`, not `dir="ltr"`: a direction on the cell flips
          where its text starts, and «$0.00» drifts to the far side from its label.
        */}
        <dl className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-5">
          {figures.map((figure, position) => (
            <div
              key={figure.label}
              className={cn(
                'min-w-0 bg-card px-4 py-3',
                position === figures.length - 1 && 'col-span-2 sm:col-span-1',
              )}
            >
              <dt className="truncate text-xs text-muted-foreground">{figure.label}</dt>
              <dd
                className={cn(
                  'mt-1 truncate text-base font-semibold tabular-nums',
                  figure.className,
                )}
              >
                <bdi>{figure.value}</bdi>
              </dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

/**
 * One figure: a label, a number, and an optional line under it.
 *
 * Deliberately not a `Card` — a card is the chrome of a section with a heading
 * and contents, and five in a row holding one number each is that chrome
 * applied to a single value.
 */
function Stat({
  icon: Icon,
  label,
  value,
  note,
  emphasis,
  className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={cn('rounded-lg border bg-card p-4', className)}>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {/*
        `<bdi>` rather than `dir="ltr"` on the number: the label sits above its
        value, and giving the value its own direction pushed it to the opposite
        edge from the word naming it.
      */}
      <div
        className={`mt-2 text-2xl font-bold tabular-nums ${
          emphasis ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        }`}
      >
        <bdi>{value}</bdi>
      </div>
      {note ? <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
