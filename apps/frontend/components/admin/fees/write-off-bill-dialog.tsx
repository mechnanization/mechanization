'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ADJUSTMENT_REASON_MIN, municipalToday, writeOffBillSchema } from '@mechanization/shared-schemas';
import { logApiError, writeOffBill } from '@/lib/api-client';
import { formatLbp } from '@/lib/currency';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

/**
 * «شطب» — the manager writes off what is left on a bill on a council decision
 * (0107, docs/old-debts-plan.md decision 10, docs/finance.md §3.8). Not
 * «إلغاء الفاتورة»: the debt was real, so what was paid stays paid and only the
 * rest is forgiven. The reason, the decision number and its date are required;
 * the reason as long as a cancellation's (`ADJUSTMENT_REASON_MIN`). The amount
 * is not typed: the server writes off what is left when it looks.
 *
 * A refusal is thrown on, so `ConfirmDialog` shows the server's coded words
 * beside the action and stays open.
 */
export function WriteOffBillDialog({
  open,
  onOpenChange,
  tenant,
  token,
  locale,
  bill,
  onWrittenOff,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  token: string | null;
  locale: string;
  bill: { id: string; remaining: number; paidAmount: number; currency: string };
  /** Called once the server has written it off: the page re-reads the bill. */
  onWrittenOff: () => Promise<void> | void;
}) {
  const t = useTranslations('counterPayment.writeOff');
  const today = useMemo(() => municipalToday(), []);
  const [reason, setReason] = useState('');
  const [decisionRef, setDecisionRef] = useState('');
  const [decisionDate, setDecisionDate] = useState('');

  const reasonShort = reason.trim().length < ADJUSTMENT_REASON_MIN;
  const input = writeOffBillSchema.safeParse({ reason, decisionRef, decisionDate });
  const ready = input.success && !reasonShort && decisionDate <= today;

  const confirm = async (): Promise<void> => {
    if (!token || !input.success || !ready) return;
    try {
      await writeOffBill(tenant, token, bill.id, input.data);
    } catch (caught) {
      logApiError(caught);
      throw caught;
    }
    setReason('');
    setDecisionRef('');
    setDecisionDate('');
    await onWrittenOff();
  };

  const amount = bill.currency === 'LBP' ? formatLbp(bill.remaining, locale) : `${bill.remaining} ${bill.currency}`;

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('description')}
      confirmLabel={t('confirm')}
      cancelLabel={t('keep')}
      busyLabel={t('busy')}
      destructive
      confirmDisabled={!ready}
      onConfirm={confirm}
    >
      <Alert variant="warning">
        {bill.paidAmount > 0 ? t('amountPartPaid', { amount }) : t('amount', { amount })}
      </Alert>
      <Field
        label={t('reason', { min: ADJUSTMENT_REASON_MIN })}
        htmlFor="write-off-reason"
        required
        error={reason && reasonShort ? t('reasonTooShort', { min: ADJUSTMENT_REASON_MIN }) : undefined}
      >
        <Textarea
          id="write-off-reason"
          value={reason}
          maxLength={500}
          placeholder={t('reasonPlaceholder')}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label={t('decisionRef')} htmlFor="write-off-decision-ref" required>
          <Input
            id="write-off-decision-ref"
            value={decisionRef}
            maxLength={100}
            placeholder={t('decisionRefPlaceholder')}
            onChange={(event) => setDecisionRef(event.target.value)}
          />
        </Field>
        <Field label={t('decisionDate')} htmlFor="write-off-decision-date" required>
          <DatePicker
            id="write-off-decision-date"
            value={decisionDate}
            onChange={setDecisionDate}
            max={today}
            locale={locale === 'en' ? 'en' : 'ar'}
          />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
