'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { getLabels } from '@mechanization/shared-schemas';
import { logApiError, reversePaymentTransaction, type PaymentLedgerEntry } from '@/lib/api-client';
import { REVERSAL_REASON_MAX, receiptsReadAgain, reversalFailure, reversalReasonValid } from '@/lib/bill-receipts';
import { formatMoney } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Money } from '@/components/ui/money';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * «عكس الوصل» — the manager reverses one receipt on a bill, with a written
 * reason (`POST fees/transactions/:id/reverse`).
 *
 * The ledger is append-only: the receipt stays, an opposing row is added
 * beside it, and the amount is owed on the bill again. Once the treasury is
 * live the money is paid back out of a wallet (docs/finance.md §3.4), and the
 * copy says which: the one the payment went into — a collector's custody only
 * while it still holds the money, otherwise the safe — or, for a payment taken
 * before go-live, the safe or the Whish account by its method. Before go-live
 * no wallet moves.
 *
 * The reason is required and Confirm waits for one the server's own schema
 * accepts, so the refusals left to show are the server's: a wallet that cannot
 * cover the refund (`TREASURY_INSUFFICIENT_FUNDS`), shown beside the action in
 * the page's language with the dialog kept open. One refusal is not a failure:
 * `TRANSACTION_ALREADY_REVERSED` after a press whose answer was lost says the
 * reversal exists, so the dialog says so and closes. The receipts are re-read
 * after every failure, so the list shows what is true now, and the press is
 * judged with them only when that read answered (`receiptsReadAgain`,
 * `reversalFailure`): each outcome has its own words, and none says the
 * receipts were read again when they could not be.
 *
 * Confirm is off, with a line saying why, once the list shows the receipt
 * reversed or the bill shows a claim under review (`claimUnderReview`): the
 * dialog stays open on a re-read rather than vanishing under the reader.
 *
 * `destructive={false}` (DES-4): nothing is lost — both rows stay on the
 * record. It cannot be undone, and the copy says so (DES-2).
 */
export function ReverseReceiptDialog({
  tenant,
  token,
  locale,
  citizenId,
  paymentId,
  entry,
  claimUnderReview,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  citizenId: string;
  paymentId: string;
  /**
   * The receipt to reverse, as the list reads it now — never a reversal; once
   * a re-read shows it reversed, Confirm is off.
   */
  entry: PaymentLedgerEntry;
  /** The bill now carries a transfer its citizen reported, waiting for a clerk: no reversal until it is judged. */
  claimUnderReview: boolean;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('billReceipts.dialog');
  const queryClient = useQueryClient();
  const toast = useToast();
  const labels = getLabels(locale);
  const [reason, setReason] = useState('');
  // STA-4: a second press lands before `ConfirmDialog` re-renders as busy.
  const inFlight = useRef(false);

  const receiptsKey = ['payment-transactions', tenant, paymentId] as const;

  /** The bill and the wallets move with a reversal; neither is needed to judge the press. */
  const refreshAround = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant, citizenId] });
    void queryClient.invalidateQueries({ queryKey: ['treasury', tenant] });
  };

  /**
   * The receipts read again after a press made at `pressedAt` — undefined when
   * that read did not answer, though the list on screen stays (`receiptsReadAgain`).
   */
  const rereadReceipts = async (pressedAt: number): Promise<PaymentLedgerEntry[] | undefined> => {
    await queryClient.invalidateQueries({ queryKey: receiptsKey });
    return receiptsReadAgain(queryClient.getQueryState<{ items: PaymentLedgerEntry[] }>(receiptsKey), pressedAt);
  };

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    const pressedAt = Date.now();
    try {
      const reversed = await reversePaymentTransaction(tenant, token, entry.id, { note: reason.trim() });
      refreshAround();
      await rereadReceipts(pressedAt);
      toast.success(t('success', { number: entry.receiptNumber }), {
        description: t('successBody', {
          reversal: reversed.receiptNumber,
          remaining: formatMoney(reversed.remaining, entry.currency, locale),
        }),
      });
      onDone();
    } catch (caught) {
      logApiError(caught);
      // A refusal may mean the receipts moved since they were read, and a press with no answer may have been recorded.
      refreshAround();
      const outcome = reversalFailure(caught, await rereadReceipts(pressedAt), entry.id);
      if (outcome === 'already-reversed') {
        toast.warning(t('alreadyReversed', { number: entry.receiptNumber }), {
          description: t('alreadyReversedBody'),
        });
        onDone();
        return;
      }
      if (outcome === 'went-through') {
        // The reversal is on record; only its answer was lost, so no reversal number or balance to quote.
        toast.success(t('success', { number: entry.receiptNumber }), { description: t('wentThroughBody') });
        onDone();
        return;
      }
      // `ConfirmDialog` shows a thrown error's message beside the action and keeps the dialog open.
      if (outcome === 'in-doubt') throw new Error(t('inDoubt'));
      if (outcome === 'unread') throw new Error(t('unread'));
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
      title={t('title', { number: entry.receiptNumber })}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      confirmDisabled={entry.reversed || claimUnderReview || !reversalReasonValid(reason)}
      onConfirm={confirm}
    >
      <p className="text-sm text-muted-foreground">{t('refund')}</p>

      <SummaryList className="rounded-md border bg-muted/20 px-3">
        <SummaryRow label={t('amount')}>
          <Money amount={entry.amount} currency={entry.currency} locale={locale} exact />
        </SummaryRow>
        <SummaryRow label={t('paidOn')}>
          <span className="tabular-nums">{formatDateTime(entry.occurredAt)}</span>
        </SummaryRow>
        <SummaryRow label={t('method')}>{labels.paymentMethod[entry.method] ?? entry.method}</SummaryRow>
        {entry.recordedBy ? <SummaryRow label={t('recordedBy')}>{entry.recordedBy}</SummaryRow> : null}
      </SummaryList>

      {entry.reversed || claimUnderReview ? (
        <p role="status" className="text-sm text-warning">
          {entry.reversed ? t('nowReversed') : t('nowUnderReview')}
        </p>
      ) : (
        <Field htmlFor="reverse-receipt-reason" label={t('reason')} required>
          <Textarea
            id="reverse-receipt-reason"
            rows={2}
            maxLength={REVERSAL_REASON_MAX}
            value={reason}
            placeholder={t('reasonPlaceholder')}
            onChange={(event) => setReason(event.target.value)}
          />
        </Field>
      )}
    </ConfirmDialog>
  );
}
