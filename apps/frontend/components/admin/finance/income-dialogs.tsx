'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { logApiError, voidIncomeVoucher, type IncomeVoucherView } from '@/lib/api-client';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';

/**
 * «إلغاء سند القبض» — the manager's cancellation.
 *
 * `destructive={false}` (DES-4): nothing is lost — the voucher stays, with its
 * reason. What it does is take the money back out of the wallet, and the copy
 * says so, along with the one refusal the manager may meet: a wallet that has
 * spent the money since. That refusal comes back from the server with the
 * figures named and is shown in the dialog, which stays open (STA-3).
 *
 * The caller re-reads the treasury on `onDone`: the wallet, the register and
 * the voucher itself all moved.
 */
export function VoidIncomeDialog({
  tenant,
  token,
  voucher,
  onDone,
  onCancel,
}: {
  tenant: string;
  token: string;
  voucher: IncomeVoucherView;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const t = useTranslations('finance.income.voidDialog');
  const toast = useToast();
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
      await voidIncomeVoucher(tenant, token, { id: voucher.id, reason: reason.trim() });
      toast.success(t('success', { number: voucher.voucherNumber }));
      onDone();
    } catch (caught) {
      logApiError(caught);
      // Thrown back to `ConfirmDialog`, which shows the server's refusal inline (PRIM-16).
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
      title={t('title', { number: voucher.voucherNumber })}
      description={t('body')}
      confirmLabel={t('confirm')}
      cancelLabel={t('cancel')}
      busyLabel={t('busy')}
      onConfirm={confirm}
    >
      <Field htmlFor="income-void-reason" label={t('reason')} error={error ?? undefined} required>
        <Textarea
          id="income-void-reason"
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
