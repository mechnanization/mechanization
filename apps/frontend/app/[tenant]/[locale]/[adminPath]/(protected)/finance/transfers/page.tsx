'use client';

import { use, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, Ban, CheckCheck, Plus, Printer } from 'lucide-react';
import {
  TREASURY_ADMIN_ROLES,
  TREASURY_REVIEW_ROLES,
  TREASURY_WORK_ROLES,
} from '@mechanization/shared-schemas';
import {
  getTransfers,
  getTreasuryOverview,
  logApiError,
  reviewTransfer,
  voidTransfer,
  type TransferView,
} from '@/lib/api-client';
import { formatDate } from '@/lib/dates';
import { hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { useStaffSession } from '@/lib/use-staff-session';
import { useTableLabels } from '@/lib/use-table-labels';
import { cn } from '@/lib/utils';
import { TreasuryAmount } from '@/components/admin/finance/treasury-amount';
import { Alert } from '@/components/ui/alert';
import { BackLink } from '@/components/ui/back-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DataTable } from '@/components/ui/data-table';
import { Field } from '@/components/ui/field';
import { FilterSelect } from '@/components/ui/filter-controls';
import { PageHeader } from '@/components/ui/page-header';
import { StatItem, StatStrip } from '@/components/ui/stat-strip';
import { ErrorState } from '@/components/ui/states';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';

const PAGE_SIZE = 50;

type KindFilter = '' | 'HANDOVER' | 'SAME_CURRENCY' | 'EXCHANGE';
type ReviewFilter = '' | 'PENDING' | 'REVIEWED';

/**
 * «المناقلات والمصارفة» — every move between the municipality's own wallets:
 * collectors' handovers, internal transfers, and exchanges.
 *
 * The auditor's queue lives here too. An exchange whose rate strays beyond the
 * tolerance, that is large, or that had no official rate to compare with was
 * booked at once — counter work is never frozen — and waits with an amber
 * «بانتظار المراجعة» until an auditor or the manager clears it (§6.3). The
 * count of what waits is over the whole register, so it is not lost to a filter.
 *
 * Guarded by its own nav row, `TREASURY_READ_ROLES`; recording, reviewing and
 * cancelling are narrower and are checked here and by `TransfersController`.
 */
export default function TransfersPage({
  params,
}: {
  params: Promise<{ tenant: string; locale: string; adminPath: string }>;
}) {
  const { tenant, locale, adminPath } = use(params);
  const base = `/${tenant}/${locale}/${adminPath}`;
  const t = useTranslations('finance.transfers');
  const queryClient = useQueryClient();
  const { token, user } = useStaffSession(tenant, base);

  const canRecord = user ? hasRole(TREASURY_WORK_ROLES, user.role) : false;
  const canReview = user ? hasRole(TREASURY_REVIEW_ROLES, user.role) : false;
  const canVoid = user ? hasRole(TREASURY_ADMIN_ROLES, user.role) : false;

  const [kind, setKind] = useState<KindFilter>('');
  const [review, setReview] = useState<ReviewFilter>('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [reviewing, setReviewing] = useState<TransferView | null>(null);
  const [voiding, setVoiding] = useState<TransferView | null>(null);

  const overview = useStaffQuery({
    queryKey: ['treasury', tenant, 'overview'],
    queryFn: (accessToken, signal) => getTreasuryOverview(tenant, accessToken, undefined, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });

  const list = useStaffQuery({
    queryKey: ['treasury', tenant, 'transfers', kind, review, includeVoid],
    queryFn: (accessToken, signal) =>
      getTransfers(
        tenant,
        accessToken,
        { kind: kind || undefined, review: review || undefined, includeVoid, pageSize: PAGE_SIZE },
        signal,
      ),
    tenant,
    base,
    token,
    keepPrevious: true,
    errorMessage: t('loadError'),
  });

  const tableLabels = useTableLabels({ empty: t('empty'), emptyHint: t('emptyHint') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });

  const columns = useMemo<ColumnDef<TransferView>[]>(
    () => [
      {
        id: 'transfer',
        header: t('columns.transfer'),
        meta: { mobile: 'primary' },
        cell: ({ row }) => {
          const transfer = row.original;
          return (
            <div className="min-w-0 space-y-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* A document number is a code: `font-mono`, Latin, left to right (BAN-9, RTL-2). */}
                <span dir="ltr" className="font-mono text-xs font-medium">
                  {transfer.transferNumber}
                </span>
                <Badge variant="soft-default">{t(`kinds.${transfer.kind}`)}</Badge>
                {transfer.status === 'VOID' ? <Badge variant="soft-muted">{t('cancelled')}</Badge> : null}
                {transfer.review && !transfer.review.reviewedAt ? (
                  <Badge variant="soft-warning">{t('pendingReview')}</Badge>
                ) : null}
                {transfer.review?.reviewedAt ? <Badge variant="soft-success">{t('reviewed')}</Badge> : null}
              </div>
              <p className="truncate text-xs text-muted-foreground">{transfer.description}</p>
            </div>
          );
        },
      },
      {
        id: 'route',
        header: t('columns.route'),
        cell: ({ row }) => (
          <div className="min-w-0 text-sm">
            <p className="truncate">{row.original.from.name}</p>
            <p className="truncate text-muted-foreground">
              {/* «إلى»: the direction is a word, so it reads the same in both scripts (RTL-3). */}
              {t('toWallet', { name: row.original.to.name })}
            </p>
          </div>
        ),
      },
      {
        id: 'date',
        header: t('columns.date'),
        cell: ({ row }) => <span className="tabular-nums">{formatDate(row.original.occurredAt)}</span>,
      },
      {
        id: 'amount',
        header: t('columns.amount'),
        meta: { align: 'end' },
        cell: ({ row }) => {
          const transfer = row.original;
          const struck = transfer.status === 'VOID' && 'text-muted-foreground line-through';
          return (
            <div className="space-y-0.5 text-end">
              <TreasuryAmount
                amount={transfer.amount}
                currency={transfer.from.currency}
                locale={locale}
                className={cn('font-semibold', struck)}
              />
              {transfer.kind === 'EXCHANGE' ? (
                <p className="text-xs text-muted-foreground">
                  <TreasuryAmount amount={transfer.receivedAmount} currency={transfer.to.currency} locale={locale} className={cn(struck)} />
                </p>
              ) : null}
              {transfer.fee ? (
                <p className="text-xs text-muted-foreground">
                  {t('feeLine')}{' '}
                  <TreasuryAmount amount={transfer.fee.amount} currency={transfer.from.currency} locale={locale} />
                </p>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: t('columns.actions'),
        enableSorting: false,
        meta: { align: 'end', mobile: 'actions' },
        cell: ({ row }) => {
          const transfer = row.original;
          return (
            <div className="flex items-center justify-end gap-1 max-sm:w-full max-sm:flex-col">
              <Button asChild variant="ghost" size="sm" className="max-sm:w-full">
                <Link
                  href={`${base}/finance/transfers/${transfer.id}/print?print=1`}
                  aria-label={t('printFor', { number: transfer.transferNumber })}
                >
                  <Printer className="size-4" aria-hidden />
                  {t('print')}
                </Link>
              </Button>
              {canReview && transfer.review && !transfer.review.reviewedAt ? (
                <Button variant="ghost" size="sm" className="max-sm:w-full" onClick={() => setReviewing(transfer)}>
                  <CheckCheck className="size-4" aria-hidden />
                  {t('review')}
                </Button>
              ) : null}
              {canVoid && transfer.status === 'RECORDED' ? (
                <Button variant="ghost" size="sm" className="max-sm:w-full" onClick={() => setVoiding(transfer)}>
                  <Ban className="size-4" aria-hidden />
                  {t('void')}
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [t, locale, base, canReview, canVoid],
  );

  return (
    <div className="w-full space-y-6 px-4 py-6 sm:px-6 lg:px-8">
      <BackLink fallbackHref={`${base}/finance`} label={t('back')} />

      <PageHeader
        icon={ArrowRightLeft}
        title={t('title')}
        actions={
          canRecord && overview.data?.active ? (
            <Button asChild>
              <Link href={`${base}/finance/transfers/new`}>
                <Plus className="size-4" aria-hidden />
                {t('record')}
              </Link>
            </Button>
          ) : undefined
        }
      />

      {overview.data && !overview.data.active ? (
        <Alert variant="warning" title={t('notActiveTitle')}>
          {t('notActiveBody')}
        </Alert>
      ) : null}

      {list.error ? (
        <Card>
          <CardContent className="p-0">
            <ErrorState title={list.error} onRetry={list.refetch} />
          </CardContent>
        </Card>
      ) : (
        <>
          <StatStrip>
            <StatItem label={t('count')} value={String(list.data?.total ?? 0)} />
            <StatItem
              label={t('pendingCount')}
              value={String(list.data?.pendingReview ?? 0)}
              className={cn((list.data?.pendingReview ?? 0) > 0 && 'text-warning')}
            />
          </StatStrip>

          <DataTable
            columns={columns}
            data={list.data?.transfers ?? []}
            labels={tableLabels}
            getRowId={(transfer) => transfer.id}
            searchable={false}
            sortable={false}
            paginated={false}
            loading={list.loading}
            error={null}
            filterBar={
              <div className="flex flex-wrap items-center gap-2">
                <FilterSelect
                  label={t('filters.kind')}
                  value={kind}
                  onChange={(value) => setKind(value as KindFilter)}
                  allLabel={t('filters.allKinds')}
                  options={(['HANDOVER', 'SAME_CURRENCY', 'EXCHANGE'] as const).map((value) => ({
                    value,
                    label: t(`kinds.${value}`),
                  }))}
                />
                <FilterSelect
                  label={t('filters.review')}
                  value={review}
                  onChange={(value) => setReview(value as ReviewFilter)}
                  allLabel={t('filters.anyReview')}
                  options={[
                    { value: 'PENDING', label: t('pendingReview') },
                    { value: 'REVIEWED', label: t('reviewed') },
                  ]}
                />
                <FilterSelect
                  label={t('filters.status')}
                  value={includeVoid ? 'all' : ''}
                  onChange={(value) => setIncludeVoid(value === 'all')}
                  allLabel={t('filters.recordedOnly')}
                  options={[{ value: 'all', label: t('filters.includeCancelled') }]}
                />
              </div>
            }
          />

          {(list.data?.total ?? 0) > PAGE_SIZE ? (
            <Alert variant="info" title={t('truncatedTitle')}>
              {t('truncated', { shown: PAGE_SIZE, total: list.data?.total ?? 0 })}
            </Alert>
          ) : null}
        </>
      )}

      {reviewing && token ? (
        <ReviewTransferDialog
          tenant={tenant}
          token={token}
          locale={locale}
          baseCurrency={overview.data?.rate.baseCurrency ?? 'LBP'}
          transfer={reviewing}
          onDone={() => {
            setReviewing(null);
            refresh();
          }}
          onCancel={() => setReviewing(null)}
        />
      ) : null}

      {voiding && token ? (
        <VoidTransferDialog
          tenant={tenant}
          token={token}
          transfer={voiding}
          onDone={() => {
            setVoiding(null);
            refresh();
          }}
          onCancel={() => setVoiding(null)}
        />
      ) : null}
    </div>
  );
}

/**
 * «اعتماد المراجعة» — what the auditor looks at, then a stamp.
 *
 * The facts the flag was raised on are in the dialog, so nobody clears a flag
 * without seeing why it was raised: the rate used beside the official one, the
 * reason given, the changer. Nothing about the money changes; the copy says so
 * (DES-4), so this is not a destructive confirm.
 */
function ReviewTransferDialog({
  tenant,
  token,
  locale,
  baseCurrency,
  transfer,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  /** The currency a rate is counted in: base per one unit of the other side. */
  baseCurrency: string;
  transfer: TransferView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.reviewDialog');
  const [note, setNote] = useState('');
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      await reviewTransfer(tenant, token, { id: transfer.id, note: note.trim() || undefined });
      onDone();
    } catch (caught) {
      logApiError(caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('title', { number: transfer.transferNumber })}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <SummaryList className="rounded-md border px-3">
        <SummaryRow label={t('sold')}>
          <TreasuryAmount amount={transfer.amount} currency={transfer.from.currency} locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('received')}>
          <TreasuryAmount amount={transfer.receivedAmount} currency={transfer.to.currency} locale={locale} />
        </SummaryRow>
        <SummaryRow label={t('rate')}>
          {transfer.exchangeRate !== null ? (
            <TreasuryAmount amount={transfer.exchangeRate} currency={baseCurrency} locale={locale} />
          ) : (
            '—'
          )}
        </SummaryRow>
        <SummaryRow label={t('official')}>
          {transfer.officialExchangeRate !== null ? (
            <TreasuryAmount amount={transfer.officialExchangeRate} currency={baseCurrency} locale={locale} />
          ) : (
            t('noOfficial')
          )}
        </SummaryRow>
        {transfer.adjustmentReason ? <SummaryRow label={t('reason')}>{transfer.adjustmentReason}</SummaryRow> : null}
        {transfer.moneyChangerName ? <SummaryRow label={t('changer')}>{transfer.moneyChangerName}</SummaryRow> : null}
      </SummaryList>
      <Field htmlFor="review-note" label={t('note')} optionalLabel={t('optional')}>
        <Textarea
          id="review-note"
          rows={2}
          maxLength={500}
          value={note}
          placeholder={t('notePlaceholder')}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
    </ConfirmDialog>
  );
}

/**
 * «إلغاء سند المناقلة» — the manager's cancellation. Not destructive (DES-4):
 * nothing is lost, the money goes back, and the fee with it.
 */
function VoidTransferDialog({
  tenant,
  token,
  transfer,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  transfer: TransferView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.voidDialog');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    if (reason.trim().length < 5) {
      setError(t('reasonTooShort'));
      throw new Error(t('reasonTooShort'));
    }
    inFlight.current = true;
    try {
      await voidTransfer(tenant, token, { id: transfer.id, reason: reason.trim() });
      onDone();
    } catch (caught) {
      logApiError(caught);
      throw caught;
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('title', { number: transfer.transferNumber })}
      description={transfer.fee ? t('bodyWithFee', { number: transfer.fee.voucherNumber }) : t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <Field htmlFor="void-reason" label={t('reason')} error={error ?? undefined} required>
        <Textarea
          id="void-reason"
          rows={2}
          maxLength={500}
          value={reason}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => {
            setReason(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </ConfirmDialog>
  );
}
