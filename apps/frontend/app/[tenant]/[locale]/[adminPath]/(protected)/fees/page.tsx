'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Banknote,
  CheckCircle2,
  Clock3,
  Loader2,
  Plus,
  Receipt,
  RefreshCw,
  UserPlus,
  Wallet,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  chargeCitizen,
  getAllPayments,
  getCitizenProfile,
  getFeeSummary,
  getFeeFilterOptions,
  getMunicipalitySettings,
  getTenantConfig,
  issueFeeNotice,
  listCitizens,
  logApiError,
  reviewPayment,
} from '@/lib/api-client';
import type {
  AdminPaymentItem,
  CitizenProfile,
  CitizenProfilePayment,
} from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatLbp } from '@/lib/currency';
import { describeAssessment } from '@/lib/fee-assessment';
import { formatDate } from '@/lib/dates';
import { CellTag } from '@/components/ui/cell-tag';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { ChargeCitizenDialog, type ChargeValues } from '@/components/admin/charge-citizen-dialog';
import { IssueFeeDialog, type IssueFeeValues } from '@/components/admin/issue-fee-dialog';
import { BillTypeFilter } from '@/components/admin/bill-type-select';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { cn } from '@/lib/utils';

function getTableLabels(locale: string): DataTableLabels {
  if (locale === 'en') {
    return {
      searchAriaLabel: 'Search fees and demands',
      searchPlaceholder: 'Search by citizen name, fee title, or reference code…',
      clearSearch: 'Clear search',
      searchHint: 'Enter',
      searchApplied: 'Search: "{term}"',
      empty: 'No fees or demands registered yet.',
      emptyHint: 'Issue your first fee using the "Issue Fee Notice" button above.',
      emptySearch: 'No results match your search.',
      emptySearchHint: 'Try searching by citizen name, fee title, or reference code.',
      loadError: 'Failed to load fees and payments register.',
      retry: 'Retry',
      previous: 'Previous',
      next: 'Next',
      pageOf: 'Page {current} of {total}',
      rowsPerPage: 'Rows per page',
      totalRows: '{count} demands',
      sortAscending: 'Sort ascending',
      sortDescending: 'Sort descending',
      sortNone: 'Clear sorting',
      columns: 'Columns',
      columnsHint: 'Visible columns',
      resetColumns: 'Reset to default',
    };
  }
  return {
    searchAriaLabel: 'بحث في الرسوم والمطالبات',
    searchPlaceholder: 'ابحث باسم المواطن أو الرسم أو الرقم المرجعي…',
    clearSearch: 'مسح البحث',
    searchHint: 'Enter',
    searchApplied: 'بحث: «{term}»',
    empty: 'لا توجد رسوم أو مطالبات مسجّلة بعد.',
    emptyHint: 'أصدر أول رسم من زر «إصدار رسم جديد» أعلاه.',
    emptySearch: 'لا توجد نتائج مطابقة لبحثك.',
    emptySearchHint: 'جرّب البحث باسم المواطن، أو نوع الرسم، أو الرقم المرجعي.',
    loadError: 'تعذّر تحميل سجل الرسوم والمدفوعات.',
    retry: 'إعادة المحاولة',
    previous: 'السابق',
    next: 'التالي',
    pageOf: 'صفحة {current} من {total}',
    rowsPerPage: 'عدد الصفوف',
    totalRows: '{count} مطالبة',
    sortAscending: 'ترتيب تصاعدي',
    sortDescending: 'ترتيب تنازلي',
    sortNone: 'إلغاء الترتيب',
    columns: 'الأعمدة',
    columnsHint: 'الأعمدة الظاهرة',
    resetColumns: 'استعادة الافتراضي',
  };
}

/**
 * The order the status tabs read in, which is not alphabetical and not the
 * enum's.
 *
 * It is the collection story: what is owed, what is late, what somebody says
 * they have paid, what is settled. Kept here as an *ordering* only — which of
 * these four actually appear is answered by the register (see
 * `filterOptionsQuery`), because a municipality that has never marked an
 * invoice «قيد المراجعة» should not be offered a tab that empties the table.
 */
const STATUS_TAB_ORDER = ['UNPAID', 'OVERDUE', 'PENDING_REVIEW', 'PAID'] as const;

/**
 * The tab row: «الكل» plus one tab per status the ledger actually holds.
 *
 * «الكل» is always there — it is not a status, it is the absence of the
 * filter, and it is what clears one.
 */
