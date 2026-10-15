'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { BULK_SETTLE_ROLES, PAYMENT_SETTLE_ROLES, REFERENCE_SEND_ROLES, hasRole } from '@/lib/staff-roles';
import {
  fromAdminPayment,
  isBulkSettleable,
  pageSelection,
  rowBlock,
} from '@/lib/bulk-settle';
import { useBulkSelection } from '@/lib/use-bulk-selection';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Banknote,
  CheckCircle2,
  FileWarning,
  Loader2,
  Plus,
  Receipt,
  RefreshCw,
  UserPlus,
} from 'lucide-react';
import {
  FEE_ADMIN_ROLES,
  FEE_ISSUE_ROLES,
  getLabels,
  PAYMENT_REVIEW_READ_ROLES,
  PAYMENT_STATUS,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  chargeCitizen,
  getAllPayments,
  getCitizenProfile,
  getFeeSummary,
  getFeeFilterOptions,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
  reviewPayment,
} from '@/lib/api-client';
import type {
  AdminPaymentItem,
  CitizenProfile,
  CitizenProfilePayment,
} from '@/lib/api-client';
import { useStaffSession } from '@/lib/use-staff-session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useTableLabels } from '@/lib/use-table-labels';
import { param, useTabSearch, useUrlPagination, useUrlState } from '@/lib/use-url-state';
import { describeAssessment } from '@/lib/fee-assessment';
import { formatDate } from '@/lib/dates';
import { CellTag } from '@/components/ui/cell-tag';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { LoadingState } from '@/components/ui/states';
import { useToast } from '@/components/ui/toast';
import { ChargeCitizenDialog, type ChargeValues } from '@/components/admin/charge-citizen-dialog';
import { BillTypeFilter } from '@/components/admin/bill-type-select';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { BillCheckbox } from '@/components/admin/bulk-settle/bill-checkbox';
import { BulkSettleBar } from '@/components/admin/bulk-settle/bulk-settle-bar';
import { FeesSummaryStrip } from '@/components/admin/fees/fees-summary-strip';
import { PaymentReviewDialog } from '@/components/admin/fees/payment-review-dialog';
import { cn } from '@/lib/utils';

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

/** «الكل» (`''`, no filter) plus every status the column can hold. */
const STATUS_FILTER_VALUES = ['', ...PAYMENT_STATUS] as const;
type StatusFilter = (typeof STATUS_FILTER_VALUES)[number];

/**
 * The status tab, in the query string so a reload or a shared link reopens
 * the ledger on it. Validated against the enum rather than the tabs on screen:
 * which tabs appear is only known once `filterOptionsQuery` answers.
 */
