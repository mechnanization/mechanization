'use client';

import { use, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  BadgeDollarSign,
  Ban,
  Building,
  Building2,
  Calendar,
  CheckCircle2,
  Clock,
  DollarSign,
  FileText,
  HandCoins,
  Home,
  Info,
  Layers,
  Loader2,
  Mail,
  MapPin,
  Plus,
  Receipt,
  RefreshCw,
  Store,
  Tent,
  TrendingUp,
  User,
  UserCheck,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { InspectorProfileResponse, RecordInspectorPayoutInput } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  getInspectorProfile,
  getMyInspectorProfile,
  getStaff,
  logApiError,
  recordInspectorPayout,
} from '@/lib/api-client';
import type { StaffSummary } from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatDate, formatDateTime } from '@/lib/dates';
import { useGoBack } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import { ActionTooltip } from '@/components/ui/tooltip';
import { MyQualityTasks } from '@/components/admin/quality/my-tasks';
import { OfficerQuality } from '@/components/admin/quality/officer-quality';

export default function InspectorProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
  searchParams?: Promise<{ inspectorId?: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const resolvedSearchParams = searchParams ? use(searchParams) : undefined;
  const inspectorIdParam = resolvedSearchParams?.inspectorId;

  const router = useRouter();
  const goBack = useGoBack();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const isAr = locale !== 'en';
  const labels = getLabels(locale);
  const toast = useToast();
  const queryClient = useQueryClient();

  const [token, setToken] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<{ id: string; role: string; name: string } | null>(null);

  // Payout Dialog state
  const [payoutOpen, setPayoutOpen] = useState(false);
  const [payoutSubmitting, setPayoutSubmitting] = useState(false);
  const [payoutAmount, setPayoutAmount] = useState<string>('');
  const [payoutNote, setPayoutNote] = useState<string>('');
  const [payoutReference, setPayoutReference] = useState<string>('');
  const [payoutDate, setPayoutDate] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [payoutError, setPayoutError] = useState<string | null>(null);

  // Active sub-tab
  const [activeTab, setActiveTab] = useState<'registrations' | 'payouts'>('registrations');

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setCurrentUser({
      id: session.user.id,
      role: session.user.role ?? '',
      name: session.user.name,
    });
  }, [tenant, base, router]);

  const isSuperAdmin = currentUser?.role === 'SUPER_ADMIN';
  /** One spelling of a dollar figure, rather than the five this page had. */
  const money = (n: number) =>
    `${n.toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const targetInspectorId = inspectorIdParam || (isSuperAdmin ? undefined : currentUser?.id);

  const queryKey = ['staff', tenant, 'inspector-profile', targetInspectorId || currentUser?.id || 'me'] as const;

  const { data, loading, fetching, error, refetch } = useStaffQuery<InspectorProfileResponse>({
    queryKey,
    queryFn: (tok, signal) => {
      if (targetInspectorId && targetInspectorId !== currentUser?.id) {
        return getInspectorProfile(tenant, tok, targetInspectorId, signal);
      }
      return getMyInspectorProfile(tenant, tok, signal);
    },
    tenant,
    base,
    token,
    errorMessage: isAr ? 'تعذّر تحميل بيانات المفتش الميداني' : 'Failed to load inspector profile',
  });

  // Load all inspectors if Super Admin
  const { data: staffListData } = useStaffQuery<{ items: StaffSummary[] }>({
    queryKey: ['staff', tenant, 'inspectors-list-summary'],
    queryFn: (tok, signal) => getStaff(tenant, tok, signal),
    tenant,
    base,
    token: isSuperAdmin ? token : null,
    errorMessage: '',
  });

  const fieldInspectors = useMemo(() => {
    return (staffListData?.items ?? []).filter((s) => s.role === 'FIELD_INSPECTOR');
  }, [staffListData]);

  const handleRecordPayout = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !data?.inspector?.id) return;

    const amountNum = parseFloat(payoutAmount);
    if (isNaN(amountNum) || amountNum <= 0) {
      setPayoutError(isAr ? 'يرجى إدخال مبلغ صحيح أكبر من 0' : 'Please enter a valid amount greater than 0');
      return;
    }

    try {
      setPayoutSubmitting(true);
      setPayoutError(null);

      const payload: RecordInspectorPayoutInput = {
        amount: amountNum,
        currency: 'USD',
        paidAt: payoutDate ? new Date(payoutDate).toISOString() : new Date().toISOString(),
        note: payoutNote.trim() || undefined,
        reference: payoutReference.trim() || undefined,
      };

      await recordInspectorPayout(tenant, token, data.inspector.id, payload);

      toast.success(isAr ? 'تم تسجيل الدفعة بنجاح' : 'Payout recorded successfully');
      setPayoutOpen(false);
      setPayoutAmount('');
      setPayoutNote('');
      setPayoutReference('');
      setPayoutDate(new Date().toISOString().slice(0, 10));

      // Refresh query
      await queryClient.invalidateQueries({ queryKey });
    } catch (err) {
      logApiError(err);
      if (err instanceof ApiRequestError) {
        setPayoutError(err.message);
      } else {
        setPayoutError(isAr ? 'تعذّر تسجيل الدفعة' : 'Failed to record payout');
      }
    } finally {
      setPayoutSubmitting(false);
    }
  };

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
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
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
          title={isAr ? 'لوحة أرباح المفتش الميداني' : 'Inspector Earnings Dashboard'}
        />
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="flex flex-col items-center justify-center p-8 text-center">
            <Info className="mb-3 size-10 text-destructive" />
            <p className="text-base font-semibold text-destructive">{error || (isAr ? 'المفتش غير موجود' : 'Inspector not found')}</p>
            <Button variant="outline" className="mt-4" onClick={() => refetch()}>
              {isAr ? 'إعادة المحاولة' : 'Retry'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isViewingSelf = currentUser?.id === data.inspector.id;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Page Header */}
      <PageHeader
        icon={BadgeDollarSign}
        title={
          isViewingSelf
            ? (isAr ? 'أرباحي والمسح الميداني' : 'My Inspector Dashboard & Earnings')
            : (isAr ? `لوحة أداء المفتش: ${data.inspector.name}` : `Inspector Dashboard: ${data.inspector.name}`)
        }
        subtitle={
          isAr
            ? 'إحصاءات كل مفتش ميداني على حدة، والعمولات المستحقة له'
            : 'Per-inspector field activity and the commission owed against it'
        }
        actions={
          <div className="flex items-center gap-2">
            {!isViewingSelf && isSuperAdmin && (
              <Button
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => goBack(`${base}/staff`)}
              >
                {isAr ? <ArrowRight className="size-4" /> : <ArrowLeft className="size-4" />}
                {isAr ? 'العودة للموظفين' : 'Back to Staff'}
              </Button>
            )}

            {isSuperAdmin && (
              <Button
                size="sm"
                className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white dark:bg-emerald-700 dark:hover:bg-emerald-800"
                onClick={() => {
                  setPayoutError(null);
                  setPayoutAmount('');
                  setPayoutNote('');
                  setPayoutReference('');
                  setPayoutDate(new Date().toISOString().slice(0, 10));
                  setPayoutOpen(true);
                }}
              >
                <HandCoins className="size-4" />
                {isAr ? 'تسجيل دفعة للمفتش' : 'Record Payout'}
              </Button>
            )}

            <ActionTooltip label={isAr ? 'تحديث البيانات' : 'Refresh'}>
              <Button
                variant="outline"
                size="icon-sm"
                disabled={fetching}
                onClick={() => refetch()}
              >
                <RefreshCw className={`size-4 ${fetching ? 'animate-spin' : ''}`} />
              </Button>
            </ActionTooltip>
          </div>
        }
      />

      {/* Super Admin Inspector Switcher */}
      {isSuperAdmin && fieldInspectors.length > 0 && (
        <Card>
          <CardContent className="p-3 sm:p-4">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs font-bold text-primary flex items-center gap-1.5">
                <UsersRound className="size-4" />
                {isAr ? 'اختيار المفتش الميداني لعرض أدائه الفردي:' : 'Select Field Inspector to view:'}
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                {fieldInspectors.map((insp: StaffSummary) => {
                  const isSelected = data.inspector.id === insp.id;
                  return (
                    <Button
                      key={insp.id}
                      variant={isSelected ? 'default' : 'outline'}
                      size="sm"
                      className={`text-xs gap-1.5 h-8 ${isSelected ? 'font-bold' : 'bg-background'}`}
                      onClick={() => {
                        router.push(`${base}/inspector/profile?inspectorId=${insp.id}`);
                      }}
                    >
                      <User className="size-3.5" />
                      <span>{insp.fullName}</span>
                      <Badge
                        variant={isSelected ? 'secondary' : 'outline'}
                        className="ms-1 text-[10px] px-1.5 py-0"
                      >
                        {insp.registeredCitizensCount ?? 0} {isAr ? 'مواطن' : 'cit.'} • {insp.registeredPropertiesCount ?? 0} {isAr ? 'عقار' : 'prop.'}
                      </Badge>
                    </Button>
                  );
                })}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/*
        What is waiting on the person looking at their own screen — records a
        reviewer sent back, and re-checks they may do. Renders nothing when
        there is neither, and never appears while looking at somebody else's
        profile: those are their tasks, not this reader's.
      */}
      {!targetInspectorId || targetInspectorId === currentUser?.id ? (
        <MyQualityTasks tenant={tenant} base={base} locale={locale} token={token} />
      ) : null}

      {/* Inspector Info Banner */}
      <Card>
        <CardContent className="p-4 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3.5">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary font-bold text-lg">
                {data.inspector.name.charAt(0)}
              </div>
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold">{data.inspector.name}</h2>
                  <Badge variant="secondary" className="gap-1 text-xs">
                    <UserCheck className="size-3" />
                    {labels.staffRole?.[data.inspector.role as never] ?? data.inspector.role}
                  </Badge>
                  {data.inspector.isActive ? (
                    <Badge variant="outline" className="border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300 gap-1 text-xs">
                      <CheckCircle2 className="size-3" />
                      {isAr ? 'حساب فعّال' : 'Active'}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-destructive gap-1 text-xs">
                      <Ban className="size-3" />
                      {isAr ? 'معطّل' : 'Disabled'}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {data.inspector.email && (
                    <span className="flex items-center gap-1" dir="ltr">
                      <Mail className="size-3.5" />
                      {data.inspector.email}
                    </span>
                  )}
                  <span className="flex items-center gap-1">
                    <Calendar className="size-3.5" />
                    {isAr ? 'انضم في:' : 'Joined:'} {formatDate(data.inspector.createdAt)}
                  </span>
                  {data.inspector.lastLoginAt && (
                    <span className="flex items-center gap-1">
                      <Clock className="size-3.5" />
                      {isAr ? 'آخر دخول:' : 'Last login:'} {formatDateTime(data.inspector.lastLoginAt)}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 self-end sm:self-center">
              <Badge variant="outline" className="px-3 py-1.5 text-xs font-semibold bg-primary/5 text-primary border-primary/20">
                {isAr ? 'معدل العمولة الثابتة: 1.00$ لكل عقار' : 'Fixed Rate: $1.00 USD / Property'}
              </Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/*
        Five figures, one row, plain tiles.

        Each of these carried a 44px colour-filled icon chip and a caption under
        the number, and four of the five captions restated the label directly
        above it — «عمولة لكل عقار مسجل» sat under «العقارات والوحدات المسجلة».
        Five different accent colours across five adjacent tiles meant the
        colour carried no information either: it varied because each tile was
        written separately, not because the numbers differ in kind. One accent
        is left, on the balance still owed, which is the only figure here that
        asks somebody to do something.
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
          value={money(data.totalEarnings)}
          ltr
        />
        <Stat
          icon={Wallet}
          label={isAr ? 'المدفوع' : 'Paid'}
          value={money(data.paidBalance)}
          note={`${data.payouts.length} ${isAr ? 'دفعة مسجلة' : 'payouts'}`}
          ltr
        />
        <Stat
          icon={Clock}
          label={isAr ? 'المتبقي المستحق' : 'Pending'}
          value={money(data.pendingBalance)}
          ltr
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

      {/* Property Types Breakdown Grid */}
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2 text-base font-bold">
                <Layers className="size-5 text-primary" />
                {isAr ? 'توزيع العقارات والوحدات المسجلة' : 'Registered Properties & Units Breakdown'}
              </CardTitle>
              <CardDescription>
                {isAr
                  ? 'تفصيل أنواع العقارات والوحدات التي قام المفتش بمسحها وتسجيلها ميدانياً'
                  : 'Breakdown of property types and residential/commercial units registered in the field'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {/* Houses */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:bg-blue-500/20">
                <Home className="size-5" />
              </div>
              <span className="text-2xl font-bold">{data.breakdown.houses.toLocaleString(locale)}</span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'بيوت مستقلة' : 'Houses'}
              </span>
            </div>

            {/* Apartments */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20">
                <Building2 className="size-5" />
              </div>
              <span className="text-2xl font-bold">{data.breakdown.apartments.toLocaleString(locale)}</span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'شقق سكنية' : 'Apartments'}
              </span>
            </div>

            {/* Commercial */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-purple-500/10 text-purple-600 dark:bg-purple-500/20">
                <Store className="size-5" />
              </div>
              <span className="text-2xl font-bold">{data.breakdown.commercial.toLocaleString(locale)}</span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'محلات وعيادات ومكاتب' : 'Commercial Units'}
              </span>
            </div>

            {/* Buildings */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:bg-indigo-500/20">
                <Building className="size-5" />
              </div>
              <span className="text-2xl font-bold">{data.breakdown.buildings.toLocaleString(locale)}</span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'مبانٍ كاملة' : 'Buildings'}
              </span>
            </div>

            {/* Lands */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:bg-amber-500/20">
                <MapPin className="size-5" />
              </div>
              <span className="text-2xl font-bold">{data.breakdown.lands.toLocaleString(locale)}</span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'أراضٍ' : 'Lands'}
              </span>
            </div>

            {/* Tents & Others */}
            <div className="flex flex-col items-center justify-center rounded-xl border bg-muted/20 p-4 text-center hover:bg-muted/40 transition-colors">
              <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:bg-rose-500/20">
                <Tent className="size-5" />
              </div>
              <span className="text-2xl font-bold">
                {(data.breakdown.tents + data.breakdown.other).toLocaleString(locale)}
              </span>
              <span className="text-xs font-medium text-muted-foreground mt-1">
                {isAr ? 'خيام وأخرى' : 'Tents & Other'}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Tabs for Registration Log vs Payouts */}
      <div className="space-y-4">
        <div className="flex border-b">
          <button
            type="button"
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              activeTab === 'registrations'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('registrations')}
          >
            <FileText className="size-4" />
            {isAr ? 'سجل المسح الميداني والمعاملات' : 'Field Registrations Log'}
            <Badge variant="secondary" className="ms-1.5 text-xs">
              {data.recentRegistrations.length}
            </Badge>
          </button>

          <button
            type="button"
            className={`flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors ${
              activeTab === 'payouts'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('payouts')}
          >
            <Receipt className="size-4" />
            {isAr ? 'سجل الدفعات المستلمة' : 'Payouts History'}
            <Badge variant="secondary" className="ms-1.5 text-xs">
              {data.payouts.length}
            </Badge>
          </button>
        </div>

        {/* Tab 1: Registrations Log */}
        {activeTab === 'registrations' && (
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base font-bold">
                    {isAr ? 'المعاملات والمواطنون المسجلون' : 'Registered Citizens & Properties'}
                  </CardTitle>
                  <CardDescription>
                    {isAr
                      ? 'كل ما سجّله هذا المفتش، والعمولة المستحقة عن كل تسجيل'
                      : 'Everything this inspector registered, and the commission owed on each'}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {data.recentRegistrations.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <Home className="mb-2 size-10 opacity-40" />
                  <p className="text-sm font-medium">
                    {isAr ? 'لم يقم المفتش بتسجيل أي عقارات بعد.' : 'No property registrations recorded yet.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.recentRegistrations.map((item) => (
                    <div
                      key={item.registrationId}
                      className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary mt-0.5">
                          <User className="size-5" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-sm sm:text-base">{item.citizenName}</span>
                            <Badge variant="outline" className="text-xs" dir="ltr">
                              {item.referenceNumber}
                            </Badge>
                            {item.status === 'REQUIRES_REVIEW' ? (
                              <Badge variant="outline" className="border-amber-500/30 bg-amber-500/10 text-amber-700 text-xs">
                                {isAr ? 'يتطلب مراجعة' : 'Requires Review'}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="border-emerald-600/30 bg-emerald-600/10 text-emerald-700 text-xs">
                                {isAr ? 'مكتمل' : 'Completed'}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {isAr ? 'تاريخ التسجيل:' : 'Date:'} {formatDateTime(item.submittedAt)}
                            </span>
                            {item.neighborhoods.length > 0 && (
                              <span>
                                {isAr ? 'الأحياء:' : 'Neighborhoods:'} {item.neighborhoods.join('، ')}
                              </span>
                            )}
                            {item.propertyNumbers.length > 0 && (
                              <span>
                                {isAr ? 'أرقام العقارات:' : 'Property #:'} {item.propertyNumbers.join('، ')}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between sm:justify-end gap-3 pt-2 sm:pt-0 border-t sm:border-t-0">
                        <div className="text-right">
                          <div className="text-xs text-muted-foreground">
                            {item.propertyCount} {isAr ? 'عقار / وحدة' : 'properties'}
                          </div>
                          <div className="text-sm font-extrabold text-emerald-600 dark:text-emerald-400" dir="ltr">
                            +${item.commissionEarned.toFixed(2)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs"
                          onClick={() => router.push(`${base}/citizens`)}
                        >
                          {isAr ? 'عرض بالسجل' : 'View in Registry'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Tab 2: Payouts History */}
        {activeTab === 'payouts' && (
          <Card className="border-border/70">
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <CardTitle className="text-base font-bold">
                    {isAr ? 'سجل الدفعات والمستحقات المسلمة' : 'Recorded Commission Payouts'}
                  </CardTitle>
                  <CardDescription>
                    {isAr
                      ? 'جميع دفعات العمولات المالية المسجلة للمفتش الميداني مع أرقام الإيصالات والتواريخ'
                      : 'All commission disbursements recorded for this field inspector'}
                  </CardDescription>
                </div>
                {isSuperAdmin && (
                  <Button
                    size="sm"
                    className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => {
                      setPayoutError(null);
                      setPayoutAmount('');
                      setPayoutNote('');
                      setPayoutReference('');
                      setPayoutDate(new Date().toISOString().slice(0, 10));
                      setPayoutOpen(true);
                    }}
                  >
                    <Plus className="size-4" />
                    {isAr ? 'تسجيل دفعة جديدة' : 'Record New Payout'}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.payouts.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
                  <Receipt className="mb-2 size-10 opacity-40" />
                  <p className="text-sm font-medium">
                    {isAr ? 'لا توجد دفعات مسجلة بعد.' : 'No payouts recorded yet.'}
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {data.payouts.map((payout) => (
                    <div
                      key={payout.id}
                      className="flex flex-col gap-3 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between bg-card hover:bg-muted/30 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 mt-0.5">
                          <DollarSign className="size-5" />
                        </div>
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-extrabold text-base text-emerald-600 dark:text-emerald-400" dir="ltr">
                              ${payout.amount.toFixed(2)} {payout.currency}
                            </span>
                            {payout.reference && (
                              <Badge variant="outline" className="text-xs">
                                {isAr ? 'سند رقم:' : 'Ref:'} {payout.reference}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                            <span>
                              {isAr ? 'تاريخ الدفع:' : 'Paid on:'} {formatDateTime(payout.paidAt)}
                            </span>
                            {payout.recordedByName && (
                              <span>
                                {isAr ? 'سُجلت بواسطة:' : 'Recorded by:'} {payout.recordedByName}
                              </span>
                            )}
                          </div>
                          {payout.note && (
                            <p className="text-xs text-muted-foreground mt-1 bg-muted/40 p-2 rounded-lg">
                              {payout.note}
                            </p>
                          )}
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

      {/* Record Payout Dialog (Super Admin) */}
      <Dialog open={payoutOpen} onOpenChange={setPayoutOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandCoins className="size-5 text-emerald-600" />
              {isAr ? 'تسجيل دفعة عمولة للمفتش' : 'Record Inspector Commission Payout'}
            </DialogTitle>
            <DialogDescription>
              {isAr
                ? `تسجيل تسليم مبلغ مالي للمفتش ${data.inspector.name}. يتم خصمه من الرصيد المتبقي.`
                : `Record a commission payment to ${data.inspector.name}. This reduces their pending balance.`}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleRecordPayout} className="space-y-4 py-2">
            {payoutError && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs font-semibold text-destructive">
                {payoutError}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="amount" className="text-xs font-semibold">
                {isAr ? 'المبلغ المسلّم ($ USD) *' : 'Amount ($ USD) *'}
              </Label>
              <div className="relative">
                <Input
                  id="amount"
                  type="number"
                  step="0.5"
                  min="0.5"
                  placeholder="0.00"
                  required
                  value={payoutAmount}
                  onChange={(e) => setPayoutAmount(e.target.value)}
                  className="pe-12 text-lg font-bold"
                  dir="ltr"
                />
                <span className="absolute end-3 top-2.5 text-xs font-bold text-muted-foreground">
                  USD
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {isAr ? `الرصيد المتبقي حالياً: $${data.pendingBalance.toFixed(2)} USD` : `Current pending balance: $${data.pendingBalance.toFixed(2)} USD`}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="date" className="text-xs font-semibold">
                {isAr ? 'تاريخ الدفع' : 'Payment Date'}
              </Label>
              <Input
                id="date"
                type="date"
                value={payoutDate}
                onChange={(e) => setPayoutDate(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="reference" className="text-xs font-semibold">
                {isAr ? 'رقم الإيصال / السند (اختياري)' : 'Receipt / Reference Number (Optional)'}
              </Label>
              <Input
                id="reference"
                placeholder={isAr ? 'مثال: REC-2026-004' : 'e.g. REC-2026-004'}
                value={payoutReference}
                onChange={(e) => setPayoutReference(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="note" className="text-xs font-semibold">
                {isAr ? 'ملاحظات (اختياري)' : 'Notes (Optional)'}
              </Label>
              <Textarea
                id="note"
                rows={2}
                placeholder={isAr ? 'مثال: دفعة نقدية عن مسح حي الزهور' : 'e.g. Cash payment for neighborhood survey'}
                value={payoutNote}
                onChange={(e) => setPayoutNote(e.target.value)}
              />
            </div>

            <DialogFooter className="gap-2 sm:gap-0 pt-2">
              <Button
                type="button"
                variant="outline"
                disabled={payoutSubmitting}
                onClick={() => setPayoutOpen(false)}
              >
                {isAr ? 'إلغاء' : 'Cancel'}
              </Button>
              <Button
                type="submit"
                className="bg-emerald-600 hover:bg-emerald-700 text-white"
                disabled={payoutSubmitting}
              >
                {payoutSubmitting ? (
                  <>
                    <Loader2 className="me-1.5 size-4 animate-spin" />
                    {isAr ? 'جاري الحفظ...' : 'Saving...'}
                  </>
                ) : (
                  isAr ? 'حفظ الدفعة' : 'Record Payout'
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One figure: a label, a number, and an optional line under it.
 *
 * Deliberately not a `Card`. A card is a container for a section with a
 * heading and its own contents; five of them in a row holding one number each
 * is the chrome of a section applied to a single value.
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
  /** Latin numerals and a leading $ read left-to-right inside an RTL page. */
  ltr?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
      <div
        className={
          'mt-2 text-2xl font-bold tabular-nums ' +
          (emphasis ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')
        }
        dir={ltr ? 'ltr' : undefined}
      >
        {value}
      </div>
      {note ? <p className="mt-1 text-xs text-muted-foreground">{note}</p> : null}
    </div>
  );
}
