'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  ArrowDown,
  ArrowUp,
  BadgeDollarSign,
  Banknote,
  BarChart3,
  Building,
  Building2,
  ChevronDown,
  ChevronLeft,
  Download,
  Home,
  Layers,
  LayoutDashboard,
  Map as MapIcon,
  Minus,
  Receipt,
  RefreshCw,
  Store,
  Stethoscope,
  Tent,
  Trees,
  TrendingUp,
  TriangleAlert,
  Users,
  UsersRound,
  Wallet,
} from 'lucide-react';
import {
  ApiRequestError,
  getDashboardAnalytics,
  getMyInspectorProfile,
  logApiError,
  type DashboardAnalytics,
} from '@/lib/api-client';
import { ar, type InspectorProfileResponse } from '@mechanization/shared-schemas';
import { clearSession, loadSession } from '@/lib/session';
import { formatLbp } from '@/lib/currency';
import { formatMonth } from '@/lib/dates';
import { Button, buttonVariants } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ChartCard,
  ColumnChart,
  GroupedColumnChart,
  type SeriesKey,
} from '@/components/admin/charts';
import { cn } from '@/lib/utils';

/**
 * Household sizes are bucketed at 8: past that the bars are single households
 * and the distribution's shape is lost in a long tail of ones.
 */
const FAMILY_BUCKET_CAP = 8;

/** Which detail sections start folded, and where that choice is remembered. */
const FOLD_STORAGE_KEY = 'mechanization.dashboard.folds';
const DEFAULT_FOLDED: ReadonlySet<string> = new Set(['units']);

/**
 * The unit cards, in display order.
 *
 * `unitsByType` is keyed by `UnitType` (شقة / عيادة / محل) and
 * `propertiesByType` by `PropertyType` (مبنى / منزل / أرض / خيمة) — two
 * different enums, so each card names which of the two it reads. Labels are
 * spelled out here rather than taken from `ar.unitType` because these are
 * municipal-register categories ("مستوصف / عيادة"), which read differently
 * from the single word a citizen picks in a form.
 */
const UNIT_CARDS = [
  { source: 'unit', key: 'APARTMENT', label: 'شقق سكنية', labelEn: 'Residential Apartments', icon: Building2 },
  { source: 'property', key: 'HOUSE', label: 'منازل مستقلة', labelEn: 'Standalone Houses', icon: Home },
  { source: 'unit', key: 'SHOP', label: 'أقسام ووحدات تجارية', labelEn: 'Commercial Units & Shops', icon: Store },
  { source: 'unit', key: 'CLINIC', label: 'مستوصفات وعيادات', labelEn: 'Clinics & Dispensaries', icon: Stethoscope },
  { source: 'property', key: 'BUILDING', label: 'مبانٍ مسجّلة', labelEn: 'Registered Buildings', icon: Building },
  { source: 'property', key: 'LAND', label: 'أراضٍ', labelEn: 'Land Parcels', icon: Trees },
  { source: 'property', key: 'TENT', label: 'خيام', labelEn: 'Tents & Temporary', icon: Tent },
] as const;

/**
 * Picks one unit for a whole money axis.
 */
function moneyAxis(max: number, locale: string = 'ar'): { divisor: number; unit: string } {
  if (max >= 1_000_000_000) {
    return { divisor: 1_000_000_000, unit: locale === 'en' ? 'B LBP' : 'مليار ل.ل' };
  }
  if (max >= 1_000_000) {
    return { divisor: 1_000_000, unit: locale === 'en' ? 'M LBP' : 'مليون ل.ل' };
  }
  if (max >= 1_000) {
    return { divisor: 1_000, unit: locale === 'en' ? 'k LBP' : 'ألف ل.ل' };
  }
  return { divisor: 1, unit: locale === 'en' ? 'LBP' : 'ل.ل' };
}

/** `2026-08` → `أغسطس` or `Aug` (+ the year, for the tooltip and the table). */
function monthLabels(month: string, locale: string = 'ar'): { short: string; long: string } {
  const [year, index] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, (index ?? 1) - 1, 1));
  return {
    short: formatMonth(date, { month: 'short', timeZone: 'UTC' }, locale),
    long: formatMonth(date, { month: 'long', year: 'numeric', timeZone: 'UTC' }, locale),
  };
}

/** `12480` → `12,480`, or a skeleton's worth of nothing while it loads. */
function count(value: number | undefined): string {
  return value?.toLocaleString('en-US') ?? '—';
}

