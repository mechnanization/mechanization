'use client';

import { use, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Megaphone, Pause, Play } from 'lucide-react';
import {
  ADJUSTMENT_REASON_MIN,
  BILL_CANCEL_ROLES,
  FEE_ADMIN_ROLES,
  getLabels,
  type FeeNoticePeriodSummary,
} from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  cancelFeeNotice,
  getFeeNoticePeriods,
  getFeeNotices,
  logApiError,
  setNoticeActive,
  type FeeNoticeCancelResult,
  type FeeNoticeSummary,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { HeaderBackLink } from '@/components/admin/header-back-link';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { Label } from '@/components/ui/label';
import { Money } from '@/components/ui/money';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/** How many bills the outcome lists by number before it says «and N more». */
const SKIPPED_SHOWN = 20;

/**
 * A notice's title inside a sentence, isolated (FSI … PDI) — `<bdi>` for a plain string, since
 * `ConfirmDialog`'s title and a toast take one (RTL-2). Without it an Arabic title in an English
 * sentence pulls the «”: 4012» after it into its own run, and the count prints before the title.
 */
function isolate(text: string): string {
  return `⁨${text}⁩`;
}

/**
 * «إشعارات الرسوم» — every fee notice the municipality has issued, and what the
 * manager may do to one (decisions D6 and D12, docs/fees-system-rearchitecture-specification.md).
 *
 * «إيقاف الإشعار» stops a recurring notice and cancels nothing: the bills it has
 * raised stay owed, because a fee that ends from next month has not been waived
 * for the months it ran. «إلغاء الإشعار» withdraws bills, for the periods the
 * manager ticks — each period with what it would cancel and what it would
 * leave, read before the press — as «إلغاء الفاتورة» would one by one; it stops
 * the notice too. The reason is required as for one bill, what was left is
 * listed after, and it cannot be undone: a cancelled bill stays on the record,
 * cancelled.
 *
 * Read by everyone who reads the ledger (`GET fees/notices`, `FEE_READ_ROLES`,
 * the `/fees` nav row). Stop and resume are `FEE_ADMIN_ROLES`
 * (`PATCH fees/notices/:id/active`); the cancel and its periods are
 * `BILL_CANCEL_ROLES` (`POST fees/notices/:id/cancel`, `GET …/periods`). The
 * server enforces both; the roles here only hide the buttons.
 */