function buildStatusFilters(
  locale: string,
  present: readonly string[],
  labels: ReturnType<typeof getLabels>,
): Array<{ id: string; label: string }> {
  const seen = new Set(present);
  return [
    { id: '', label: locale === 'en' ? 'All' : 'الكل' },
    ...STATUS_TAB_ORDER.filter((status) => seen.has(status)).map((status) => ({
      id: status,
      label: labels.paymentStatus[status as never] ?? status,
    })),
  ];
}

function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  return `${words[0][0] ?? ''}${words.length > 1 ? (words[words.length - 1][0] ?? '') : ''}`;
}

export default function FeesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const [token, setToken] = useState<string | null>(null);
  const [role, setRole] = useState<string | undefined>();

  // Table Data State
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [feeTitleFilter, setFeeTitleFilter] = useState<string>('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });

  // Dialogs State
  const [issueOpen, setIssueOpen] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [chargeOpen, setChargeOpen] = useState(false);
  const [charging, setCharging] = useState(false);
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);

  // Receipt State
  const [receipt, setReceipt] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  const toast = useToast();
  const canManage = role === 'SUPER_ADMIN';

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
    setRole(session.user.role);
  }, [tenant, base, router]);

  /**
   * What the filters above the ledger may offer — the bill titles that exist
   * and the statuses the register has actually reached.
   *
   * One read for both, and `reference` so it is one read for the whole
   * session: this is the municipality's vocabulary, not its rows. سجل العمليات
   * asks for the same key, so opening it costs nothing.
   */
  const filterOptionsQuery = useStaffQuery({
    queryKey: ['fee-filter-options', tenant],
    queryFn: (accessToken, signal) => getFeeFilterOptions(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل خيارات التصفية.',
    reference: true,
  });
  const feeTitles = filterOptionsQuery.data?.titles ?? [];

  const paymentsQuery = useStaffQuery({
    queryKey: [
      'fees-payments',
      tenant,
      statusFilter,
      feeTitleFilter,
      appliedSearch,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      getAllPayments(
        tenant,
        accessToken,
        {
          status: statusFilter || undefined,
          feeTitle: feeTitleFilter || undefined,
          search: appliedSearch || undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل سجل الرسوم والمدفوعات.',
    keepPrevious: true,
  });

  /*
    Everything on this screen that is not the ledger: the headline figures, the
    citizen picker the two dialogs read, and the office details a reprinted وصل
    carries. `allSettled` rather than `all`, kept from the original, because a
    receipt's phone number failing to load must not blank the table beside it.
  */
  const contextQuery = useStaffQuery({
    queryKey: ['fees-context', tenant],
    queryFn: async (accessToken) => {
      const [summaryRes, settingsRes, configRes, citizensRes] = await Promise.allSettled([
        getFeeSummary(tenant, accessToken),
        getMunicipalitySettings(tenant, accessToken),
        getTenantConfig(tenant),
        listCitizens(tenant, accessToken, { limit: 200 }),
      ]);
      for (const result of [summaryRes, settingsRes, configRes, citizensRes]) {
        if (result.status === 'rejected') logApiError(result.reason);
      }
      return {
        summary: summaryRes.status === 'fulfilled' ? summaryRes.value : null,
        settings: settingsRes.status === 'fulfilled' ? settingsRes.value : null,
        municipalityName:
          configRes.status === 'fulfilled'
            ? configRes.value.nameAr || configRes.value.name
            : '',
        citizens: citizensRes.status === 'fulfilled' ? citizensRes.value.items : [],
      };
    },
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل بيانات الرسوم.',
  });

  const items = paymentsQuery.data?.items ?? [];
  const total = paymentsQuery.data?.total ?? 0;
  const summary = contextQuery.data?.summary ?? null;
  const citizens = contextQuery.data?.citizens ?? [];
  const settings = contextQuery.data?.settings ?? null;
  const municipalityName = contextQuery.data?.municipalityName ?? '';
  const loading = paymentsQuery.loading;
  const refreshing = paymentsQuery.fetching || contextQuery.fetching;
  /*
    The banner above the page and the state inside the table say different
    things, and used to say the same one twice.

    A failed *read* belongs to the table: it is the table that has no rows to
    show, it is the table that needs the retry button, and a table rendering
    «لا توجد نتائج» after a request failed is telling the reader the register is
    empty when it is only unreachable. A failed *write* has no such home — the
    rows are fine, an action was refused — so that is what the banner is for.
  */
  const error = contextQuery.error;

  /** Re-reads both halves of the screen after a write. */
  const queryClient = useQueryClient();
  const load = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fees-payments', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['fees-context', tenant] }),
        /*
          The filter vocabulary too, because a write can extend it: the first
          invoice under a new «نوع رسم», or the first one anyone settles, adds
          a value that was not there when the session started. Held forever
          otherwise — that is what `reference` means — so this is the line that
          keeps "fetched once" from turning into "never updated".
        */
        queryClient.invalidateQueries({ queryKey: ['fee-filter-options', tenant] }),
      ]),
    [queryClient, tenant],
  );

  const openReceipt = useCallback(
    async (citizenId: string, paymentId: string, receivedAmount: number) => {
      if (!token) return;
      setBusyPaymentId(paymentId);
      try {
        const profile = await getCitizenProfile(tenant, token, citizenId);
        const row = profile.payments.find((entry) => entry.id === paymentId);
        if (!row) {
          toast.error('تعذّر العثور على سجل الدفعة.');
          return;
        }
        setReceipt({ citizen: profile, payment: row, received: receivedAmount });
      } catch (caught) {
        logApiError(caught);
        toast.error('تعذّر فتح الوصل — يمكنك إصداره من ملف المواطن.');
      } finally {
        setBusyPaymentId(null);
      }
    },
    [tenant, token, toast],
  );

  const handleReview = useCallback(
    async (paymentId: string, confirmed: boolean) => {
      if (!token || busyPaymentId) return;
      setBusyPaymentId(paymentId);
      try {
        await reviewPayment(tenant, token, paymentId, { confirmed });
        toast.success(confirmed ? 'تم تأكيد الدفعة بنجاح.' : 'تم رفض الدفعة.');
        void load();
      } catch (caught) {
        logApiError(caught);
        toast.error(caught instanceof ApiRequestError ? caught.message : 'تعذّر مراجعة الدفعة.');
      } finally {
        setBusyPaymentId(null);
      }
    },
    [tenant, token, busyPaymentId, toast, load],
  );

  const handleIssueNotice = async (values: IssueFeeValues) => {
    if (!token) return;
    setIssuing(true);
    try {
      const res = await issueFeeNotice(tenant, token, {
        title: values.title,
        amount: Number(values.amount.replace(/\D/g, '')),
        basis: values.basis,
        bearer: values.bearer,
        frequency: values.frequency,
        targetType: values.targetType,
        targetCategory: values.targetCategory || undefined,
        targetCitizenId: values.targetCitizenId || undefined,
        dueDate: values.dueDate,
        instructions: values.instructions || undefined,
      });
      toast.success(`تم إصدار الرسم بنجاح وتكليف ${res.issued} مواطن.`);

      /*
        The skipped are named, not buried.

        A clerk told only that two hundred invoices were raised has no way to
        know that eleven buildings went unbilled because nobody has been inside
        them. This is the shortfall made visible so someone can act on it.
      */
      if (res.unassessable && res.unassessable.length > 0) {
        toast.error(
          `${res.unassessable.length} سجل لم يُحتسب لعدم اكتمال الجرد: ` +
            res.unassessable.map((entry) => entry.name).join('، '),
        );
      }

      /*
        And so is what the bearer rule left out, for the same reason.

        A clerk who has just said this fee falls on المالك rather than الشاغل
        has changed what the town owes, and the size of that change is knowable
        only right here — afterwards it is spread across a few hundred invoices
        that each look unremarkable. One number, at the moment it was decided.
      */
      if (res.exemptedUnits) {
        toast.info(`${res.exemptedUnits} وحدة لم تُحتسب حسب صفة المكلَّف بالرسم.`);
      }
      setIssueOpen(false);
      void load();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : 'تعذّر إصدار الرسم.');
    } finally {
      setIssuing(false);
    }
  };

  const handleChargeCitizen = async (values: ChargeValues) => {
    if (!token) return;
    setCharging(true);
    try {
      await chargeCitizen(tenant, token, {
        citizenId: values.citizenId,
        title: values.title,
        amount: Number(values.amount.replace(/\D/g, '')),
        dueDate: values.dueDate,
      });
      toast.success('تم تسجيل التكليف المالي على المواطن بنجاح.');
      setChargeOpen(false);
      void load();
    } catch (caught) {
      logApiError(caught);
      toast.error(caught instanceof ApiRequestError ? caught.message : 'تعذّر تكليف المواطن.');
    } finally {
      setCharging(false);
    }
  };

  const labels = getLabels(locale);

  const columns = useMemo<ColumnDef<AdminPaymentItem>[]>(
    () => [
      {
        accessorKey: 'citizenName',
        header: locale === 'en' ? 'Citizen' : 'المواطن',
        cell: ({ row }) => {
          const payment = row.original;
          return (
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
              >
                {initials(payment.citizenName)}
              </span>
              <div className="min-w-0 space-y-0.5">
                <Link
                  href={`${base}/citizens/${payment.citizenId}`}
                  className="truncate font-semibold text-foreground hover:text-primary transition-colors block"
                >
                  {payment.citizenName}
                </Link>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  {payment.citizenReference ? (
                    <span className="font-mono text-xs" dir="ltr">
                      {payment.citizenReference}
                    </span>
                  ) : null}
                  {payment.citizenPhone ? (
                    <>
                      <span>•</span>
                      <span className="font-mono text-xs" dir="ltr">
                        {payment.citizenPhone}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'title',
        header: locale === 'en' ? 'Fee / Demand' : 'الرسم / المطالبة',
        cell: ({ row }) => {
          const payment = row.original;
          /*
            How the amount was arrived at, for the invoices where that is not
            obvious. This is the sentence a collector reads back when a resident
            asks why they owe what they owe.
          */
          const breakdown = describeAssessment(payment.assessment, locale);
          return (
            <div className="space-y-1">
              <p className="font-medium text-foreground">{payment.title}</p>
              {breakdown ? (
                <p className="font-mono text-xs text-muted-foreground">
                  <bdi dir="ltr">{breakdown}</bdi>
                </p>
              ) : null}
              {payment.frequency ? (
                <CellTag tone="muted" className="text-xs">
                  {labels.feeFrequency[payment.frequency as never] ?? payment.frequency}
                </CellTag>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'dueDate',
        header: locale === 'en' ? 'Due Date' : 'تاريخ الاستحقاق',
        cell: ({ row }) => {
          return (
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap">
              {formatDate(row.original.dueDate)}
            </span>
          );
        },
      },
      {
        accessorKey: 'amount',
        header: locale === 'en' ? 'Fee Amount' : 'قيمة الرسم',
        meta: { align: 'end' },
        cell: ({ row }) => (
          <span className="font-mono text-sm tabular-nums text-foreground whitespace-nowrap">
            {formatLbp(row.original.amount, locale)}
          </span>
        ),
      },
      {
        accessorKey: 'paidAmount',
        header: locale === 'en' ? 'Paid' : 'المسدد',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const paid = row.original.paidAmount;
          return (
            <span
              className={cn(
                'font-mono text-sm tabular-nums whitespace-nowrap',
                paid > 0 ? 'font-semibold text-success' : 'text-muted-foreground',
              )}
            >
              {paid > 0 ? formatLbp(paid, locale) : '—'}
            </span>
          );
        },
      },
      {
        accessorKey: 'remaining',
        header: locale === 'en' ? 'Balance Due' : 'الرصيد المستحق',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const remaining = row.original.remaining;
          const isPaid = row.original.paymentStatus === 'PAID';
          return (
            <span
              className={cn(
                'font-mono text-sm font-bold tabular-nums whitespace-nowrap',
                isPaid
                  ? 'text-muted-foreground line-through opacity-70'
                  : remaining > 0
                    ? 'text-foreground'
                    : 'text-success',
              )}
            >
              {formatLbp(remaining, locale)}
            </span>
          );
        },
      },
      {
        accessorKey: 'paymentStatus',
        header: locale === 'en' ? 'Status' : 'الحالة',
        cell: ({ row }) => {
          const status = row.original.paymentStatus;
          return (
            <CellTag
              tone={
                status === 'PAID'
                  ? 'success'
                  : status === 'OVERDUE'
                    ? 'destructive'
                    : status === 'PENDING_REVIEW'
                      ? 'warning'
                      : 'muted'
              }
            >
              {labels.paymentStatus[status as never] ?? status}
            </CellTag>
          );
        },
      },
      {
        id: 'actions',
        header: locale === 'en' ? 'Actions' : 'الإجراءات',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const payment = row.original;
          const isPaid = payment.paymentStatus === 'PAID';
          const isPendingReview = payment.paymentStatus === 'PENDING_REVIEW';
          const isBusy = busyPaymentId === payment.id;

          return (
            <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
              {isPendingReview && canManage ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-success/40 text-success hover:bg-success/10"
                    disabled={isBusy}
                    onClick={() => void handleReview(payment.id, true)}
                  >
                    {isBusy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-3.5 rtl:ml-1 ltr:mr-1" />
                    )}
                    {locale === 'en' ? 'Confirm' : 'تأكيد'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-destructive hover:bg-destructive/10"
                    disabled={isBusy}
                    onClick={() => void handleReview(payment.id, false)}
                  >
                    {locale === 'en' ? 'Reject' : 'رفض'}
                  </Button>
                </>
              ) : null}

              {canManage && !isPaid && !isPendingReview ? (
                <Link
                  href={`${base}/fees/payments/${payment.id}/settle`}
                  className={buttonVariants({ variant: 'default', size: 'sm' })}
                >
                  <Banknote className="size-3.5 rtl:ml-1.5 ltr:mr-1.5" />
                  {locale === 'en' ? 'Record Payment' : 'تسجيل دفعة'}
                </Link>
              ) : null}

              {payment.paidAmount > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  disabled={isBusy}
                  onClick={() =>
                    void openReceipt(payment.citizenId, payment.id, payment.paidAmount)
                  }
                >
                  {isBusy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Receipt className="size-3.5 rtl:ml-1.5 ltr:mr-1.5" />
                  )}
                  {locale === 'en' ? 'Receipt' : 'وصل القبض'}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [base, canManage, busyPaymentId, openReceipt, handleReview, locale, labels],
  );

  if (!token) return null;

  const tableLabels = getTableLabels(locale);
  const statusFilters = buildStatusFilters(locale, filterOptionsQuery.data?.statuses ?? [], labels);

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader
        icon={Receipt}
        title={locale === 'en' ? 'Fees & Billing' : 'إدارة الرسوم والمدفوعات'}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load()}
              disabled={refreshing}
            >
              <RefreshCw
                className={cn('size-4 rtl:ml-1.5 ltr:mr-1.5', refreshing && 'animate-spin')}
                aria-hidden
              />
              {locale === 'en' ? 'Refresh' : 'تحديث'}
            </Button>

            {canManage ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setChargeOpen(true)}>
                  <UserPlus className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                  {locale === 'en' ? 'Direct Charge' : 'تكليف مباشر'}
                </Button>
                <Button size="sm" onClick={() => setIssueOpen(true)}>
                  <Plus className="size-4 rtl:ml-1.5 ltr:mr-1.5" />
                  {locale === 'en' ? 'Issue New Fee' : 'إصدار رسم جديد'}
                </Button>
              </>
            ) : null}
          </>
        }
      />

      {error ? (
        <p
          role="alert"
          className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {error}
        </p>
      ) : null}

      {/* KPI Cards Summary Row */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label={locale === 'en' ? 'Total Collected' : 'إجمالي المحصّل'}
          value={formatLbp(summary?.paidTotal ?? 0, locale)}
          subtext={
            summary
              ? (locale === 'en' ? `${summary.paidCount} payments settled` : `${summary.paidCount} دفعة مسددة`)
              : undefined
          }
          loading={loading}
          icon={<Wallet className="size-6 text-success" />}
          accent="bg-success/10"
        />
        <MetricCard
          label={locale === 'en' ? 'Unpaid Balance' : 'المستحقات غير المسددة'}
          value={formatLbp(summary?.unpaidTotal ?? 0, locale)}
          subtext={
            summary
              ? (locale === 'en' ? `${summary.unpaidCount} demands due` : `${summary.unpaidCount} مطالبة مطلوبة`)
              : undefined
          }
          loading={loading}
          icon={<Banknote className="size-6 text-primary" />}
        />
        <MetricCard
          label={locale === 'en' ? 'Pending Review' : 'دفعات بانتظار التحقق'}
          value={(summary?.pendingReviewCount ?? 0).toLocaleString('en-US')}
          subtext={locale === 'en' ? 'Transfers awaiting verification' : 'تحويلات تحتاج موافقة الموظف'}
          loading={loading}
          icon={<Clock3 className="size-6 text-warning" />}
          accent="bg-warning/10"
        />
        <MetricCard
          label={locale === 'en' ? 'Total Billed' : 'إجمالي الرسوم الصادرة'}
          value={formatLbp((summary?.paidTotal ?? 0) + (summary?.unpaidTotal ?? 0), locale)}
          subtext={locale === 'en' ? 'Gross billed charges' : 'المجموع الكلي للمطالبات'}
          loading={loading}
          icon={<Receipt className="size-6 text-primary" />}
        />
      </div>

      {/* Main Table Card */}
      <Card className="overflow-hidden">
        <CardHeader className="border-b pb-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <Receipt className="size-5 text-primary" />
              {locale === 'en' ? 'Fees & Billing Register' : 'سجل الرسوم والمطالبات'}
            </CardTitle>

            <div className="flex flex-wrap items-center gap-2">
              {/* Searchable Bill Type Filter */}
              <BillTypeFilter
                value={feeTitleFilter}
                onChange={(nextTitle) => {
                  setFeeTitleFilter(nextTitle);
                  setPagination((previous) =>
                    previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 },
                  );
                }}
                locale={locale}
                existingTitles={feeTitles}
              />

              {/* Status Tabs Filter */}
              {/* Same control as سجل العمليات' method filter — see the note
                  there. Two screens that filter the same ledger should not
                  have two different-looking ways of doing it. */}
              <SegmentedControl
                aria-label={locale === 'en' ? 'Filter by status' : 'تصفية حسب الحالة'}
                value={statusFilter}
                size="sm"
                fullWidth={false}
                options={statusFilters.map((tab) => ({ value: tab.id, label: tab.label }))}
                onChange={(next) => {
                  setStatusFilter(next);
                  setPagination((previous) =>
                    previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 },
                  );
                }}
              />
            </div>
          </div>
        </CardHeader>

        <CardContent className="p-6">
          <DataTable
            columns={columns}
            data={items}
            labels={tableLabels}
            columnStorageKey="fees"
            getRowId={(row) => row.id}
            loading={loading}
            error={paymentsQuery.error}
            onRetry={paymentsQuery.refetch}
            emptyIcon={<Receipt className="size-10 text-muted-foreground/60" />}
            manualPagination
            manualFiltering
            sortable={false}
            pageCount={Math.max(Math.ceil(total / pagination.pageSize), 1)}
            totalRowCount={total}
            pagination={pagination}
            onPaginationChange={setPagination}
            searchValue={appliedSearch}
            onSearchChange={setAppliedSearch}
          />
        </CardContent>
      </Card>

      {/* Issue Fee Dialog */}
      <IssueFeeDialog
        open={issueOpen}
        onOpenChange={setIssueOpen}
        citizens={citizens}
        submitting={issuing}
        error={null}
        onSubmit={handleIssueNotice}
        locale={locale}
        existingTitles={feeTitles}
      />

      {/* Charge Citizen Dialog */}
      <ChargeCitizenDialog
        open={chargeOpen}
        onOpenChange={setChargeOpen}
        citizens={citizens}
        submitting={charging}
        error={null}
        onSubmit={handleChargeCitizen}
        locale={locale}
        existingTitles={feeTitles}
      />

      {/* Receipt Modal Dialog */}
      <PaymentReceipt
        open={receipt !== null}
        onOpenChange={(next) => {
          if (!next) {
            setReceipt(null);
            void load();
          }
        }}
        tenant={tenant}
        citizen={receipt?.citizen ?? ({} as CitizenProfile)}
        payment={receipt?.payment ?? null}
        municipalityName={municipalityName}
        governorate={settings?.governorate}
        councilDecisionRef={settings?.councilDecisionRef}
        district={settings?.district}
        contactPhone={settings?.contactPhone}
        officeWhatsapp={settings?.whatsappNumber}
        receivedAmount={receipt?.received}
        locale={locale}
      />
    </div>
  );
}

function MetricCard({
  label,
  value,
  subtext,
  loading,
  icon,
  accent,
}: {
  label: string;
  value: React.ReactNode;
  subtext?: string;
  loading: boolean;
  icon: React.ReactNode;
  accent?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between p-5">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-7 w-28" />
          ) : (
            <div className="text-xl font-bold tracking-tight text-foreground">{value}</div>
          )}
          {subtext && !loading ? (
            <p className="text-xs text-muted-foreground">{subtext}</p>
          ) : null}
        </div>
        <div
          className={cn(
            'flex size-11 items-center justify-center rounded-xl bg-primary/10',
            accent,
          )}
        >
          {icon}
        </div>
      </CardContent>
    </Card>
  );
}
