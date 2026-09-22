'use client';

import { use, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { ColumnDef } from '@tanstack/react-table';
import {
  ArrowLeftRight,
  Banknote,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Loader2,
  Receipt,
  UserCheck,
} from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import {
  getAllPayments,
  getCitizenProfile,
  getFeeFilterOptions,
  getMunicipalitySettings,
  getTenantConfig,
  logApiError,
} from '@/lib/api-client';
import type {
  AdminPaymentItem,
  CitizenProfile,
  CitizenProfilePayment,
} from '@/lib/api-client';
import { loadSession } from '@/lib/session';
import { useStaffQuery } from '@/lib/use-staff-query';
import { formatLbp } from '@/lib/currency';
import { formatDateTime, formatRelative } from '@/lib/dates';
import { Alert } from '@/components/ui/alert';
import { CellTag } from '@/components/ui/cell-tag';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type DataTableLabels } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { ActionTooltip } from '@/components/ui/tooltip';
import { PaymentReceipt } from '@/components/admin/payment-receipt';
import { cn } from '@/lib/utils';

/**
 * The table chrome, from the shared `table` catalogue plus this screen's own
 * two strings.
 *
 * This was a module-level `const` of twenty Arabic literals, which is why an
 * English visitor saw an Arabic table: a value computed once at import time
 * cannot depend on the request's locale. Nineteen of those literals were also
 * *already* in `messages/*.json` under `table` — the catalogue had been written
 * and then not used — so the fix is mostly deletion.
 *
 * Built inside the component rather than at module scope for that same reason,
 * and memoised on the two translators so the object is stable across renders:
 * `DataTable` takes `labels` by reference, and a fresh one every keystroke
 * would re-render the whole grid.
 */
function useTableLabels(): DataTableLabels {
  const t = useTranslations('table');
  const tPayments = useTranslations('payments');

  return useMemo(
    () => ({
      // The two that are genuinely about payments rather than about tables: the
      // placeholder names this screen's searchable fields, and the row count is
      // «١٢ عملية» rather than a bare total.
      searchAriaLabel: tPayments('searchAria'),
      searchPlaceholder: tPayments('searchPlaceholder'),
      searchApplied: tPayments('searchApplied'),
      empty: tPayments('empty'),
      loadError: tPayments('loadError'),
      totalRows: tPayments('totalRows'),

      clearSearch: t('clearSearch'),
      // Not translated: it is the name of a key on the keyboard.
      searchHint: 'Enter',
      emptySearch: t('emptySearch'),
      retry: t('retry'),
      previous: t('previous'),
      next: t('next'),
      pageOf: t('pageOf'),
      rowsPerPage: t('rowsPerPage'),
      sortAscending: t('sortAsc'),
      sortDescending: t('sortDesc'),
      sortNone: t('sortNone'),
      columns: t('columns'),
      columnsHint: t('columnsHint'),
      resetColumns: t('resetColumns'),
    }),
    [t, tPayments],
  );
}

/**
 * What the tiles show before the first response, and after a failed one.
 *
 * A stable object rather than a literal built during render: it is the
 * fallback for a query result, so a new one every render would make the tiles
 * re-render on every keystroke elsewhere on the page.
 *
 * These figures are the server's, over every matching row rather than the
 * page. Summing the rows in hand would make «إجمالي المحصّل» mean "the
 * twenty-five rows currently on screen" — a total that changes when you press
 * «التالي».
 */
const EMPTY_TOTALS = {
  collected: 0,
  cash: 0,
  whish: 0,
  collector: 0,
  awaiting: 0,
} as const;

/**
 * The order the method tabs read in, and the glyph each one carries.
 *
 * Which of them appear is not decided here — see `filterOptionsQuery`. A
 * municipality that has never taken a Whish transfer had a «Whish» tab anyway,
 * and pressing it emptied the ledger: a question with only one possible
 * answer, and that answer "nothing". The tabs are now the methods money has
 * actually arrived by.
 */
const METHOD_TAB_ORDER = ['CASH', 'WHISH_MONEY', 'COLLECTOR'] as const;

/**
 * The glyph and the catalogue key per method — no label text.
 *
 * The labels used to live here as Arabic literals. They cannot: a module-level
 * constant is evaluated once per process, before any request has a locale, so
 * whatever language was written here was the language every visitor got. What
 * stays is the part that genuinely does not vary — the order, and the icon.
 */
const METHOD_TAB = {
  CASH: { key: 'methodCash', icon: Banknote },
  WHISH_MONEY: { key: 'methodWhish', icon: CreditCard },
  COLLECTOR: { key: 'methodCollector', icon: UserCheck },
} as const;