export default function FeeNoticesPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('fees.notices');
  const labels = getLabels(locale);
  const queryClient = useQueryClient();
  const toast = useToast();
  const { token, user } = useStaffSession(tenant, base);
  const canCancel = user ? hasRole(BILL_CANCEL_ROLES, user.role) : false;
  const canStop = user ? hasRole(FEE_ADMIN_ROLES, user.role) : false;

  const [cancelling, setCancelling] = useState<FeeNoticeSummary | null>(null);
  const [reason, setReason] = useState('');
  /** The periods ticked; null until the notice's periods have been read and the latest chosen. */
  const [periodKeys, setPeriodKeys] = useState<string[] | null>(null);
  const [toggling, setToggling] = useState<FeeNoticeSummary | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; result: FeeNoticeCancelResult } | null>(null);
  const inFlight = useRef(false);

  const query = useStaffQuery({
    queryKey: ['fee-notices', tenant],
    queryFn: (accessToken, signal) => getFeeNotices(tenant, accessToken, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const notices = useMemo(() => query.data?.items ?? [], [query.data]);

  const open = (notice: FeeNoticeSummary) => {
    setReason('');
    setPeriodKeys(null);
    setCancelling(notice);
  };

  /*
    Thrown from `onConfirm` so the dialog shows the server's refusal in place
    (PRIM-16); in flight per press, so a second press cannot send it twice
    (STA-4). A second withdrawal of the same periods cancels nothing more.
  */
  const confirm = async (): Promise<void> => {
    if (!token || !cancelling || !periodKeys?.length || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await cancelFeeNotice(tenant, token, cancelling.id, { reason: reason.trim(), periodKeys });
      setOutcome({ title: cancelling.title, result });
      setCancelling(null);
      toast.success(t('cancelled', { count: result.cancelled, title: isolate(cancelling.title) }));
      // The notices, their periods, and the fees screen's bills and figures, which the cancellation moved.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fee-notices', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['fee-notice-periods', tenant, cancelling.id] }),
        queryClient.invalidateQueries({ queryKey: ['fees-payments', tenant] }),
        queryClient.invalidateQueries({ queryKey: ['fees-context', tenant] }),
      ]);
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('cancelFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  /** «إيقاف الإشعار» / «استئناف الإشعار»: the notice's state only, never a bill. */
  const toggle = async (): Promise<void> => {
    if (!token || !toggling || inFlight.current) return;
    inFlight.current = true;
    try {
      const next = !toggling.isActive;
      await setNoticeActive(tenant, token, toggling.id, next);
      toast.success(t(next ? 'resumedToast' : 'stoppedToast', { title: isolate(toggling.title) }));
      setToggling(null);
      await queryClient.invalidateQueries({ queryKey: ['fee-notices', tenant] });
    } catch (caught) {
      logApiError(caught);
      throw new Error(caught instanceof ApiRequestError ? caught.message : t('toggleFailed'));
    } finally {
      inFlight.current = false;
    }
  };

  const tableLabels = useTableLabels({ empty: t('empty') });

  const columns = useMemo<ColumnDef<FeeNoticeSummary>[]>(
    () => [
      {
        id: 'title',
        header: t('columns.title'),
        meta: { mobile: 'primary', cellClassName: 'whitespace-normal' },
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5">
            <p className="font-medium">{row.original.title}</p>
            <p className="text-xs text-muted-foreground">{labels.feeBasis[row.original.basis]}</p>
          </div>
        ),
      },
      {
        id: 'frequency',
        header: t('columns.frequency'),
        cell: ({ row }) => labels.feeFrequency[row.original.frequency as keyof typeof labels.feeFrequency] ?? row.original.frequency,
      },
      {
        id: 'issued',
        header: t('columns.issued'),
        meta: { align: 'end' as const },
        cell: ({ row }) => <span className="tabular-nums">{row.original.issuedCount.toLocaleString('en-US')}</span>,
      },
      {
        id: 'status',
        header: t('columns.status'),
        // The word carries the state; the colour only repeats it (COL-3).
        cell: ({ row }) =>
          row.original.isActive ? (
            <Badge variant="soft-success">{t('active')}</Badge>
          ) : (
            <Badge variant="soft-muted">{t('stopped')}</Badge>
          ),
      },
      {
        id: 'created',
        header: t('columns.created'),
        cell: ({ row }) => formatDate(row.original.createdAt),
      },
      ...(canCancel || canStop
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              // `!w-auto` on each button: the phone card's footer sizes every button in it to a
              // 36px square, and its descendant selector outranks a plain width (see finding-parts.tsx).
              cell: ({ row }: { row: { original: FeeNoticeSummary } }) => (
                <div className="flex flex-wrap items-center justify-end gap-1">
                  {/* Only a recurring notice has anything to stop: a one-off was billed once and is done. */}
                  {canStop && row.original.frequency !== 'ONCE' ? (
                    <Button variant="ghost" size="sm" className="!w-auto" onClick={() => setToggling(row.original)}>
                      {row.original.isActive ? (
                        <Pause className="size-4" aria-hidden />
                      ) : (
                        <Play className="size-4" aria-hidden />
                      )}
                      {row.original.isActive ? t('stop') : t('resume')}
                    </Button>
                  ) : null}
                  {canCancel ? (
                    <Button variant="ghost" size="sm" className="!w-auto text-destructive" onClick={() => open(row.original)}>
                      <Ban className="size-4" aria-hidden />
                      {t('cancel')}
                    </Button>
                  ) : null}
                </div>
              ),
            } satisfies ColumnDef<FeeNoticeSummary>,
          ]
        : []),
    ],
    [t, labels, canCancel, canStop],
  );

  const skipped = outcome?.result.skipped ?? [];

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />

      <PageHeader icon={Megaphone} title={t('title')} />

      {outcome ? (
        <Alert
          variant={skipped.length > 0 ? 'warning' : 'success'}
          live="status"
          title={t('outcomeTitle', { title: isolate(outcome.title), count: outcome.result.cancelled })}
        >
          {skipped.length > 0 ? (
            <>
              <p>{t('outcomeSkipped', { count: skipped.length })}</p>
              <ul className="mt-1 list-disc ps-5">
                {skipped.slice(0, SKIPPED_SHOWN).map((bill) => (
                  <li key={bill.paymentId}>
                    <span className="font-mono">{bill.invoiceNumber ?? '—'}</span> — {t(`reasons.${bill.reason}`)}
                  </li>
                ))}
              </ul>
              {skipped.length > SKIPPED_SHOWN ? (
                <p className="mt-1">{t('outcomeMore', { count: skipped.length - SKIPPED_SHOWN })}</p>
              ) : null}
            </>
          ) : (
            <p>{t('outcomeAll')}</p>
          )}
        </Alert>
      ) : null}

      {/* `DataTable` draws its own frame; a card around it would be the double frame BAN-4 refuses. */}
      <DataTable
        columns={columns}
        data={notices}
        labels={tableLabels}
        getRowId={(notice) => notice.id}
        searchable={false}
        sortable={false}
        paginated={false}
        loading={query.loading}
        error={query.error}
        onRetry={query.refetch}
      />

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(next) => {
          if (!next) setCancelling(null);
        }}
        destructive
        title={t('confirmTitle', { title: isolate(cancelling?.title ?? '') })}
        description={t('confirmBody')}
        confirmLabel={t('confirmAction')}
        cancelLabel={t('keep')}
        busyLabel={t('busy')}
        confirmDisabled={reason.trim().length < ADJUSTMENT_REASON_MIN || !periodKeys?.length}
        onConfirm={confirm}
      >
        {cancelling ? (
          <NoticePeriodsPicker
            tenant={tenant}
            base={base}
            token={token}
            locale={locale}
            noticeId={cancelling.id}
            chosen={periodKeys}
            onChange={setPeriodKeys}
          />
        ) : null}
        <Field label={t('reason')} htmlFor="notice-cancel-reason" required>
          <Textarea
            id="notice-cancel-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>

      <ConfirmDialog
        open={toggling !== null}
        onOpenChange={(next) => {
          if (!next) setToggling(null);
        }}
        title={t(toggling?.isActive ? 'stopTitle' : 'resumeTitle', { title: isolate(toggling?.title ?? '') })}
        description={t(toggling?.isActive ? 'stopBody' : 'resumeBody')}
        confirmLabel={t(toggling?.isActive ? 'stopAction' : 'resumeAction')}
        cancelLabel={t('keep')}
        busyLabel={t('toggling')}
        onConfirm={toggle}
      />
    </div>
  );
}