/**
 * Change between the two most recently *completed* months of `monthly`.
 *
 * The current calendar month (the series' last entry) is still accruing —
 * on the 1st it holds almost nothing — so comparing it against last month
 * would make every dashboard load near the start of a month read as a
 * collapse. Comparing the two months before it instead means the figure
 * never depends on what day of the month it happens to be.
 */
function monthlyTrend(
  monthly: DashboardAnalytics['monthly'] | undefined,
  key: 'collected' | 'overdue',
  goodWhenUp: boolean,
  locale: string,
): { pct: number; goodWhenUp: boolean; caption: string } | null {
  if (!monthly || monthly.length < 3) return null;
  const current = monthly[monthly.length - 2];
  const previous = monthly[monthly.length - 3];
  if (previous[key] === 0) return null;

  const pct = ((current[key] - previous[key]) / previous[key]) * 100;
  const currentLabel = monthLabels(current.month, locale).short;
  const previousLabel = monthLabels(previous.month, locale).short;
  return {
    pct,
    goodWhenUp,
    caption: locale === 'en' ? `${currentLabel} vs ${previousLabel}` : `${currentLabel} مقابل ${previousLabel}`,
  };
}

/**
 * لوحة التحكم — the municipality's analytics overview.
 *
 * This screen used to be the review queue: one table row per طلب, with the
 * status transitions inline. It is now what a دفتر البلدية opens on — how many
 * people the municipality actually serves, what it is owed, what it has
 * collected, and where the review pipeline is congested. The per-record work
 * moved to the pages that own those records (the citizens registry, each
 * citizen's profile, the fees screen), and the shortcuts at the foot of this
 * page are the way into them.
 *
 * Everything on it comes from a single `/dashboard/analytics` call, so the
 * headline tiles and the charts underneath cannot contradict each other.
 *
 * **Layout.** Four KPI cards carry the figures an admin opens this page for,
 * each with the counts that qualify it — the household count, the property and
 * unit totals, the outstanding balance, the payments awaiting verification —
 * under a rule beneath it, rather than spread across nine tiles competing for
 * the same glance.
 *
 * The panels were briefly click-to-expand and are now always open: a figure an
 * admin has to go looking for is a figure they stop reading, and the row is
 * short enough that folding bought nothing. What that costs is vertical space,
 * so the cards are held to one height and each figure appears exactly once —
 * every supporting line here is one the headline above it does not already
 * say. The two sections below (the unit breakdown, the charts) do still fold,
 * and remember it per browser, because those are screens tall rather than
 * lines tall.
 */
