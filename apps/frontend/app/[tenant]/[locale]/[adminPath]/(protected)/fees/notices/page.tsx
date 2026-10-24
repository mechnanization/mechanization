'use client';

import { use, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, Megaphone } from 'lucide-react';
import { ADJUSTMENT_REASON_MIN, BILL_CANCEL_ROLES, getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  cancelFeeNotice,
  getFeeNotices,
  logApiError,
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
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page-header';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * «إشعارات الرسوم» — every fee notice the municipality has issued, and the
 * manager's «إلغاء الإشعار» (decision D6, docs/fees-system-rearchitecture-specification.md).
 *
 * Withdrawing a notice cancels every one of its bills nothing has been paid on,
 * as «إلغاء الفاتورة» would one by one, leaves the rest as they are — money on
 * them, or a citizen's claim waiting — and stops the notice recurring. The
 * dialog says so before the press, the reason is required as for one bill, and
 * what was left is listed after it. It cannot be undone: a cancelled bill stays
 * on the record, cancelled.
 *
 * Read by everyone who reads the ledger (`GET fees/notices`, `FEE_READ_ROLES`,
 * the `/fees` nav row); the button is shown to `BILL_CANCEL_ROLES`, which
 * `POST fees/notices/:id/cancel` enforces.
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

  const [cancelling, setCancelling] = useState<FeeNoticeSummary | null>(null);
  const [reason, setReason] = useState('');
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
    setCancelling(notice);
  };

  /*
    Thrown from `onConfirm` so the dialog shows the server's refusal in place
    (PRIM-16); in flight per press, so a second press cannot send it twice
    (STA-4). A second withdrawal of the same notice cancels nothing more.
  */
  const confirm = async (): Promise<void> => {
    if (!token || !cancelling || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await cancelFeeNotice(tenant, token, cancelling.id, reason.trim());
      setOutcome({ title: cancelling.title, result });
      setCancelling(null);
      toast.success(t('cancelled', { count: result.cancelled, title: cancelling.title }));
      // The notices, and the fees screen's bills and figures, which the cancellation moved.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['fee-notices', tenant] }),
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
      ...(canCancel
        ? [
            {
              id: 'actions',
              header: t('columns.actions'),
              enableSorting: false,
              meta: { align: 'end' as const, mobile: 'actions' as const },
              cell: ({ row }: { row: { original: FeeNoticeSummary } }) => (
                <Button variant="ghost" size="sm" className="text-destructive" onClick={() => open(row.original)}>
                  <Ban className="size-4" aria-hidden />
                  {t('cancel')}
                </Button>
              ),
            } satisfies ColumnDef<FeeNoticeSummary>,
          ]
        : []),
    ],
    [t, labels, canCancel],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <HeaderBackLink fallbackHref={`${base}/fees`} label={t('back')} />

      <PageHeader icon={Megaphone} title={t('title')} />

      {outcome ? (
        <Alert
          variant={outcome.result.skipped.length > 0 ? 'warning' : 'success'}
          live="status"
          title={t('outcomeTitle', { title: outcome.title, count: outcome.result.cancelled })}
        >
          {outcome.result.skipped.length > 0 ? (
            <>
              <p>{t('outcomeSkipped', { count: outcome.result.skipped.length })}</p>
              <ul className="mt-1 list-disc ps-5">
                {outcome.result.skipped.map((bill) => (
                  <li key={bill.paymentId}>
                    <span className="font-mono">{bill.invoiceNumber ?? '—'}</span> — {t(`reasons.${bill.reason}`)}
                  </li>
                ))}
              </ul>
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
        title={t('confirmTitle', { title: cancelling?.title ?? '' })}
        description={t('confirmBody')}
        confirmLabel={t('confirmAction')}
        cancelLabel={t('keep')}
        busyLabel={t('busy')}
        confirmDisabled={reason.trim().length < ADJUSTMENT_REASON_MIN}
        onConfirm={confirm}
      >
        <Field label={t('reason')} htmlFor="notice-cancel-reason" required>
          <Textarea
            id="notice-cancel-reason"
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