/**
 * The notice's periods in the cancel dialog, newest first, each with what the
 * cancel would cancel (and for how much) and what it would leave and why —
 * the server's own count (`GET fees/notices/:id/periods`), by the rule the
 * cancel applies. The latest period with something to cancel is ticked once
 * they arrive; a period with nothing to cancel cannot be ticked.
 */
function NoticePeriodsPicker({
  tenant,
  base,
  token,
  locale,
  noticeId,
  chosen,
  onChange,
}: {
  tenant: string;
  base: string;
  token: string | null;
  locale: string;
  noticeId: string;
  chosen: string[] | null;
  onChange: (next: string[]) => void;
}) {
  const t = useTranslations('fees.notices');
  const tCommon = useTranslations('common');
  const periods = useStaffQuery({
    queryKey: ['fee-notice-periods', tenant, noticeId],
    queryFn: (accessToken, signal) => getFeeNoticePeriods(tenant, accessToken, noticeId, signal),
    tenant,
    base,
    token,
    errorMessage: t('periodsError'),
  });
  const items: FeeNoticePeriodSummary[] = periods.data?.items ?? [];

  useEffect(() => {
    if (chosen !== null || !periods.data) return;
    const latest = periods.data.items.find((row) => row.cancellable > 0);
    onChange(latest ? [latest.periodKey] : []);
  }, [chosen, periods.data, onChange]);

  if (periods.error) {
    return <ErrorState compact title={periods.error} onRetry={periods.refetch} retryLabel={tCommon('retry')} />;
  }
  if (periods.loading) return <LoadingState compact label={t('periodsLoading')} />;
  if (items.length === 0) return <EmptyState compact title={t('noPeriods')} />;

  const ticked = chosen ?? [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{t('periods')}</legend>
      <ul className="divide-y rounded-lg border">
        {items.map((row) => {
          const id = `notice-period-${row.periodKey}`;
          const left = row.withPayments + row.underReview + row.alreadyCancelled;
          return (
            <li key={row.periodKey} className="flex items-start gap-3 p-3">
              <Checkbox
                id={id}
                checked={ticked.includes(row.periodKey)}
                disabled={row.cancellable === 0}
                onCheckedChange={(next) =>
                  onChange(
                    next === true ? [...ticked, row.periodKey] : ticked.filter((periodKey) => periodKey !== row.periodKey),
                  )
                }
              />
              <div className="min-w-0 space-y-1">
                <Label htmlFor={id}>
                  {row.periodKey === 'ONCE' ? t('once') : <bdi dir="ltr">{row.periodKey}</bdi>}
                </Label>
                <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                  <span>{t('periodCancels', { count: row.cancellable })}</span>
                  {row.cancellable > 0 ? (
                    <Money amount={row.cancellableAmount} currency={row.currency} locale={locale} exact />
                  ) : null}
                </p>
                {left > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t('periodLeaves', {
                      withPayments: row.withPayments,
                      underReview: row.underReview,
                      alreadyCancelled: row.alreadyCancelled,
                    })}
                  </p>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