/** «الكل» is not a method — it is the absence of the filter — so it is always here. */
const ALL_METHODS_TAB = { id: '', key: 'methodAll', icon: ArrowLeftRight } as const;

/** Text tone and glyph per method — one place, so the filter and the row agree. */
const METHOD_STYLE = {
  CASH: { icon: Banknote, tone: 'success' },
  WHISH_MONEY: { icon: CreditCard, tone: 'primary' },
  COLLECTOR: { icon: UserCheck, tone: 'warning' },
} as const;

/** Opening letters of the first and last name — what goes on a folder tab. */
function initials(fullName: string): string {
  const words = fullName.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '—';
  return `${words[0][0] ?? ''}${words.length > 1 ? (words[words.length - 1][0] ?? '') : ''}`;
}

/**
 * سجل العمليات — every payment transaction in the municipality.
 *
 * Deliberately not the fees ledger with different columns. That screen answers
 * "who owes what", is grouped by citizen and ordered by who to chase; this one
 * answers "what has been paid", is one row per transaction and ordered by when
 * the money moved. An invoice nobody has paid appears on the first and not
 * here — it is an obligation, not a transaction.
 *
 * Read-only by design. Taking money, confirming a transfer and refusing one all
 * live in إدارة الرسوم next to the balance they change; duplicating them here
 * would put two screens in a position to disagree about the same row. The one
 * action that is not a mutation — reprinting a وصل — is here, because looking
 * up a past transaction is exactly when a citizen asks for one.
 */
