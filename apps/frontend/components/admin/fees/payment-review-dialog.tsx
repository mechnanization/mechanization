'use client';

import { useTranslations } from 'next-intl';
import { getLabels } from '@mechanization/shared-schemas';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Money } from '@/components/ui/money';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import type { AdminPaymentItem } from '@/lib/api-client';

/**
 * «تأكيد» or «رفض» on a transfer a citizen declared — `PATCH fees/payments/:id/review` (PRIM-16).
 *
 * Both used to fire from the row on one click, side by side. Neither is
 * light: a confirmation writes the bill's remaining balance into the ledger
 * and the treasury, and a refusal sends the bill back to unpaid and erases the
 * method and transfer reference the citizen declared — the one thing the clerk
 * had to match against the Whish account. So each asks first, and shows what
 * the clerk is matching: who, which bill, how much, and the reference.
 *
 * `onConfirm` throws on a refusal; `ConfirmDialog` shows it under the question
 * and stays open.
 */
export function PaymentReviewDialog({
  review,
  onOpenChange,
  onConfirm,
  locale,
}: {
  review: { payment: AdminPaymentItem; confirmed: boolean } | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (paymentId: string, confirmed: boolean) => Promise<void>;
  locale: string;
}): React.JSX.Element | null {
  const t = useTranslations('fees.register.review');
  const tCommon = useTranslations('common');
  if (!review) return null;

  const { payment, confirmed } = review;
  const labels = getLabels(locale);
  const method = payment.paymentMethod
    ? (labels.paymentMethod[payment.paymentMethod as never] ?? payment.paymentMethod)
    : null;

  // A shared unit bill (0099) has no one citizen: the unit is named instead.
  const who =
    payment.citizenName ??
    (payment.sharedUnit
      ? tCommon('sharedUnitBill', {
          building: payment.sharedUnit.buildingCode,
          unit: payment.sharedUnit.unitCode,
          count: payment.sharedUnit.debtorCount,
        })
      : '—');

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      destructive={!confirmed}
      title={confirmed ? t('confirmTitle', { citizen: who }) : t('rejectTitle', { citizen: who })}
      description={confirmed ? t('confirmBody') : t('rejectBody')}
      confirmLabel={confirmed ? t('confirmAction') : t('rejectAction')}
      cancelLabel={tCommon('cancel')}
      busyLabel={tCommon('saving')}
      onConfirm={() => onConfirm(payment.id, confirmed)}
    >
      <SummaryList>
        <SummaryRow label={t('bill')}>{payment.title}</SummaryRow>
        <SummaryRow label={t('amount')}>
          <Money amount={payment.remaining} currency={payment.currency} exact locale={locale} />
        </SummaryRow>
        {method ? <SummaryRow label={t('method')}>{method}</SummaryRow> : null}
        {payment.whishTransactionRef ? (
          <SummaryRow label={t('reference')} className="font-mono">
            <span dir="ltr">{payment.whishTransactionRef}</span>
          </SummaryRow>
        ) : null}
      </SummaryList>
    </ConfirmDialog>
  );
}
