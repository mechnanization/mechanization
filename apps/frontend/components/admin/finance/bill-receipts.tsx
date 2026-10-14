'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ReceiptText, Undo2 } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import { getPaymentTransactions } from '@/lib/api-client';
import { claimUnderReview, mayReverseReceipt } from '@/lib/bill-receipts';
import { formatDateTime } from '@/lib/dates';
import { readView } from '@/lib/read-view';
import { PAYMENT_REVERSE_ROLES, hasRole } from '@/lib/staff-roles';
import { useStaffQuery } from '@/lib/use-staff-query';
import { RefreshFailedAlert } from '@/components/admin/refresh-failed-alert';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CellTag } from '@/components/ui/cell-tag';
import { Money } from '@/components/ui/money';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { ReverseReceiptDialog } from './reverse-receipt-dialog';

/**
 * «وصولات الفاتورة» — every movement on one bill, oldest first: each receipt,
 * and each opposing row that reversed one, struck through beside it.
 *
 * Reached from the bill's row on the citizen file: «تسجيل دفعة نقدية» while the
 * bill is owed, «وصولات الفاتورة» once it is paid in full (that page's `FeesPanel`).
 *
 * The manager (`PAYMENT_REVERSE_ROLES`) is offered «عكس الوصل» on a receipt that
 * still stands (`mayReverseReceipt`); everyone else reads the list. The role
 * check only hides the control — the route's `@Roles` is the enforcement. While
 * a transfer the citizen reported waits for a clerk (`claimUnderReview`) no
 * receipt is offered, and the manager is told why: a reversal then would erase
 * the claim, and this branch's server does not refuse it yet (PR #120 does).
 *
 * The list is drawn through `readView` (STA-1): a failed re-read keeps the
 * rows, and the reversal dialog open on one of them, with a
 * `RefreshFailedAlert` above. The dialog is given its receipt as the list reads
 * it now (by id), so a re-read that shows it reversed turns its Confirm off.
 */
export function BillReceipts({
  tenant,
  base,
  token,
  role,
  locale,
  citizenId,
  paymentId,
  paymentStatus,
}: {
  tenant: string;
  base: string;
  token: string | null;
  role: string | undefined;
  locale: string;
  citizenId: string;
  paymentId: string;
  /** The bill's status as the page read it: no reversal is offered while a reported transfer waits for a clerk. */
  paymentStatus: string;
}): React.JSX.Element {
  const t = useTranslations('billReceipts');
  const labels = getLabels(locale);
  const [reversingId, setReversingId] = useState<string | null>(null);

  const receipts = useStaffQuery({
    queryKey: ['payment-transactions', tenant, paymentId],
    queryFn: (tok, signal) => getPaymentTransactions(tenant, tok, paymentId, signal),
    tenant,
    base,
    token,
    errorMessage: t('loadError'),
  });
  const view = readView(receipts.data, receipts.error);
  const items = view.state === 'ready' ? view.data.items : [];
  const reversing = reversingId ? (items.find((entry) => entry.id === reversingId) ?? null) : null;
  const bill = { paymentStatus };
  const underReview = claimUnderReview(bill);
  /** The manager would be offered a receipt here, but for the claim: say why there is none. */
  const heldByClaim =
    underReview && hasRole(PAYMENT_REVERSE_ROLES, role) && items.some((entry) => !entry.isReversal && !entry.reversed);

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center gap-2 text-lg">
          <ReceiptText className="size-5" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {view.state === 'ready' && view.refreshFailed ? (
          <div className="p-4">
            <RefreshFailedAlert message={view.refreshFailed} onRetry={() => void receipts.refetch()} />
          </div>
        ) : null}

        {heldByClaim ? (
          <div className="p-4">
            <Alert variant="warning" title={t('claimTitle')}>
              {t('claimBody')}
            </Alert>
          </div>
        ) : null}

        {view.state === 'failed' ? (
          <ErrorState
            compact
            description={view.error}
            onRetry={() => void receipts.refetch()}
            retryLabel={t('retry')}
          />
        ) : view.state === 'loading' ? (
          <LoadingState compact label={t('loading')} />
        ) : items.length === 0 ? (
          <EmptyState compact icon={ReceiptText} title={t('emptyTitle')} description={t('emptyBody')} />
        ) : (
          <ul className="divide-y">
            {items.map((entry) => {
              const struck = entry.isReversal || entry.reversed;
              return (
                <li
                  key={entry.id}
                  className="flex flex-col gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
                >
                  <div className="min-w-0 space-y-1">
                    <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <bdi className={struck ? 'font-mono text-sm line-through' : 'font-mono text-sm'}>
                        {entry.receiptNumber}
                      </bdi>
                      {entry.isReversal ? <CellTag tone="warning">{t('reversal')}</CellTag> : null}
                      {entry.reversed ? <CellTag tone="destructive">{t('reversed')}</CellTag> : null}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      <span className="tabular-nums">{formatDateTime(entry.occurredAt)}</span>
                      {' · '}
                      {labels.paymentMethod[entry.method] ?? entry.method}
                      {entry.recordedBy ? ` · ${t('recordedBy', { name: entry.recordedBy })}` : ''}
                    </p>
                    {entry.note ? <p className="text-xs text-muted-foreground">{entry.note}</p> : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <Money
                      amount={entry.amount}
                      currency={entry.currency}
                      locale={locale}
                      exact
                      signed
                      className={struck ? 'text-sm font-semibold text-muted-foreground line-through' : 'text-sm font-semibold'}
                    />
                    {mayReverseReceipt(entry, role, bill) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        aria-label={t('reverseAria', { number: entry.receiptNumber })}
                        onClick={() => setReversingId(entry.id)}
                      >
                        <Undo2 className="size-3.5" aria-hidden />
                        {t('reverse')}
                      </Button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {reversing && token ? (
        <ReverseReceiptDialog
          tenant={tenant}
          token={token}
          locale={locale}
          citizenId={citizenId}
          paymentId={paymentId}
          entry={reversing}
          claimUnderReview={underReview}
          onDone={() => setReversingId(null)}
          onCancel={() => setReversingId(null)}
        />
      ) : null}
    </Card>
  );
}