export default function PaymentsPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const router = useRouter();
  const base = `/${tenant}/${locale}/${adminPath}`;

  const t = useTranslations('payments');
  const tableLabels = useTableLabels();
  /**
   * Enum labels — payment method, and anything else this screen renders from a
   * server enum.
   *
   * Was `import { ar }`, which is the same bug as the table labels in a
   * different costume: a direct import of the Arabic label set, so an English
   * visitor got Arabic method names inside an otherwise English page. `getLabels`
   * is the accessor the citizen-facing payments screen already uses, and it
   * takes the locale.
   */
  const labels = getLabels(locale);

  const [token, setToken] = useState<string | null>(null);
  const [method, setMethod] = useState<string>('');
  /** The committed term — set when the clerk presses Enter, not as they type. */
  const [appliedSearch, setAppliedSearch] = useState('');
  /**
   * The page the server was asked for.
   *
   * Held here rather than inside the table because it is a *request parameter*
   * now: the table shows one page of a larger set, so the page index has to
   * survive alongside the filters that produced it.
   */
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 10 });
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** A failed action — opening a وصل. The reads report their own failures. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiptBusyId, setReceiptBusyId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    citizen: CitizenProfile;
    payment: CitizenProfilePayment;
    received: number;
  } | null>(null);

  useEffect(() => {
    const session = loadSession(tenant);
    if (!session || session.user.kind !== 'STAFF') {
      router.replace(`${base}/login`);
      return;
    }
    setToken(session.accessToken);
  }, [tenant, base, router]);

  /*
    The ledger slice being looked at, and nothing else.

    The office settings and the tenant config were fetched alongside it on every
    read, though neither is rendered here — they exist so a reprinted وصل carries
    the same numbers the original did. Paying for them on every page turn was
    waste; they are their own query now, keyed on the tenant, and a page turn no
    longer touches them.

    Cancellation comes with the key. This page had two effects that could each
    change what was being asked for, so switching a method tab while on page 7
    fired one read at the stale offset and another at zero, with nothing
    deciding which reply won.
  */
  const paymentsQuery = useStaffQuery({
    queryKey: [
      'transactions',
      tenant,
      method,
      appliedSearch,
      pagination.pageIndex,
      pagination.pageSize,
    ],
    queryFn: (accessToken, signal) =>
      getAllPayments(
        tenant,
        accessToken,
        {
          transactionsOnly: true,
          method: method || undefined,
          search: appliedSearch || undefined,
          limit: pagination.pageSize,
          offset: pagination.pageIndex * pagination.pageSize,
        },
        signal,
      ),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
    keepPrevious: true,
  });

  /**
   * The methods money has actually arrived by, for the tab row.
   *
   * `reference`: read once and held for the session, and shared with إدارة
   * الرسوم, which asks for the same key. This screen is read-only by design —
   * it takes no payments — so nothing it does can extend the vocabulary, and
   * it never needs to invalidate the key. The screen that *can* extend it does
   * (see the fees ledger's `load`).
   */
  const filterOptionsQuery = useStaffQuery({
    queryKey: ['fee-filter-options', tenant],
    queryFn: (accessToken, signal) => getFeeFilterOptions(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: t('filterOptionsError'),
    reference: true,
  });

  const methodTabs = useMemo(() => {
    const present = new Set(filterOptionsQuery.data?.methods ?? []);
    return [
      { id: ALL_METHODS_TAB.id, label: t(ALL_METHODS_TAB.key), icon: ALL_METHODS_TAB.icon },
      ...METHOD_TAB_ORDER.filter((method) => present.has(method)).map((method) => ({
        id: method,
        label: t(METHOD_TAB[method].key),
        icon: METHOD_TAB[method].icon,
      })),
    ];
  }, [filterOptionsQuery.data, t]);

  /** The office details a reprinted وصل carries. Neither is rendered on this page. */
  const receiptContextQuery = useStaffQuery({
    queryKey: ['receipt-context', tenant],
    queryFn: async (accessToken) => {
      const [settings, config] = await Promise.all([
        getMunicipalitySettings(tenant, accessToken),
        getTenantConfig(tenant),
      ]);
      return { settings, municipalityName: config.nameAr || config.name };
    },
    tenant,
    base,
    token,
    errorMessage: t('municipalityError'),
  });

  const items = paymentsQuery.data?.items ?? [];
  const total = paymentsQuery.data?.total ?? 0;
  const totals = paymentsQuery.data?.totals ?? EMPTY_TOTALS;
  const settings = receiptContextQuery.data?.settings ?? null;
  const municipalityName = receiptContextQuery.data?.municipalityName ?? '';
  /*
    The banner above the page and the state inside the table say different
    things, and used to say the same one twice.

    A failed *read* belongs to the table: it is the table that has no rows to
    show, it is the table that needs the retry button, and a table rendering
    «لا توجد نتائج» after a request failed is telling the reader the register is
    empty when it is only unreachable. A failed *write* has no such home — the
    rows are fine, an action was refused — so that is what the banner is for.
  */
  const error = actionError ?? receiptContextQuery.error;


  /** Reprints the وصل for one transaction, exactly as إدارة الرسوم does. */
  const openReceipt = useCallback(
    async (payment: AdminPaymentItem) => {
      if (!token) return;
      setReceiptBusyId(payment.id);
      try {
        const profile = await getCitizenProfile(tenant, token, payment.citizenId);
        const row = profile.payments.find((entry) => entry.id === payment.id);
        if (!row) return;
        setReceipt({ citizen: profile, payment: row, received: payment.paidAmount });
      } catch (caught) {
        logApiError(caught);
        setActionError(t('receiptError'));
      } finally {
        setReceiptBusyId(null);
      }
    },
    [tenant, token, t],
  );

  const copyId = useCallback((id: string) => {
    void navigator.clipboard?.writeText(id);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
  }, []);

  /**
   * The server's figures, not the page's.
   *
   * These used to be reduced from `items`, which was every matching row until
   * the table became paginated. Leaving them there would have made «إجمالي
   * المحصّل» mean "the twenty-five rows currently on screen" — a total that
   * changes when you press «التالي».
   */

  const columns = useMemo<ColumnDef<AdminPaymentItem>[]>(
    () => [
      {
        id: 'reference',
        accessorFn: (row) => row.id,
        header: t('colReference'),
        enableSorting: false,
        meta: { align: 'start', cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const payment = row.original;
          // A UUID is unreadable and unquotable in full. The last segment is
          // what a clerk reads back over the phone; the copy button is what
          // gets the whole thing into a message or a ticket.
          const short = payment.id.split('-').at(-1) ?? payment.id;
          return (
            // Held down in size and colour rather than in a grey chip: this
            // is a lookup key someone reaches for once a week, and at the
            // payer's name's weight it competed with every column that gets
            // read on every row. The box did that job and cost more than it
            // was worth — it inset the value from the cell's edge, so «رقم
            // العملية» no longer sat over its own column.
            <div className="flex items-center gap-1">
              <span
                className="font-mono text-xs uppercase tracking-tight text-muted-foreground"
                dir="ltr"
              >
                {short}
              </span>
              <ActionTooltip label={copiedId === payment.id ? t('copied') : t('copyFull')}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => copyId(payment.id)}
                  aria-label={t('copyAria')}
                >
                  {copiedId === payment.id ? (
                    <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                </Button>
              </ActionTooltip>
            </div>
          );
        },
      },
      {
        accessorKey: 'citizenName',
        header: t('colPayer'),
        meta: { align: 'start' },
        cell: ({ row }) => {
          const payment = row.original;
          return (
            <div className="flex min-w-0 items-center gap-3">
              {/* Initials rather than a generic silhouette: every row would
                  carry the same icon, so it distinguishes nothing — the two
                  letters are what let a clerk find a name down a column. */}
              <span
                aria-hidden
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary"
              >
                {initials(payment.citizenName)}
              </span>
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-medium">{payment.citizenName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {payment.citizenReference ? (
                    <span className="font-mono" dir="ltr">
                      {payment.citizenReference}
                    </span>
                  ) : null}
                  {payment.citizenReference ? ' · ' : ''}
                  {payment.title}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'paidAmount',
        header: t('colAmount'),
        // The one column genuinely read *as a column*: aligning the figures to
        // the same edge as their heading is what lets a run of amounts be
        // compared down the page rather than each one found individually.
        meta: { align: 'end', cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const payment = row.original;
          // A claimed transfer has moved nothing yet, so the figure shown is
          // the invoice's — labelled, so it is not mistaken for money in hand.
          const claimed = payment.paidAmount === 0;
          const partial = payment.paidAmount > 0 && payment.remaining > 0;
          // No alignment class on the wrapper — the column's `meta.align`
          // governs the cell, so a value can never sit against a different
          // edge from the heading above it.
          return (
            <div className="space-y-0.5">
              {/* The amount is the number this page is read for, so it carries
                  the most weight of anything in a row — but only when it is
                  money that actually arrived. A claimed transfer shows the
                  invoice's figure in muted weight, so a column of totals cannot
                  be skimmed as if every line were collected. */}
              <p
                className={cn(
                  'text-base tabular-nums',
                  claimed ? 'font-medium text-muted-foreground' : 'font-bold',
                )}
              >
                {formatLbp(claimed ? payment.amount : payment.paidAmount, locale)}
              </p>
              {claimed ? (
                <p className="text-xs text-muted-foreground">{t('claimedAmount')}</p>
              ) : partial ? (
                <p className="text-xs text-warning">
                  {t('partial', { remaining: formatLbp(payment.remaining, locale) })}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        accessorKey: 'paymentMethod',
        header: t('colMethod'),
        meta: { align: 'start' },
        cell: ({ row }) => {
          const payment = row.original;
          if (!payment.paymentMethod) return <span className="text-muted-foreground">—</span>;
          const style =
            METHOD_STYLE[payment.paymentMethod as keyof typeof METHOD_STYLE] ??
            METHOD_STYLE.CASH;
          const Icon = style.icon;
          return (
            <div className="space-y-1">
              <CellTag tone={style.tone}>
                <Icon className="size-3" aria-hidden />
                {labels.paymentMethod[payment.paymentMethod as never] ?? payment.paymentMethod}
              </CellTag>
              {/* Each method's one auditable fact, under the method: the
                  transfer's number, or the name of whoever is holding the
                  cash until he hands it in. */}
              {payment.whishTransactionRef ? (
                <p className="font-mono text-xs text-muted-foreground" dir="ltr">
                  {payment.whishTransactionRef}
                </p>
              ) : payment.collectedByName ? (
                <p className="text-xs text-muted-foreground">
                  {t('heldBy', { name: payment.collectedByName })}
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'receipt',
        accessorFn: (row) => (row.paidAmount > 0 ? 1 : 0),
        header: t('colReceipt'),
        meta: { align: 'start', cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const payment = row.original;
          // There is no stored "receipt was printed" flag anywhere in this
          // system — a وصل is rendered on demand from the committed figures.
          // So the honest status is whether one *can* be issued, which is true
          // exactly when money has been received against the row.
          if (payment.paidAmount <= 0) {
            return (
              <CellTag tone="muted">
                <Clock className="size-3" aria-hidden />
                {t('awaitingConfirmation')}
              </CellTag>
            );
          }
          return (
            // `ghost`, not `outline`: on the dark palette an outline button is
            // a filled near-black block, which made this the heaviest element
            // in the row — louder than the amount it belongs to. A tinted text
            // action reads as a link into the row rather than as the row's
            // headline.
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-primary hover:bg-primary/10 hover:text-primary"
              disabled={receiptBusyId === payment.id}
              onClick={() => void openReceipt(payment)}
            >
              {receiptBusyId === payment.id ? (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Receipt className="size-3.5" aria-hidden />
              )}
              {t('issueReceipt')}
            </Button>
          );
        },
      },
      {
        id: 'stamp',
        accessorFn: (row) => row.paidAt ?? row.updatedAt,
        header: t('colStamp'),
        meta: { align: 'start', cellClassName: 'whitespace-nowrap' },
        cell: ({ row }) => {
          const payment = row.original;
          const exact = payment.paidAt !== null;
          const stampedAt = payment.paidAt ?? payment.updatedAt;
          const stamp = (
            <div className="space-y-0.5">
              {/* «قبل ساعتين» leads, because the question asked of a
                  chronological log is whether this is today's money; the exact
                  stamp underneath is what identifies the transaction. */}
              <p className="text-sm">
                {exact ? '' : '≈ '}
                {formatRelative(stampedAt, locale)}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                <bdi dir="ltr">{formatDateTime(stampedAt)}</bdi>
              </p>
            </div>
          );

          // A part-payment never gets a `paidAt` — the server only stamps one
          // on full settlement — so this falls back to the row's last write.
          // It is marked rather than presented as the payment time, because a
          // figure a clerk might reconcile against a cash drawer has to say
          // when it is an approximation.
          return exact ? (
            stamp
          ) : (
            <ActionTooltip label={t('approximateStamp')}>
              <span className="cursor-help border-b border-dashed border-muted-foreground/40">
                {stamp}
              </span>
            </ActionTooltip>
          );
        },
      },
    ],
    [copiedId, copyId, openReceipt, receiptBusyId, t, labels, locale],
  );

  if (!token) return null;

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <PageHeader icon={ArrowLeftRight} title={t('title')} subtitle={t('subtitle')} />

      {error ? (
        <Alert tone="error">
          {error}
        </Alert>
      ) : null}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <SummaryTile label={t('tileCount')} value={total.toLocaleString('en-US')} />
        <SummaryTile label={t('tileCollected')} value={formatLbp(totals.collected, locale)} />
        <SummaryTile
          label={t('tileByMethod')}
          value={`${totals.cash} / ${totals.whish} / ${totals.collector}`}
          hint={t('tileByMethodHint')}
        />
        <SummaryTile
          label={t('tileAwaiting')}
          value={totals.awaiting.toLocaleString('en-US')}
          tone={totals.awaiting > 0 ? 'warning' : undefined}
        />
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="border-b pb-4">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <CardTitle className="flex items-center gap-2 text-base font-bold">
              <ArrowLeftRight className="size-5 text-primary" aria-hidden />
              {t('cardTitle')}
            </CardTitle>

            {/*
              The method filter, as the shared segmented control rather than a
              hand-rolled tab row.

              The row it replaces was 26px tall — `px-3 py-1` on 12px text —
              which is half the 48px a finger needs, on a screen a collector
              uses standing up. `SegmentedControl` carries `coarse:min-h-touch`
              and the app's one selected-segment treatment, so this stops being
              a fourth thing that looks almost like the other three.
            */}
            <SegmentedControl
              aria-label={t('filterAria')}
              value={method}
              size="sm"
              fullWidth={false}
              options={methodTabs.map((tab) => ({
                value: tab.id,
                label: tab.label,
                icon: tab.icon,
              }))}
              /*
                Narrowing to one method returns to the first page, here rather
                than in an effect watching `method`: two state updates in one
                render make one query key and one request, where the effect
                made two — the first at an offset that no longer existed.
              */
              onChange={(next) => {
                setMethod(next);
                setPagination((previous) =>
                  previous.pageIndex === 0 ? previous : { ...previous, pageIndex: 0 },
                );
              }}
            />
          </div>
        </CardHeader>

        <CardContent className="p-6">
          <DataTable
            columns={columns}
            data={items}
            labels={tableLabels}
            columnStorageKey="payments"
            getRowId={(row) => row.id}
            loading={paymentsQuery.loading}
            error={paymentsQuery.error}
            onRetry={paymentsQuery.refetch}
            emptyIcon={<ArrowLeftRight className="size-10 text-muted-foreground/60" />}
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

      {receipt ? (
        <PaymentReceipt
          open
          onOpenChange={(next) => {
            if (!next) setReceipt(null);
          }}
          tenant={tenant}
          citizen={receipt.citizen}
          payment={receipt.payment}
          receivedAmount={receipt.received}
          municipalityName={municipalityName}
          governorate={settings?.governorate}
          district={settings?.district}
          contactPhone={settings?.contactPhone}
          officeWhatsapp={settings?.whatsappNumber}
        />
      ) : null}
    </div>
  );
}

/** A compact figure above the table — no icon chip, so the table stays the page. */
function SummaryTile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'warning';
}) {
  return (
    <Card className={cn(tone === 'warning' && 'border-warning/50 ring-1 ring-warning/20')}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-xl font-bold tabular-nums">{value}</p>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}
