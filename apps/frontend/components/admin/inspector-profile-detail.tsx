'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  Building,
  Building2,
  Clock,
  FileText,
  HandCoins,
  Home,
  Layers,
  MapPin,
  Receipt,
  RefreshCw,
  Store,
  Tent,
  TrendingUp,
  User,
  Users,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { InspectorProfileResponse } from '@mechanization/shared-schemas';
import { getInspectorProfile, getMyInspectorProfile } from '@/lib/api-client';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate, formatDateTime } from '@/lib/dates';
import { InspectorPayoutDialog } from '@/components/admin/inspector-payout-dialog';
import { MyQualityTasks } from '@/components/admin/quality/my-tasks';
import { OfficerQuality } from '@/components/admin/quality/officer-quality';
import { useGoBack } from '@/components/ui/back-link';
import { FactCell, FactRow } from '@/components/ui/facts';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { ActionTooltip } from '@/components/ui/tooltip';

/**
 * One inspector's field work and the commission it earned.
 *
 * Reached three ways — an inspector opening «أرباحي», an administrator
 * clicking a name on the roster, and the staff directory's per-row shortcut —
 * which is why it is a component rather than a page. The roster answers «who
 * is owed what»; this answers «what did they do to earn it».
 */
export function InspectorProfileDetail({
  tenant,
  locale,
  base,
  token,
  currentUser,
  staffId,
}: {
  tenant: string;
  locale: string;
  /** `/{tenant}/{locale}/{adminPath}` — what every admin link hangs off. */
  base: string;
  token: string | null;
  currentUser: { id: string; role: string; name: string } | null;
  /** Whose dashboard. Undefined means the signed-in reader's own. */
  staffId?: string;
}): React.JSX.Element {
  const router = useRouter();
  const goBack = useGoBack();
  const isAr = locale !== 'en';
  const labels = getLabels(locale);
  const queryClient = useQueryClient();

  const [payoutOpen, setPayoutOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'registrations' | 'payouts'>('registrations');

  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  const targetId = staffId ?? currentUser?.id;

  const money = (value: number): string =>
    value.toLocaleString(locale === 'en' ? 'en-US' : 'en-GB', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const queryKey = ['staff', tenant, 'inspector-profile', targetId ?? 'me'] as const;

  const { data, loading, fetching, error, refetch } = useStaffQuery<InspectorProfileResponse>({
    queryKey,
    queryFn: (tok, signal) => {
      /*
        `inspectors/:id/profile` is open to SUPER_ADMIN and to an inspector
        asking about themselves — no one else. Every other role (collector,
        accountant, auditor) reaches their own figures through `me/profile`,
        so asking by id for the reader's own row would 403 them off their own
        landing page.
      */
      if (targetId && targetId !== currentUser?.id) {
        return getInspectorProfile(tenant, tok, targetId, signal);
      }
      return getMyInspectorProfile(tenant, tok, signal);
    },
    tenant,
    base,
    token,
    errorMessage: isAr ? 'تعذّر تحميل بيانات المفتش الميداني' : 'Failed to load the inspector profile',
  });

  if (loading || !token) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <div className="flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <div className="space-y-2">
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-4 w-96" />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-48 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        <PageHeader
          icon={BadgeDollarSign}
          title={isAr ? 'لوحة أرباح المفتش الميداني' : 'Inspector earnings'}
        />
        <Card>
          <CardContent className="p-0">
            <ErrorState
              description={error ?? (isAr ? 'المفتش غير موجود' : 'Inspector not found')}
              onRetry={() => refetch()}
              retryLabel={isAr ? 'إعادة المحاولة' : 'Retry'}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const isViewingSelf = currentUser?.id === data.inspector.id;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={BadgeDollarSign}
        title={
          isViewingSelf
            ? isAr
              ? 'أرباحي والمسح الميداني'
              : 'My earnings & field work'
            : isAr
              ? `أرباح المفتش: ${data.inspector.name}`
              : `Inspector earnings: ${data.inspector.name}`
        }
        subtitle={
          isAr
            ? 'نشاط المسح الميداني، والعمولة المستحقة عنه بمعدل 1.00$ لكل عقار أو وحدة'
            : 'Field survey activity and the commission owed against it, at $1.00 per property or unit'
        }
        actions={
          <div className="flex items-center gap-2">
            {!isViewingSelf && isSuperAdmin ? (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => goBack(`${base}/inspector/profile`)}
              >
                {isAr ? <ArrowRight className="size-4" aria-hidden /> : <ArrowLeft className="size-4" aria-hidden />}
                {isAr ? 'العودة للأرباح' : 'Back to earnings'}
              </Button>
            ) : null}

            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href={`${base}/inspector/profile/${data.inspector.id}/payouts`}>
                <Receipt className="size-4" aria-hidden />
                {isAr ? 'سجل الدفعات' : 'History'}
              </Link>
            </Button>

            {isSuperAdmin ? (
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-700 dark:hover:bg-emerald-800"
                onClick={() => setPayoutOpen(true)}
              >
                <HandCoins className="size-4" aria-hidden />
                {isAr ? 'تسجيل دفعة' : 'Pay'}
              </Button>
            ) : null}

            <ActionTooltip label={isAr ? 'تحديث البيانات' : 'Refresh'}>
              <Button variant="outline" size="icon-sm" disabled={fetching} onClick={() => refetch()}>
                <RefreshCw className={`size-4 ${fetching ? 'animate-spin' : ''}`} aria-hidden />
                <span className="sr-only">{isAr ? 'تحديث' : 'Refresh'}</span>
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      {/*
        What is waiting on the person looking at their own screen — records a
        reviewer sent back, and re-checks they may do. Renders nothing when
        there is neither, and never appears while looking at somebody else's
        profile: those are their tasks, not this reader's.
      */}
      {isViewingSelf ? (
        <MyQualityTasks tenant={tenant} base={base} locale={locale} token={token} />
      ) : null}

      {/* Who this is */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3.5">
              <span
                aria-hidden
                className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-lg font-bold text-primary"
              >
                {data.inspector.name.charAt(0)}
              </span>
              {/*
                The same aligned block the roster card carries, so an inspector
                reads identically whichever screen you reached them from. The
                role and the account state were filled pills on the name's line;
                they are values, and a value belongs under its label.
              */}
              <div className="min-w-0 space-y-2">
                <h2 className="text-lg font-bold">{data.inspector.name}</h2>
                <FactRow>
                  <FactCell
                    label={isAr ? 'الصفة' : 'Role'}
                    value={labels.staffRole?.[data.inspector.role as never] ?? data.inspector.role}
                  />
                  <FactCell
                    label={isAr ? 'الحساب' : 'Account'}
                    className={
                      data.inspector.isActive
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-destructive'
                    }
                    value={
                      data.inspector.isActive
                        ? isAr
                          ? 'فعّال'
                          : 'Active'
                        : isAr
                          ? 'معطّل'
                          : 'Disabled'
                    }
                  />
                  {data.inspector.email ? (
                    <FactCell
                      label={isAr ? 'البريد' : 'Email'}
                      className="max-w-[16rem]"
                      value={data.inspector.email}
                    />
                  ) : null}
                  <FactCell
                    label={isAr ? 'انضم في' : 'Joined'}
                    value={formatDate(data.inspector.createdAt)}
                  />
                  {data.inspector.lastLoginAt ? (
                    <FactCell
                      label={isAr ? 'آخر دخول' : 'Last login'}
                      value={formatDateTime(data.inspector.lastLoginAt)}
                    />
                  ) : null}
                  <FactCell
                    label={isAr ? 'معدل العمولة' : 'Rate'}
                    value={isAr ? '$1.00 لكل عقار أو وحدة' : '$1.00 per property or unit'}
                  />
                </FactRow>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/*
        Five figures, one row, plain tiles. One accent, on the balance still
        owed, which is the only figure here that asks somebody to do something.
      */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          icon={Users}
          label={isAr ? 'المواطنون المسجلون' : 'Citizens registered'}
          value={data.totalCitizens.toLocaleString(locale)}
        />
        <Stat
          icon={Home}
          label={isAr ? 'العقارات والوحدات' : 'Properties & units'}
          value={data.totalProperties.toLocaleString(locale)}
        />
        <Stat
          icon={TrendingUp}
          label={isAr ? 'إجمالي الأرباح' : 'Total earned'}
          value={`$${money(data.totalEarnings)}`}
        />
        <Stat
          icon={Wallet}
          label={isAr ? 'المدفوع' : 'Paid'}
          value={`$${money(data.paidBalance)}`}
          note={`${data.payouts.length} ${isAr ? 'دفعة مسجلة' : 'payouts'}`}
        />
        <Stat
          icon={Clock}
          label={isAr ? 'المتبقي المستحق' : 'Pending'}
          value={`$${money(data.pendingBalance)}`}
          emphasis
        />
      </div>

      {/*
        The work beside its quality — the same figures «مراجعة الجودة» shows,
        for this one person. Read-only and never about pay: the earnings above
        count every property this officer filed, whatever a review said about it.
      */}
      <section className="space-y-2" aria-labelledby="officer-quality">
        <h2 id="officer-quality" className="text-base font-bold">
          {isAr ? 'جودة البيانات المسجَّلة' : 'Quality of what was filed'}
        </h2>
        <OfficerQuality
          tenant={tenant}
          base={base}
          locale={locale}
          token={token}
          officerId={data.inspector.id}
        />
      </section>

      {/* What was surveyed */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-bold">
            <Layers className="size-5 text-primary" aria-hidden />
            {isAr ? 'توزيع العقارات والوحدات المسجلة' : 'Registered properties & units'}
          </CardTitle>
          <CardDescription>
            {isAr
              ? 'تفصيل أنواع العقارات والوحدات التي مسحها هذا المفتش ميدانياً'
              : 'The property and unit types this inspector surveyed in the field'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <BreakdownTile
              icon={Home}
              tone="text-blue-600 bg-blue-500/10 dark:bg-blue-500/20"
              value={data.breakdown.houses}
              label={isAr ? 'بيوت مستقلة' : 'Houses'}
              locale={locale}
            />
            <BreakdownTile
              icon={Building2}
              tone="text-emerald-600 bg-emerald-500/10 dark:bg-emerald-500/20"
              value={data.breakdown.apartments}
              label={isAr ? 'شقق سكنية' : 'Apartments'}
              locale={locale}
            />
            <BreakdownTile
              icon={Store}
              tone="text-purple-600 bg-purple-500/10 dark:bg-purple-500/20"
              value={data.breakdown.commercial}
              label={isAr ? 'محلات وعيادات ومكاتب' : 'Commercial units'}
              locale={locale}
            />
            <BreakdownTile
              icon={Building}
              tone="text-indigo-600 bg-indigo-500/10 dark:bg-indigo-500/20"
              value={data.breakdown.buildings}
              label={isAr ? 'مبانٍ كاملة' : 'Buildings'}
              locale={locale}
            />
            <BreakdownTile
              icon={MapPin}
              tone="text-amber-600 bg-amber-500/10 dark:bg-amber-500/20"
              value={data.breakdown.lands}
              label={isAr ? 'أراضٍ' : 'Lands'}
              locale={locale}
            />
            <BreakdownTile
              icon={Tent}
              tone="text-rose-600 bg-rose-500/10 dark:bg-rose-500/20"
              value={data.breakdown.tents + data.breakdown.other}
              label={isAr ? 'خيام وأخرى' : 'Tents & other'}
              locale={locale}
            />
          </div>
        </CardContent>
      </Card>

      {/* The log, and the money against it */}
      <div className="space-y-4">
        <div className="flex border-b">
          <TabButton
            active={activeTab === 'registrations'}
            onClick={() => setActiveTab('registrations')}
            icon={FileText}
            label={isAr ? 'سجل المسح الميداني' : 'Field survey log'}
            count={data.recentRegistrations.length}
          />
          <TabButton
            active={activeTab === 'payouts'}
            onClick={() => setActiveTab('payouts')}
            icon={Receipt}
            label={isAr ? 'الدفعات المستلمة' : 'Payouts'}
            count={data.payouts.length}
          />
        </div>

        {activeTab === 'registrations' ? (
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <CardTitle className="text-base font-bold">
                {isAr ? 'المعاملات والمواطنون المسجلون' : 'Registered citizens & properties'}
              </CardTitle>
              <CardDescription>
                {isAr
                  ? 'كل ما سجّله هذا المفتش، والعمولة المستحقة عن كل تسجيل'
                  : 'Everything this inspector registered, and the commission owed on each'}
              </CardDescription>
            </CardHeader>
            <CardContent className={data.recentRegistrations.length === 0 ? 'p-0' : undefined}>
              {data.recentRegistrations.length === 0 ? (
                <EmptyState
                  icon={Home}
                  compact
                  title={isAr ? 'لا تسجيلات بعد' : 'No registrations yet'}
                  description={
                    isAr
                      ? 'كل عقار أو وحدة يسجّلها هذا المفتش تظهر هنا وتضيف 1.00$ إلى رصيده.'
                      : 'Every property or unit this inspector registers appears here and adds $1.00 to their balance.'
                  }
                />
              ) : (
                <div className="space-y-3">
                  {data.recentRegistrations.map((item) => (
                    <div
                      key={item.registrationId}
                      className="flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          aria-hidden
                          className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"
                        >
                          <User className="size-5" />
                        </span>
                        <div className="space-y-1">
                          <span className="text-sm font-bold sm:text-base">{item.citizenName}</span>
                          <FactRow columns>
                            <FactCell
                              label={isAr ? 'الرقم المرجعي' : 'Reference'}
                              className="font-mono"
                              value={item.referenceNumber}
                            />
                            <FactCell
                              label={isAr ? 'الحالة' : 'Status'}
                              className={
                                item.status === 'REQUIRES_REVIEW'
                                  ? 'text-amber-700 dark:text-amber-400'
                                  : 'text-emerald-700 dark:text-emerald-400'
                              }
                              value={
                                item.status === 'REQUIRES_REVIEW'
                                  ? isAr
                                    ? 'يتطلب مراجعة'
                                    : 'Requires review'
                                  : isAr
                                    ? 'مكتمل'
                                    : 'Completed'
                              }
                            />
                            <FactCell
                              label={isAr ? 'تاريخ التسجيل' : 'Date'}
                              value={formatDateTime(item.submittedAt)}
                            />
                            {item.neighborhoods.length > 0 ? (
                              <FactCell
                                label={isAr ? 'الأحياء' : 'Neighborhoods'}
                                value={item.neighborhoods.join('، ')}
                              />
                            ) : null}
                            {item.propertyNumbers.length > 0 ? (
                              <FactCell
                                label={isAr ? 'أرقام العقارات' : 'Property #'}
                                value={item.propertyNumbers.join('، ')}
                              />
                            ) : null}
                          </FactRow>
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 border-t pt-2 sm:justify-end sm:border-t-0 sm:pt-0">
                        <div className="text-end">
                          <div className="text-xs text-muted-foreground">
                            {item.propertyCount} {isAr ? 'عقار / وحدة' : 'properties'}
                          </div>
                          <div className="text-sm font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
                            <bdi>+${money(item.commissionEarned)}</bdi>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => router.push(`${base}/citizens/${item.citizenId}`)}
                        >
                          {isAr ? 'عرض بالسجل' : 'View in registry'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        ) : (
          <Card className="border-border/70">
            <CardHeader className="gap-2 space-y-0 pb-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1.5">
                <CardTitle className="text-base font-bold">
                  {isAr ? 'الدفعات المسجلة' : 'Recorded payouts'}
                </CardTitle>
                <CardDescription>
                  {isAr
                    ? 'آخر الدفعات المسلّمة لهذا المفتش. السجل الكامل في صفحة سجل الدفعات.'
                    : 'The payouts handed to this inspector. The full ledger is on the history page.'}
                </CardDescription>
              </div>
              <Button asChild variant="outline" size="sm" className="shrink-0 gap-1.5">
                <Link href={`${base}/inspector/profile/${data.inspector.id}/payouts`}>
                  <Receipt className="size-4" aria-hidden />
                  {isAr ? 'فتح سجل الدفعات' : 'Open history'}
                </Link>
              </Button>
            </CardHeader>
            <CardContent className={data.payouts.length === 0 ? 'p-0' : undefined}>
              {data.payouts.length === 0 ? (
                <EmptyState
                  icon={Receipt}
                  compact
                  title={isAr ? 'لا دفعات مسجلة' : 'No payouts recorded'}
                  description={
                    isAr
                      ? 'لم يُسجَّل أي تسليم مبلغ لهذا المفتش حتى الآن.'
                      : 'Nothing has been handed over to this inspector yet.'
                  }
                />
              ) : (
                <div className="space-y-3">
                  {data.payouts.map((payout) => (
                    <div
                      key={payout.id}
                      className="flex flex-col gap-3 rounded-xl border bg-card p-4 transition-colors hover:bg-muted/30 sm:flex-row sm:items-center sm:justify-between"
                    >
                      <div className="flex items-start gap-3">
                        <span
                          aria-hidden
                          className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20"
                        >
                          <HandCoins className="size-5" />
                        </span>
                        <div className="min-w-0 space-y-1.5">
                          <span className="block text-base font-extrabold tabular-nums text-emerald-600 dark:text-emerald-400">
                            <bdi>
                              ${money(payout.amount)} {payout.currency}
                            </bdi>
                          </span>
                          <FactRow columns>
                            {payout.reference ? (
                              <FactCell
                                label={isAr ? 'رقم الإيصال' : 'Receipt'}
                                className="font-mono"
                                value={payout.reference}
                              />
                            ) : null}
                            <FactCell
                              label={isAr ? 'تاريخ الدفع' : 'Paid on'}
                              value={formatDateTime(payout.paidAt)}
                            />
                            {payout.recordedByName ? (
                              <FactCell
                                label={isAr ? 'سُجّلت بواسطة' : 'Recorded by'}
                                value={payout.recordedByName}
                              />
                            ) : null}
                            {/* Capped: a note is prose, and uncapped it would
                                take the whole row and push the dates off it. */}
                            {payout.note ? (
                              <FactCell
                                label={isAr ? 'ملاحظات' : 'Notes'}
                                className="max-w-sm text-muted-foreground"
                                value={payout.note}
                              />
                            ) : null}
                          </FactRow>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <InspectorPayoutDialog
        open={payoutOpen}
        onOpenChange={setPayoutOpen}
        tenant={tenant}
        token={token}
        locale={locale}
        staff={{ id: data.inspector.id, name: data.inspector.name }}
        pendingBalance={data.pendingBalance}
        onRecorded={async () => {
          await Promise.all([
            queryClient.invalidateQueries({ queryKey }),
            // The roster and the staff directory both show this balance.
            queryClient.invalidateQueries({ queryKey: ['staff', tenant] }),
          ]);
        }}
      />
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  count: number;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
        active
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {label}
      {/* The count is a value, so it is a number — not a filled pill sitting
          inside a control that is already a shape of its own. */}
      <span className="ms-1 text-xs font-normal tabular-nums opacity-70">
        <bdi>({count})</bdi>
      </span>
    </button>
  );
}

function BreakdownTile({
  icon: Icon,
  tone,
  value,
  label,
  locale,
}: {
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  value: number;
  label: string;
  locale: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center transition-colors hover:bg-muted/40">
      <span
        aria-hidden
        className={`mb-2 flex size-10 items-center justify-center rounded-lg ${tone}`}
      >
        <Icon className="size-5" />
      </span>
      <span className="text-2xl font-bold tabular-nums">{value.toLocaleString(locale)}</span>
      <span className="mt-1 text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
  note,
  emphasis,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  note?: string;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      {/*
        `<bdi>` rather than `dir="ltr"`: the label sits above its value, and a
        value carrying its own direction lands on the opposite edge from the
        word naming it — see `FactGrid` for why this keeps catching us out.
      */}
      <div
        className={`mt-2 text-2xl font-bold tabular-nums ${
          emphasis ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'
        }`}
      >
        <bdi>{value}</bdi>
      </div>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