export default function StaffDashboard({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;
  const tDashboard = useTranslations('dashboard');
  const tCommon = useTranslations('common');

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();
  const [data, setData] = useState<DashboardAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [foldedSections, setFoldedSections] =
    useState<ReadonlySet<string>>(DEFAULT_FOLDED);

  const [inspectorData, setInspectorData] = useState<InspectorProfileResponse | null>(null);
  const [loadingInspector, setLoadingInspector] = useState(false);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role);
  }, [tenant, base, router]);

  useEffect(() => {
    if (role === 'FIELD_INSPECTOR' && token) {
      setLoadingInspector(true);
      getMyInspectorProfile(tenant, token)
        .then((res) => setInspectorData(res))
        .catch((err) => logApiError(err))
        .finally(() => setLoadingInspector(false));
    }
  }, [role, token, tenant]);

  // Read in an effect rather than in the `useState` initialiser: the initialiser
  // also runs on the server, where there is no localStorage.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(FOLD_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;
      setFoldedSections(
        new Set(parsed.filter((entry): entry is string => typeof entry === 'string')),
      );
    } catch {
      /* the defaults above hold */
    }
  }, []);

  const toggleSection = useCallback((id: string) => {
    setFoldedSections((previous) => {
      const next = new Set(previous);
      if (!next.delete(id)) next.add(id);
      try {
        localStorage.setItem(FOLD_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        /* the fold still holds for this page load */
      }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      setData(await getDashboardAnalytics(tenant, token));
      setError(null);
    } catch (caught) {
      logApiError(caught);
      if (caught instanceof ApiRequestError && caught.status === 401) {
        clearSession(tenant);
        router.replace(`${base}/login`);
        return;
      }
      setError('تعذّر تحميل بيانات اللوحة.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [tenant, token, base, router]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Household sizes, bucketed, ordered, and zero-filled so gaps show as gaps. */
  const familyBuckets = useMemo(() => {
    if (!data) return [];
    const counts = new Map<number, number>();
    for (const entry of data.familySizes) {
      const bucket = Math.min(Math.max(entry.size, 1), FAMILY_BUCKET_CAP);
      counts.set(bucket, (counts.get(bucket) ?? 0) + entry.households);
    }
    return Array.from({ length: FAMILY_BUCKET_CAP }, (_, index) => {
      const size = index + 1;
      const capped = size === FAMILY_BUCKET_CAP;
      return {
        label: capped ? `${size}+` : String(size),
        title: capped ? `${size} أفراد فأكثر` : `${size} من الأفراد`,
        value: counts.get(size) ?? 0,
      };
    });
  }, [data]);

  /**
   * The shape of a household here, read off `familySizes` — which until now
   * only fed the chart, though it is the one field on this payload that says
   * anything about the population beyond its size.
   *
   * Both figures divide by the households that *declared* a size, not by every
   * record on file. `householdsWithoutSize` households contribute zero people
   * to the distribution, so counting them in the denominator would drag the
   * average toward a household size the municipality does not have — the same
   * understatement the warning above the rule already calls out, repeated
   * quietly as a wrong number.
   */
  const household = useMemo(() => {
    if (!data || data.familySizes.length === 0) return null;

    let households = 0;
    let people = 0;
    let mode = data.familySizes[0];
    for (const entry of data.familySizes) {
      households += entry.households;
      people += entry.size * entry.households;
      if (entry.households > mode.households) mode = entry;
    }
    if (households === 0) return null;

    return {
      average: (people / households).toLocaleString('en-US', {
        maximumFractionDigits: 1,
      }),
      mode: mode.size,
    };
  }, [data]);

  const monthly = useMemo(() => {
    if (!data) return [];
    return data.monthly.map((entry) => {
      const { short, long } = monthLabels(entry.month, locale);
      return {
        label: short,
        title: long,
        // Collected first, so it sits on the reader's starting (right) side.
        values: [entry.collected, entry.overdue],
      };
    });
  }, [data, locale]);

  const moneyScale = useMemo(
    () => moneyAxis(Math.max(...monthly.flatMap((m) => m.values), 0), locale),
    [monthly, locale],
  );

  const collectedTrend = useMemo(
    () => monthlyTrend(data?.monthly, 'collected', true, locale),
    [data, locale],
  );
  const overdueTrend = useMemo(
    () => monthlyTrend(data?.monthly, 'overdue', false, locale),
    [data, locale],
  );

  /** Resolves each unit card against whichever of the two maps it reads. */
  const unitCards = useMemo(
    () =>
      UNIT_CARDS.map((card) => ({
        ...card,
        label: locale === 'en' ? card.labelEn : card.label,
        value:
          (card.source === 'unit' ? data?.unitsByType : data?.propertiesByType)?.[card.key] ?? 0,
      })),
    [data, locale],
  );

  const collectionRate =
    data && data.billedTotal > 0 ? data.collectedTotal / data.billedTotal : 0;
  const collectionPercent = Math.round(collectionRate * 100);

  /** What share of everything billed has gone past its due date. */
  const overduePercent =
    data && data.billedTotal > 0
      ? Math.round((data.overdueTotal / data.billedTotal) * 100)
      : 0;

  const trendSeries: SeriesKey[] = [
    { label: locale === 'en' ? 'Collected' : 'محصّل', color: 'var(--viz-series-1)' },
    { label: locale === 'en' ? 'Overdue' : 'متأخر', color: 'var(--viz-series-2)' },
  ];

  if (!token) return null;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={LayoutDashboard}
        title={locale === 'en' ? 'Dashboard' : 'لوحة التحكم'}
        /* The role rode beside the title as a badge; as a subtitle it says the
           same thing without a second object competing with the heading. */
        subtitle={role ? (locale === 'en' ? role : (ar.staffRole?.[role as never] ?? role)) : undefined}
        actions={
          <>
            {role === 'SUPER_ADMIN' || role === 'AUDITOR' ? (
              <a
                href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1'}/t/${tenant}/dashboard/export.csv`}
                className={buttonVariants({ variant: 'outline' })}
              >
                <Download className="size-4" aria-hidden />
                {tCommon('exportCsv')}
              </a>
            ) : null}
            <Button
              variant="outline"
              onClick={() => void load()}
              disabled={refreshing}
              title={tCommon('refresh')}
            >
              <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
              {tCommon('refresh')}
            </Button>
          </>
        }
      />

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/*
        The refresh holds the previous render at reduced opacity instead of
        dropping back to skeletons — a dashboard that flashes empty on every
        poll reads as broken, and the layout jump loses the reader's place.
      */}
      <div className={cn('space-y-10 transition-opacity', refreshing && 'opacity-60')}>
        {/* Field Inspector Personal Activity & Commission Section */}
        {role === 'FIELD_INSPECTOR' ? (
          <section
            aria-label={locale === 'en' ? 'My Field Performance & Earnings' : 'نشاطي الميداني وأرباحي'}
            className="rounded-xl border border-primary/25 bg-gradient-to-br from-primary/5 via-card to-card p-5 shadow-sm sm:p-6"
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3.5">
                <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                  <BadgeDollarSign className="size-6" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-foreground">
                    {locale === 'en' ? 'My Field Survey Activity & Earnings' : 'نشاطك الميداني وأرباح العمولات المستحقة'}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {locale === 'en'
                      ? 'Personal count of citizens and properties registered by you, and your $1 commission'
                      : 'إحصاءات خاصة بك فقط: عدد المواطنين والعقارات المسجلة بواسطتك وأرباح عمولاتك ($1/عقار)'}
                  </p>
                </div>
              </div>
              <Link
                href={`${base}/inspector/profile`}
                className={cn(buttonVariants({ variant: 'default' }), 'gap-2 shrink-0 font-medium')}
              >
                <BadgeDollarSign className="size-4" />
                <span>{locale === 'en' ? 'View My Full Profile & Payouts' : 'عرض ملفي وأرباحي بالكامل'}</span>
              </Link>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border bg-card/80 p-3.5 sm:p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground">
                  {locale === 'en' ? 'Citizens Registered by You' : 'المواطنون المسجلون بواسطتك'}
                </p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                  {loadingInspector ? '...' : (inspectorData?.totalCitizens ?? 0)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {locale === 'en' ? 'Citizen profile' : 'مواطن مسجل بواسطتك'}
                </p>
              </div>

              <div className="rounded-lg border bg-card/80 p-3.5 sm:p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground">
                  {locale === 'en' ? 'Properties Registered by You' : 'العقارات والوحدات المسجلة بواسطتك'}
                </p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight text-foreground">
                  {loadingInspector ? '...' : (inspectorData?.totalProperties ?? 0)}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {locale === 'en' ? 'Property / unit' : 'عقار ووحدة مسجلة'}
                </p>
              </div>

              <div className="rounded-lg border bg-card/80 p-3.5 sm:p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground">
                  {locale === 'en' ? 'Total Commission ($1/prop)' : 'إجمالي أرباحك ($1/عقار)'}
                </p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight text-success">
                  ${(inspectorData?.totalEarnings ?? 0).toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {locale === 'en' ? '$1 fixed rate per property' : 'عمولة 1$ عن كل عقار/وحدة'}
                </p>
              </div>

              <div className="rounded-lg border bg-card/80 p-3.5 sm:p-4 shadow-sm">
                <p className="text-xs font-medium text-muted-foreground">
                  {locale === 'en' ? 'Pending Balance' : 'الرصيد المتبقي (المعلق)'}
                </p>
                <p className="mt-1.5 text-2xl font-bold tracking-tight text-warning">
                  ${(inspectorData?.pendingBalance ?? 0).toLocaleString()}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {locale === 'en'
                    ? `Paid: $${(inspectorData?.paidBalance ?? 0).toLocaleString()}`
                    : `المدفوع: $${(inspectorData?.paidBalance ?? 0).toLocaleString()}`}
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {/* ── The four figures ──────────────────────────────────────── */}
        {/*
          Grid rows stretch by default, and each card is a flex column with a
          spacer above its rule — together that is what keeps the four the same
          height with their detail panels on one line, whatever each card's
          middle happens to carry.
        */}
        <section aria-label={locale === 'en' ? 'Key Metrics' : 'المؤشرات الرئيسية'} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label={tDashboard('kpiPopulation')}
            icon={Users}
            value={data ? count(data.populationTotal) : '—'}
            loading={loading}
            alert={
              data && data.householdsWithoutSize > 0
                ? (locale === 'en'
                  ? `${data.householdsWithoutSize} households without registered size`
                  : `${data.householdsWithoutSize} أسرة بلا عدد أفراد مسجّل`)
                : null
            }
          >
            <dl className="space-y-2.5">
              <DetailRow
                label={tDashboard('kpiFamilies')}
                value={count(data?.citizenRecords)}
              />
              <DetailRow
                label={tDashboard('kpiAvgFamily')}
                value={household ? (locale === 'en' ? `${household.average} members` : `${household.average} أفراد`) : '—'}
              />
              <DetailRow
                label={tDashboard('kpiCommonFamily')}
                value={household ? (locale === 'en' ? `${household.mode} members` : `${household.mode} أفراد`) : '—'}
              />
              <DetailRow
                label={tDashboard('kpiGrossRegistered')}
                value={count(data?.grossRegisteredTotal)}
              />
              <DetailRow
                label={tDashboard('kpiMarriedOffspring')}
                value={count(data?.marriedOffspringTotal)}
              />
            </dl>
            {data && data.householdsWithoutSize > 0 ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {locale === 'en'
                  ? 'Households without registered size count as zero; total population may be higher than displayed.'
                  : 'الأسر بلا عدد أفراد تُحتسب بصفر، فرقم السكان أعلاه أقل من الواقع. المتوسط والحجم الأكثر شيوعاً محسوبان من الأسر المصرّح بعددها فقط.'}
              </p>
            ) : null}
            <DetailLink href={`${base}/citizens`}>{tDashboard('citizensShortcut')}</DetailLink>
          </KpiCard>

          <KpiCard
            label={tDashboard('kpiFees')}
            icon={Receipt}
            value={data ? <Money amount={data.billedTotal} /> : '—'}
            loading={loading}
          >
            <dl className="space-y-2.5">
              <DetailRow label={tDashboard('kpiProperties')} value={count(data?.propertyTotal)} />
              <DetailRow label={tDashboard('kpiUnits')} value={count(data?.unitTotal)} />
              <DetailRow
                label={tDashboard('kpiUnpaid')}
                value={data ? formatLbp(data.outstandingTotal) : '—'}
              />
            </dl>
            <DetailLink href={`${base}/fees`}>{tDashboard('feesShortcut')}</DetailLink>
          </KpiCard>

          <KpiCard
            label={tDashboard('kpiOverdue')}
            icon={Banknote}
            tone="destructive"
            value={data ? <Money amount={data.overdueTotal} /> : '—'}
            loading={loading}
            trend={overdueTrend}
          >
            <dl className="space-y-2.5">
              <DetailRow
                label={locale === 'en' ? 'Overdue Invoices' : 'فواتير تجاوزت الاستحقاق'}
                value={count(data?.overdueCount)}
              />
              <DetailRow
                label={locale === 'en' ? 'Share of Total Fees' : 'حصّتها من الرسوم'}
                value={data ? `${overduePercent}%` : '—'}
              />
              <DetailRow
                label={locale === 'en' ? 'Total Billed' : 'من إجمالي الرسوم'}
                value={data ? formatLbp(data.billedTotal) : '—'}
              />
            </dl>
            <DetailLink href={`${base}/fees`}>{tDashboard('feesShortcut')}</DetailLink>
          </KpiCard>

          <KpiCard
            label={tDashboard('kpiCollected')}
            icon={Wallet}
            tone="success"
            value={data ? <Money amount={data.collectedTotal} /> : '—'}
            loading={loading}
            trend={collectedTrend}
            extra={
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="text-muted-foreground">{tDashboard('kpiCollectionRate')}</span>
                  {loading ? (
                    <Skeleton className="h-3 w-8" />
                  ) : (
                    <span className="font-semibold tabular-nums">{collectionPercent}%</span>
                  )}
                </div>
                <div
                  role="meter"
                  aria-valuenow={collectionPercent}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={tDashboard('kpiCollectionRate')}
                  className="h-2 w-full overflow-hidden rounded-full"
                  style={{ background: 'var(--viz-step-1)' }}
                >
                  <div
                    className="h-full rounded-full transition-[width] duration-500"
                    style={{
                      width: `${Math.max(collectionRate * 100, 0)}%`,
                      background: 'var(--viz-step-4)',
                    }}
                  />
                </div>
              </div>
            }
          >
            <dl className="space-y-2.5">
              <DetailRow
                label={tDashboard('kpiUnpaid')}
                value={data ? formatLbp(data.outstandingTotal) : '—'}
              />
              <DetailRow
                label={tDashboard('kpiPendingReview')}
                value={count(data?.pendingReviewCount)}
              />
            </dl>
            <DetailLink href={`${base}/fees`}>{tDashboard('feesShortcut')}</DetailLink>
          </KpiCard>
        </section>

        {/* ── Municipal units ───────────────────────────────────────── */}
        <FoldSection
          id="units"
          title={locale === 'en' ? 'Housing & Property Units' : 'الوحدات والعقارات'}
          icon={Building2}
          summary={
            loading
              ? (locale === 'en' ? 'Loading…' : 'جارٍ التحميل…')
              : (locale === 'en'
                ? `${count(data?.propertyTotal)} properties · ${count(data?.unitTotal)} units`
                : `${count(data?.propertyTotal)} عقار · ${count(data?.unitTotal)} وحدة`)
          }
          open={!foldedSections.has('units')}
          onToggle={() => toggleSection('units')}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {unitCards.map((card) => (
              <UnitTile
                key={`${card.source}:${card.key}`}
                label={card.label}
                value={card.value}
                icon={card.icon}
                loading={loading}
              />
            ))}
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            {locale === 'en'
              ? 'Units inside registered buildings and standalone units are counted together. Registered buildings counts each property once regardless of unit count.'
              : 'تُحتسب الوحدات داخل المباني المسجّلة والوحدات المسجّلة بذاتها معاً. «مبانٍ مسجّلة» تعدّ العقار الواحد مرة واحدة مهما بلغ عدد وحداته.'}
          </p>
          {data &&
          (data.duplicateFilingsExcluded.properties > 0 ||
            data.duplicateFilingsExcluded.units > 0) ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {locale === 'en'
                ? `${count(data.duplicateFilingsExcluded.properties)} duplicate property filing(s) and ${count(data.duplicateFilingsExcluded.units)} duplicate unit filing(s) already excluded — a unit rented from its registered owner is counted once, not twice.`
                : `تم استبعاد ${count(data.duplicateFilingsExcluded.properties)} عقار و${count(data.duplicateFilingsExcluded.units)} وحدة مسجّلة مرتين — الوحدة المؤجَّرة من مالكها المسجَّل تُحتسب مرة واحدة فقط.`}
            </p>
          ) : null}
        </FoldSection>

        {/* ── Charts ────────────────────────────────────────────────── */}
        <FoldSection
          id="analytics"
          title={locale === 'en' ? 'Analytics' : 'التحليلات'}
          icon={BarChart3}
          summary={locale === 'en' ? 'Household size distribution and monthly collection' : 'توزيع أحجام الأسر، والتحصيل الشهري'}
          open={!foldedSections.has('analytics')}
          onToggle={() => toggleSection('analytics')}
        >
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title={locale === 'en' ? 'Household Size Distribution' : 'توزيع أحجام الأسر'}
              description={locale === 'en' ? 'Registered households by member count' : 'عدد الأسر المسجّلة حسب عدد أفرادها'}
              icon={UsersRound}
              table={{
                columns: locale === 'en' ? ['Household Size', 'Households'] : ['عدد الأفراد', 'عدد الأسر'],
                rows: familyBuckets.map((bucket) => [
                  bucket.title,
                  bucket.value.toLocaleString('en-US'),
                ]),
              }}
            >
              <ColumnChart
                data={familyBuckets}
                color="var(--viz-series-1)"
                yLabel={locale === 'en' ? 'Households' : 'عدد الأسر'}
                formatValue={(value) => value.toLocaleString('en-US')}
              />
            </ChartCard>

            <ChartCard
              title={locale === 'en' ? 'Monthly Collection & Arrears' : 'التحصيل والمتأخرات شهرياً'}
              description={locale === 'en' ? `Past 6 months by due date — in ${moneyScale.unit}` : `آخر ٦ أشهر حسب تاريخ الاستحقاق — بـ${moneyScale.unit}`}
              icon={TrendingUp}
              series={trendSeries}
              table={{
                columns: locale === 'en' ? ['Month', 'Collected', 'Overdue'] : ['الشهر', 'محصّل', 'متأخر'],
                rows: (data?.monthly ?? []).map((entry) => [
                  monthLabels(entry.month).long,
                  formatLbp(entry.collected),
                  formatLbp(entry.overdue),
                ]),
              }}
            >
              <GroupedColumnChart
                data={monthly}
                series={trendSeries}
                yLabel={locale === 'en' ? `Amounts in ${moneyScale.unit}` : `المبالغ بـ${moneyScale.unit}`}
                formatValue={(value) => formatLbp(value)}
                formatTick={(value) =>
                  (value / moneyScale.divisor).toLocaleString('en-US', {
                    maximumFractionDigits: 1,
                  })
                }
              />
            </ChartCard>
          </div>
        </FoldSection>

        {/* ── Shortcuts ─────────────────────────────────────────────── */}
        <section aria-label={locale === 'en' ? 'Quick Access' : 'الانتقال السريع'} className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">
            {locale === 'en' ? 'Quick Access' : 'الانتقال السريع'}
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Shortcut
              href={`${base}/citizens`}
              icon={Users}
              title={locale === 'en' ? 'Citizens' : 'المواطنون'}
              description={locale === 'en' ? 'Full registry, search and edit' : 'السجل الكامل، الإضافة والتعديل'}
            />
            <Shortcut
              href={`${base}/fees`}
              icon={Receipt}
              title={locale === 'en' ? 'Fees & Billing' : 'الرسوم والمدفوعات'}
              description={locale === 'en' ? 'Issue bills and verify payments' : 'إصدار الرسوم وتأكيد الدفعات'}
            />
            <Shortcut
              href={`${base}/map`}
              icon={MapIcon}
              title={locale === 'en' ? 'Cadastral Map' : 'الخريطة'}
              description={locale === 'en' ? 'Properties mapped on cadastre' : 'العقارات المسجّلة على السجل العقاري'}
            />
            <Shortcut
              href={`${base}/zones`}
              icon={Layers}
              title={locale === 'en' ? 'Zones' : 'القطاعات'}
              description={locale === 'en' ? 'Municipal district zones' : 'تقسيم البلدية إلى مناطق'}
            />
          </div>
        </section>
      </div>
    </div>
  );
}

const KPI_TONES = {
  primary: 'bg-primary/10 text-primary',
  destructive: 'bg-destructive/10 text-destructive',
  success: 'bg-success/10 text-success',
} as const;

/**
 * One headline figure, with its qualifiers under a rule beneath it.
 *
 * The top half carries what an admin came to read — a label, the number, and
 * on two of the four cards one thing that changes how the number should be
 * read (the collection meter, the households missing a size). `children` is
 * everything that explains it: the counts it is drawn from, the balance
 * behind it, and the page that owns those records.
 *
 * The rule is placed by a `flex-1` spacer rather than by margin, which is what
 * lets four cards of unequal content share one height without their panels
 * stepping down the row.
 */
function KpiCard({
  label,
  icon: Icon,
  tone = 'primary',
  value,
  alert,
  trend,
  extra,
  loading,
  children,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: keyof typeof KPI_TONES;
  /** A node, so a money card can hand it a compacting `<Money>`. */
  value: React.ReactNode;
  /** A caveat about the figure itself, above the rule — see the population card. */
  alert?: string | null;
  /** Change against the prior complete month, on the two cards with a monthly series. */
  trend?: { pct: number; goodWhenUp: boolean; caption: string } | null;
  /** The meter, on the one card whose figure is a rate against a limit. */
  extra?: React.ReactNode;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <article className="flex h-full flex-col rounded-xl border border-border/70 bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 pt-1 text-sm font-medium text-muted-foreground">{label}</p>
        <span
          aria-hidden
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-xl',
            KPI_TONES[tone],
          )}
        >
          <Icon className="size-4" />
        </span>
      </div>

      {/*
        A bar the width the number will take, not an em dash.

        "—" is a *value*: on a dashboard whose whole job is to report figures,
        a card reading "—" says the municipality has none, which is a different
        and much worse claim than "this has not loaded yet". The bar is
        unmistakably an absence.
      */}
      <div className="mt-2 text-3xl font-bold leading-tight">
        {loading ? <Skeleton className="h-[1em] w-28" /> : value}
      </div>

      {!loading && trend ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-xs">
          <TrendChip pct={trend.pct} goodWhenUp={trend.goodWhenUp} />
          <span className="truncate text-muted-foreground">{trend.caption}</span>
        </div>
      ) : null}

      {extra ? <div className="mt-4">{extra}</div> : null}

      {alert ? (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {alert}
        </p>
      ) : null}

      {/*
        Absorbs the difference between a card carrying a meter or a warning and
        one carrying neither, so the four rules — and the detail panels under
        them — sit on one line across the row instead of stepping.
      */}
      <div className="flex-1" />

      <div className="mt-4 space-y-3 border-t border-border/60 pt-4 text-sm">
        {children}
      </div>
    </article>
  );
}

/**
 * A small +/− pill for the change beside a KPI card's figure.
 *
 * Direction (the arrow) and valence (the colour) are computed separately —
 * an increase is `success` on the collected card and `destructive` on the
 * overdue one, so the colour always means "this is moving the right way",
 * never just "the number went up".
 */
function TrendChip({ pct, goodWhenUp }: { pct: number; goodWhenUp: boolean }) {
  const flat = Math.abs(pct) < 0.05;
  const up = pct > 0;
  const good = flat ? null : up === goodWhenUp;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 font-semibold tabular-nums',
        good === null && 'bg-muted text-muted-foreground',
        good === true && 'bg-success/10 text-success',
        good === false && 'bg-destructive/10 text-destructive',
      )}
    >
      {flat ? (
        <Minus className="size-3" aria-hidden />
      ) : up ? (
        <ArrowUp className="size-3" aria-hidden />
      ) : (
        <ArrowDown className="size-3" aria-hidden />
      )}
      {flat ? '0%' : `${up ? '+' : ''}${pct.toFixed(1)}%`}
    </span>
  );
}