const FEES_URL_STATE = { status: param.oneOf(STATUS_FILTER_VALUES, '') };

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
  const base = `/${tenant}/${locale}/${adminPath}`;

  const { token, user } = useStaffSession(tenant, base);
  const role = user?.role;

  // Table Data State — survives a reload: status and page in the URL, the two
  // free-text values in this tab's storage.
  const [{ status: statusFilter }, setUrlState] = useUrlState(FEES_URL_STATE);
  /*
    «نوع الرسم» is not a catalogue key: it is whatever title staff typed when
    issuing a fee or charging one citizen directly (`listDistinctTitles` reads
    both), so it can hold a name — and the server matches it against
    `searchText` as well. Kept out of the URL with the search box for that.
  */
  const [feeTitleFilter, setFeeTitleFilter] = useTabSearch(tenant, 'fees-title');
  const [appliedSearch, setAppliedSearch] = useTabSearch(tenant, 'fees');
  const [pagination, setPagination] = useUrlPagination({ defaultSize: 10 });

  // Dialogs State
  const [chargeOpen, setChargeOpen] = useState(false);
  const [charging, setCharging] = useState(false);
  const [busyPaymentId, setBusyPaymentId] = useState<string | null>(null);
  const [review, setReview] = useState<{ payment: AdminPaymentItem; confirmed: boolean } | null>(null);

  // Receipt State
  const [receipt, setReceipt] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  const toast = useToast();
  const tSelect = useTranslations('bulkSettle.select');
  /*
    Only what this ledger says that the shared `table` strings do not: what it
    searches by, what it is empty of, and what it counts. The column picker
    is asked for (`columnsMenu`): this ledger keeps its choice of columns.
  */
  const tableLabels = useTableLabels({
    ...(locale === 'en'
      ? {
          searchAriaLabel: 'Search fees and demands',
          searchPlaceholder: 'Search by citizen name, fee title, or reference code…',
          searchApplied: 'Search: "{term}"',
          empty: 'No fees or demands registered yet.',
          emptyHint: 'Issue your first fee using the "Issue Fee Notice" button above.',
          emptySearchHint: 'Try searching by citizen name, fee title, or reference code.',
          loadError: 'Failed to load fees and payments register.',
          totalRows: '{count} demands',
        }
      : {
          searchAriaLabel: 'بحث في الرسوم والمطالبات',
          searchPlaceholder: 'ابحث باسم المواطن أو الرسم أو الرقم المرجعي…',
          searchApplied: 'بحث: «{term}»',
          empty: 'لا توجد رسوم أو مطالبات مسجّلة بعد.',
          emptyHint: 'أصدر أول رسم من زر «إصدار رسم جديد» أعلاه.',
          emptySearchHint: 'جرّب البحث باسم المواطن، أو نوع الرسم، أو الرقم المرجعي.',
          loadError: 'تعذّر تحميل سجل الرسوم والمدفوعات.',
          totalRows: '{count} مطالبة',
        }),
  }, { columnsMenu: true });
  const tReview = useTranslations('fees.register.review');
  const tCommon = useTranslations('common');
  /** «تأكيد» / «رفض» on a declared transfer — `FEE_ADMIN_ROLES`, as `PATCH fees/payments/:id/review`. */
  const canDecide = hasRole(FEE_ADMIN_ROLES, role);
  /** «تكليف مباشر» and «إصدار رسم جديد» — `FEE_ISSUE_ROLES`, as `POST fees/payments`, `POST fees/notices` and the `fees/new` page. */
  const canIssue = hasRole(FEE_ISSUE_ROLES, role);
  /** «فواتير تأثّرت بتصحيحات» — `PAYMENT_REVIEW_READ_ROLES`, as the nav row of `/fees/corrections`. */
  const canReadCorrections = hasRole(PAYMENT_REVIEW_READ_ROLES, role);
  /** «تسجيل دفعة» — `PAYMENT_SETTLE_ROLES` (`SUPER_ADMIN`, `ACCOUNTANT`, `COLLECTOR`). */
  const canSettle = hasRole(PAYMENT_SETTLE_ROLES, role);
  /** «تسديد الفواتير المحددة» — `BULK_SETTLE_ROLES`, as the route's `@Roles`; the server is the enforcement. */
  const canBulkSettle = hasRole(BULK_SETTLE_ROLES, role);
  /*
    The ticked bills, kept whole so the bar's totals survive a page turn; one
    citizen's at a time (`lib/bulk-settle.ts`). Cleared when a filter changes,
    because the rows it was ticked from are no longer the ones on screen.
  */
  const selection = useBulkSelection(tenant);
  const { clear: clearSelection, reconcile: reconcileSelection } = selection;
  useEffect(() => {
    clearSelection();
  }, [statusFilter, feeTitleFilter, appliedSearch, clearSelection]);

  /**
   * What the filters above the ledger may offer — the bill titles that exist
   * and the statuses the register has actually reached.
   *
   * Deliberately **not** `reference` here, unlike سجل العمليات, which asks for
   * the same key and may hold it for the session.
   *
   * `titles` and `methods` really are the municipality's vocabulary: only a
   * write changes them, which is why one read per session was right and why
   * `load()` invalidating the key was enough. `statuses` stopped being that
   * the moment «متأخرة» became a predicate rather than a column — whether the
   * register holds an overdue invoice now depends on the clock, and no write
   * happens when midnight passes. Held for the session it would go stale with
   * nothing to invalidate it, and the failure would be the exact one the tab
   * was fixed to remove: rows reading «متأخرة» with no tab to filter them by.
   *
   * So this screen takes the ordinary policy and re-reads on focus. It is
   * three counts and a DISTINCT, and the screen that shows the tabs is the one
   * that has to be right about them.
   */
  const filterOptionsQuery = useStaffQuery({
    queryKey: ['fee-filter-options', tenant],
    queryFn: (accessToken, signal) => getFeeFilterOptions(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل خيارات التصفية.',
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
    Everything on this screen that is not the ledger: the headline figures and
    the office details a reprinted وصل carries. `allSettled` rather than `all`,
    kept from the original, because a receipt's phone number failing to load
    must not blank the table beside it. The charge dialog searches the register
    itself, on the server (`useCitizenSearch`).
  */
  const contextQuery = useStaffQuery({
    queryKey: ['fees-context', tenant],
    queryFn: async (accessToken) => {
      const [summaryRes, settingsRes, configRes] = await Promise.allSettled([
        getFeeSummary(tenant, accessToken),
        getMunicipalitySettings(tenant, accessToken),
        getTenantConfig(tenant),
      ]);
      for (const result of [summaryRes, settingsRes, configRes]) {
        if (result.status === 'rejected') logApiError(result.reason);
      }
      return {
        summary: summaryRes.status === 'fulfilled' ? summaryRes.value : null,
        settings: settingsRes.status === 'fulfilled' ? settingsRes.value : null,
        municipalityName:
          configRes.status === 'fulfilled'
            ? configRes.value.nameAr || configRes.value.name
            : '',
      };
    },
    tenant,
    base,
    token,
    errorMessage: 'تعذّر تحميل بيانات الرسوم.',
  });

  const items = paymentsQuery.data?.items ?? [];
  const total = paymentsQuery.data?.total ?? 0;

  /*
    Every read of the register checks the ticked bills against it: one paid or
    sent for review since it was ticked has lost its box, so it leaves the set
    rather than staying in the bar with nothing on screen to untick it.
  */
  const paymentRows = paymentsQuery.data?.items;
  useEffect(() => {
    if (!paymentRows) return;
    reconcileSelection(paymentRows.map((row) => ({ bill: fromAdminPayment(row), settleable: isBulkSettleable(row) })));
  }, [paymentRows, reconcileSelection]);
  const summary = contextQuery.data?.summary ?? null;
  const settings = contextQuery.data?.settings ?? null;
  const municipalityName = contextQuery.data?.municipalityName ?? '';
  const loading = paymentsQuery.loading;
  const refreshing = paymentsQuery.fetching || contextQuery.fetching;

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

  /**
   * The decision `PaymentReviewDialog` asked for. A refusal is rethrown for
   * the dialog to show under its question; a conflict — another clerk decided
   * first, or the counter settled the bill — re-reads the register as well.
   */
  const decideReview = useCallback(
    async (paymentId: string, confirmed: boolean) => {
      if (!token) return;
      try {
        await reviewPayment(tenant, token, paymentId, { confirmed });
      } catch (caught) {
        logApiError(caught);
        if (caught instanceof ApiRequestError && caught.kind === 'CONFLICT') void load();
        throw caught;
      }
      // Confirming puts the money in a wallet, so the treasury's balances are stale; a refusal moves none.
      if (confirmed) void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
      toast.success(confirmed ? tReview('confirmed') : tReview('rejected'));
      void load();
    },
    [tenant, token, toast, load, queryClient, tReview],
  );


  /*
    Synchronous, unlike `charging`, which lands a render after a fast second
    press — and a second press of «تكليف» raised a second bill (STA-4). The
    route takes no retry key yet (docs/ui-ux-standards.md §17), so a lost
    answer is still the clerk's to check on the register before pressing again.
  */
  const chargeInFlight = useRef(false);

  const handleChargeCitizen = async (values: ChargeValues) => {
    if (!token || chargeInFlight.current) return;
    chargeInFlight.current = true;
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
      chargeInFlight.current = false;
      setCharging(false);
    }
  };

  const labels = getLabels(locale);

  /** This page's bills that may be ticked, and where «تحديد الكل» stands over them. */
  const eligibleOnPage = useMemo(
    () => (paymentRows ?? []).filter(isBulkSettleable).map(fromAdminPayment),
    [paymentRows],
  );
  const pageState = pageSelection(selection.bills, eligibleOnPage);
  const pageBox = useCallback(
    (id?: string) =>
      pageState.eligible > 0 ? (
        <BillCheckbox
          id={id}
          subject={{ kind: 'page', allSelected: pageState.allSelected }}
          checked={pageState.allSelected}
          blocked={pageState.blocked}
          onToggle={() => selection.toggleRows(eligibleOnPage)}
        />
      ) : null,
    [pageState.eligible, pageState.allSelected, pageState.blocked, selection, eligibleOnPage],
  );
  /** A row's box: only on a bill with something owed that is neither paid nor under review. */
  const rowBox = useCallback(
    (payment: AdminPaymentItem) => {
      if (!isBulkSettleable(payment)) return null;
      const bill = fromAdminPayment(payment);
      return (
        <BillCheckbox
          subject={{ kind: 'row', title: payment.title, name: payment.citizenName }}
          checked={selection.bills.some((entry) => entry.id === payment.id)}
          blocked={rowBlock(selection.bills, bill)}
          onToggle={() => selection.toggle(bill)}
        />
      );
    },
    [selection],
  );

  const columns = useMemo<ColumnDef<AdminPaymentItem>[]>(
    () => [
      /*
        «تسديد الفواتير المحددة»: a box per settleable bill, «تحديد الكل» in the
        heading. Hidden from the phone cards, where the box sits in the card's
        heading beside the name instead (below) — a function header would
        otherwise make it an action column pinned to the card's footer.
      */
      ...(canBulkSettle
        ? [
            {
              id: 'select',
              header: () => pageBox(),
              cell: ({ row }) => rowBox(row.original),
              enableHiding: false,
              meta: { mobile: 'hide', headerClassName: 'w-12', label: tSelect('page') },
            } satisfies ColumnDef<AdminPaymentItem>,
          ]
        : []),
      {
        accessorKey: 'citizenName',
        header: locale === 'en' ? 'Citizen' : 'المواطن',
        cell: ({ row }) => {
          const payment = row.original;
          return (
            <div className="flex items-center gap-3">
              {canBulkSettle ? <span className="inline-flex sm:hidden">{rowBox(payment)}</span> : null}
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
        // In the bill's own currency, exact: the figure a clerk reads back to the payer (PRIM-10, PRIM-11).
        cell: ({ row }) => (
          <Money
            amount={row.original.amount}
            currency={row.original.currency}
            exact
            locale={locale}
            className="text-sm text-foreground"
          />
        ),
      },
      {
        accessorKey: 'paidAmount',
        header: locale === 'en' ? 'Paid' : 'المسدد',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const paid = row.original.paidAmount;
          return paid > 0 ? (
            <Money
              amount={paid}
              currency={row.original.currency}
              exact
              locale={locale}
              className="text-sm font-semibold text-success"
            />
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          );
        },
      },
      {
        accessorKey: 'remaining',
        header: locale === 'en' ? 'Balance Due' : 'الرصيد المستحق',
        meta: { align: 'end' },
        cell: ({ row }) => {
          const remaining = row.original.remaining;
          // Settled or cancelled: nothing is owed on it either way.
          const isClosed = row.original.paymentStatus === 'PAID' || row.original.paymentStatus === 'CANCELLED';
          return (
            <Money
              amount={remaining}
              currency={row.original.currency}
              exact
              locale={locale}
              className={cn(
                'text-sm font-semibold',
                isClosed ? 'text-muted-foreground line-through opacity-70' : remaining > 0 ? 'text-foreground' : 'text-success',
              )}
            />
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
          // A cancelled bill takes no payment (0090); the server refuses one anyway.
          const isCancelled = payment.paymentStatus === 'CANCELLED';
          const isBusy = busyPaymentId === payment.id;

          return (
            <div className="flex items-center justify-end gap-1.5 whitespace-nowrap">
              {isPendingReview && canDecide ? (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 text-xs border-success/40 text-success hover:bg-success/10"
                    disabled={isBusy}
                    onClick={() => setReview({ payment, confirmed: true })}
                  >
                    <CheckCircle2 className="size-3.5" aria-hidden />
                    {locale === 'en' ? 'Confirm' : 'تأكيد'}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8 text-xs text-destructive hover:bg-destructive/10"
                    disabled={isBusy}
                    onClick={() => setReview({ payment, confirmed: false })}
                  >
                    {locale === 'en' ? 'Reject' : 'رفض'}
                  </Button>
                </>
              ) : null}

              {canSettle && !isPaid && !isPendingReview && !isCancelled ? (
                <Link
                  href={`${base}/fees/payments/${payment.id}/settle`}
                  className={buttonVariants({ variant: 'default', size: 'sm' })}
                >
                  <Banknote className="size-3.5" aria-hidden />
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
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Receipt className="size-3.5" aria-hidden />
                  )}
                  {locale === 'en' ? 'Receipt' : 'وصل القبض'}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [base, canDecide, canSettle, busyPaymentId, openReceipt, locale, labels, canBulkSettle, pageBox, rowBox, tSelect],
  );

  if (!token) return <LoadingState fullHeight label={tCommon('loading')} />;

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
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} aria-hidden />
              {locale === 'en' ? 'Refresh' : 'تحديث'}
            </Button>

            {canReadCorrections ? (
              <Link href={`${base}/fees/corrections`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                <FileWarning className="size-4" aria-hidden />
                {locale === 'en' ? 'Bills affected by corrections' : 'فواتير تأثّرت بتصحيحات'}
              </Link>
            ) : null}

            {canIssue ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setChargeOpen(true)}>
                  <UserPlus className="size-4" aria-hidden />
                  {locale === 'en' ? 'Direct Charge' : 'تكليف مباشر'}
                </Button>
                <Button asChild size="sm">
                  <Link href={`${base}/fees/new`}>
                    <Plus className="size-4" aria-hidden />
                    {locale === 'en' ? 'Issue New Fee' : 'إصدار رسم جديد'}
                  </Link>
                </Button>
              </>
            ) : null}
          </>
        }
      />

      <FeesSummaryStrip
        summary={summary}
        loading={contextQuery.loading}
        onRetry={() => void contextQuery.refetch()}
        pendingHref={statusFilter === 'PENDING_REVIEW' ? undefined : `${base}/fees?status=PENDING_REVIEW`}
        locale={locale}
      />

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
                onChange={(next) =>
                  setUrlState({ status: next as StatusFilter }, { clear: ['page'] })
                }
              />
            </div>
          </div>
        </CardHeader>

        {/* One frame: the card's, around a borderless table (BAN-4). */}
        <CardContent className="p-0">
          {/* The phone cards have no heading row, so «تحديد الكل» stands above them. */}
          {canBulkSettle && pageState.eligible > 0 ? (
            <div className="flex items-center gap-2 px-6 pb-3 pt-6 sm:hidden">
              {pageBox('fees-select-page')}
              <label htmlFor="fees-select-page" className="text-sm">
                {pageState.allSelected ? tSelect('pageClear') : tSelect('page')}
              </label>
            </div>
          ) : null}
          <DataTable
            className="rounded-none border-0 shadow-none"
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


      {/* Charge Citizen Dialog */}
      <ChargeCitizenDialog
        open={chargeOpen}
        onOpenChange={setChargeOpen}
        tenant={tenant}
        token={token}
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
        canSend={hasRole(REFERENCE_SEND_ROLES, role)}
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

      <PaymentReviewDialog
        review={review}
        onOpenChange={(next) => {
          if (!next) setReview(null);
        }}
        onConfirm={decideReview}
        locale={locale}
      />

      {/* «تسديد الفواتير المحددة» — sticky at the foot while a bill is ticked; a direct child of the root. */}
      {canBulkSettle ? (
        <BulkSettleBar
          tenant={tenant}
          base={base}
          token={token}
          locale={locale}
          selection={selection}
          onSettled={() => void load()}
          onStale={() => void load()}
        />
      ) : null}
    </div>
  );
}
