'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  BadgeDollarSign,
  CheckCircle2,
  Clock,
  HandCoins,
  Home,
  Mail,
  Receipt,
  RefreshCw,
  TrendingUp,
  UserCheck,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getStaff } from '@/lib/api-client';
import type { StaffSummary } from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { useStaffQuery } from '@/lib/use-staff-query';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ActionTooltip } from '@/components/ui/tooltip';

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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
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
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
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
          ltr
        />
        <Stat
          icon={Wallet}
          label={isAr ? 'إجمالي المدفوع' : 'Total paid'}
          value={`$${money(totals.paid, locale)}`}
          ltr
        />
        <Stat
          icon={Clock}
          label={isAr ? 'إجمالي المتبقي' : 'Total pending'}
          value={`$${money(totals.pending, locale)}`}
          ltr
          emphasis
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
        pendingBalance={payoutFor?.pendingBalance}
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

  return (
    <Card className="overflow-hidden border-border/70">
      <CardHeader className="gap-3 space-y-0 border-b bg-muted/20 pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden
            className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-lg font-bold text-primary"
          >
            {inspector.fullName.charAt(0)}
          </span>
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              {/*
                The name is the way into the full dashboard — the survey log,
                the property-type breakdown, every payout. Two buttons already
                sit on this card; a third labelled «عرض» would compete with the
                one that actually moves money.
              */}
              <Link
                href={`${base}/inspector/profile/${inspector.id}`}
                className="truncate text-base font-bold hover:underline"
              >
                {inspector.fullName}
              </Link>
              <Badge variant="secondary" className="gap-1 text-xs">
                <UserCheck className="size-3" aria-hidden />
                {roleLabel}
              </Badge>
              {inspector.isActive ? (
                <Badge
                  variant="outline"
                  className="gap-1 border-emerald-600/30 bg-emerald-600/10 text-xs text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                >
                  <CheckCircle2 className="size-3" aria-hidden />
                  {isAr ? 'فعّال' : 'Active'}
                </Badge>
              ) : (
                <Badge variant="outline" className="gap-1 text-xs text-destructive">
                  <Ban className="size-3" aria-hidden />
                  {isAr ? 'معطّل' : 'Disabled'}
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {inspector.email ? (
                <span className="flex items-center gap-1 truncate" dir="ltr">
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                  {inspector.email}
                </span>
              ) : null}
              <span>
                {isAr ? 'انضم في:' : 'Joined:'} {formatDate(inspector.createdAt)}
              </span>
              <span>
                {isAr ? 'آخر دخول:' : 'Last login:'}{' '}
                {inspector.lastLoginAt ? formatDate(inspector.lastLoginAt) : isAr ? 'لم يدخل بعد' : 'never'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
      </CardHeader>

      <CardContent className="p-0">
        {/*
          A table rather than five tiles: these are the same five measures for
          every inspector on the page, and a column is what lets one card be
          read against the one below it.

          The scroll container is this file's to supply — `Table` is a bare
          `<table>` by design, leaving it to whoever knows how wide the screen
          is. Five columns do not fit a phone, and the card's `overflow-hidden`
          would otherwise clip the pending balance, which is the column that
          matters most.
        */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{isAr ? 'المواطنون' : 'Citizens'}</TableHead>
                <TableHead>{isAr ? 'العقارات والوحدات' : 'Properties & units'}</TableHead>
                <TableHead>{isAr ? 'إجمالي الأرباح' : 'Earned'}</TableHead>
                <TableHead>{isAr ? 'المدفوع' : 'Paid'}</TableHead>
                <TableHead>{isAr ? 'المتبقي المستحق' : 'Pending'}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="hover:bg-transparent">
                <TableCell className="text-base font-semibold tabular-nums">
                  {citizens.toLocaleString(locale)}
                </TableCell>
                <TableCell className="text-base font-semibold tabular-nums">
                  {properties.toLocaleString(locale)}
                </TableCell>
                <TableCell className="text-base font-semibold tabular-nums" dir="ltr">
                  ${money(earned, locale)}
                </TableCell>
                <TableCell
                  className="text-base font-semibold tabular-nums text-emerald-600 dark:text-emerald-400"
                  dir="ltr"
                >
                  ${money(paid, locale)}
                </TableCell>
                <TableCell
                  className={`text-base font-bold tabular-nums ${
                    pending > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                  }`}
                  dir="ltr"
                >
                  ${money(pending, locale)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
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
  ltr,
  emphasis,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
  /** Latin numerals and a leading `$` read left-to-right inside an RTL page. */
  ltr?: boolean;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div
        className={`mt-2 text-2xl font-bold tabular-nums ${
          emphasis ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        }`}
        dir={ltr ? 'ltr' : undefined}
      >
        {value}
      </div>
      {note ? <p className="mt-1 truncate text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