/** One line of a KPI card's detail panel: a caption and its figure. */
function DetailRow({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'default' | 'warning';
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={cn('text-muted-foreground', tone === 'warning' && 'text-warning')}>
        {label}
      </dt>
      <dd className={cn('font-semibold tabular-nums', tone === 'warning' && 'text-warning')}>
        {value}
      </dd>
    </div>
  );
}

/** The way out of a detail panel into the page that owns those records. */
function DetailLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
    >
      {children}
      <ChevronLeft className="size-3.5 rtl:rotate-180" aria-hidden />
    </Link>
  );
}

/**
 * A titled block that folds, and remembers whether it is folded.
 *
 * Its header keeps working as a summary while folded — the unit section's two
 * totals stay on screen whether or not the seven-tile breakdown is open — so
 * folding hides the detail, never the headline.
 */
function FoldSection({
  id,
  title,
  icon: Icon,
  summary,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  const panelId = `${id}-panel`;

  return (
    <section aria-labelledby={`${id}-title`} className="space-y-4">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        className="group flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-xl border border-transparent px-1 py-1 text-start transition-colors hover:border-border/70 hover:bg-card"
      >
        <h2 id={`${id}-title`} className="flex items-center gap-2.5 text-lg font-semibold">
          <span
            aria-hidden
            className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
          >
            <Icon className="size-4" />
          </span>
          {title}
        </h2>
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          {summary}
          <ChevronDown
            aria-hidden
            className={cn('size-4 transition-transform duration-200', open && 'rotate-180')}
          />
          <span className="sr-only">{open ? 'طيّ القسم' : 'فتح القسم'}</span>
        </span>
      </button>

      {/*
        `hidden` rather than dropping the element: `aria-controls` above has to
        resolve to something for the header to announce as a control, and the
        attribute takes the panel out of both layout and the accessibility tree
        while it is folded. The children themselves are only mounted when open —
        see the note on the charts section.
      */}
      <div id={panelId} hidden={!open} className="space-y-4">
        {open ? children : null}
      </div>
    </section>
  );
}

/**
 * One municipal-unit count.
 *
 * Deliberately quieter than the KPI cards above: these are register counts,
 * read in a group of seven, and giving each the same weight as إجمالي الرسوم
 * would flatten the page into one long row of equally loud numbers. A zero is
 * muted rather than hidden — "no clinics registered" is itself a fact about
 * the municipality, and dropping the card would make the grid's shape depend
 * on the data.
 */
function UnitTile({
  label,
  value,
  icon: Icon,
  loading,
}: {
  label: string;
  value: number;
  icon: React.ComponentType<{ className?: string }>;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4 transition-colors hover:bg-accent/40">
      <span
        aria-hidden
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg',
          value > 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-5" />
      </span>
      {/* `min-w-0` so a four-digit count widens the text block rather than
          pushing the icon chip out of the card. */}
      <div className="min-w-0">
        <p
          className={cn(
            'text-2xl font-bold leading-tight',
            value === 0 && 'text-muted-foreground',
          )}
        >
          {loading ? <Skeleton className="h-[1em] w-10" /> : value.toLocaleString('en-US')}
        </p>
        <p className="truncate text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

/** A card-sized link into the page that owns the records behind a number. */
function Shortcut({
  href,
  icon: Icon,
  title,
  description,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Link
      href={href}
      className="group flex items-center gap-3 rounded-xl border border-border/70 bg-card p-4 transition-colors hover:bg-accent"
    >
      <span
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
      <ChevronLeft
        className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5 rtl:rotate-180 rtl:group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}
