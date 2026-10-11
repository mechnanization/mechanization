'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { getLabels } from '@mechanization/shared-schemas';
import {
  ApiRequestError,
  logApiError,
  reversePaymentTransaction,
  type PaymentLedgerEntry,
} from '@/lib/api-client';
import { REVERSAL_REASON_MAX, reversalReasonValid } from '@/lib/bill-receipts';
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
 * beside it, and the amount is owed on the bill again. The reason is required
 * and Confirm waits for one the server's own schema accepts, so the refusals
 * left to show are the server's: the receipt reversed by someone else first
 * (`TRANSACTION_ALREADY_REVERSED`), a citizen's claim under review on the bill
 * (`PAYMENT_CLAIM_UNDER_REVIEW`), a wallet that no longer holds the money
 * (`TREASURY_INSUFFICIENT_FUNDS`). `ConfirmDialog` shows each beside the
 * action, in the page's language, and keeps the dialog open; the receipts are
 * re-read behind it so the list shows what is true now.
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
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  locale: string;
  citizenId: string;
  paymentId: string;
  /** The receipt to reverse — never a reversal, never one already reversed (`mayReverseReceipt`). */
  entry: PaymentLedgerEntry;
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

  /** The bill, its receipts and the wallets all move with a reversal. */
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['payment-transactions', tenant, paymentId] }),
      queryClient.invalidateQueries({ queryKey: ['citizen-profile', tenant, citizenId] }),
      queryClient.invalidateQueries({ queryKey: ['treasury', tenant] }),
    ]);

  const confirm = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const reversed = await reversePaymentTransaction(tenant, token, entry.id, { note: reason.trim() });
      await refresh();
      toast.success(t('success', { number: entry.receiptNumber }), {
        description: t('successBody', {
          reversal: reversed.receiptNumber,
          remaining: formatMoney(reversed.remaining, entry.currency, locale),
        }),
      });
      onDone();
    } catch (caught) {
      logApiError(caught);
      // A refusal may mean the receipts moved since they were read: show what is true now.
      if (caught instanceof ApiRequestError) void refresh();
      // `ConfirmDialog` shows a thrown error's message (localised by its code) beside the action.
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
      confirmDisabled={!reversalReasonValid(reason)}
      onConfirm={confirm}
    >
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
    </ConfirmDialog>
  );
}
