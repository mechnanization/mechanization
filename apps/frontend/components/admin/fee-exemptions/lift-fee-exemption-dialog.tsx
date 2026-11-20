'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { FEE_EXEMPTION_LIFT_REASON_MIN, FEE_EXEMPTION_TEXT_MAX } from '@mechanization/shared-schemas';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';

/**
 * «رفع الإعفاء» — asks why before it lifts (decision of 2026-11-16): the reason is
 * kept on the exemption's period and in the audit row. Not destructive: granting
 * again undoes it, as a new period. `onConfirm` may throw; the dialog then shows
 * the refusal in place and keeps what was typed (PRIM-16).
 */
export function LiftFeeExemptionDialog({
  open,
  onOpenChange,
  idPrefix,
  unitCode,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  idPrefix: string;
  unitCode: string;
  onConfirm: (liftReason: string) => void | Promise<void>;
}) {
  const t = useTranslations('feeExemption');
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('liftTitle', { code: unitCode })}
      description={t('liftBody')}
      confirmLabel={t('lift')}
      cancelLabel={t('cancel')}
      // Lifting is undone by granting again: not a destructive act.
      destructive={false}
      confirmDisabled={reason.trim().length < FEE_EXEMPTION_LIFT_REASON_MIN}
      onConfirm={() => onConfirm(reason.trim())}
    >
      <Field label={t('liftReason')} htmlFor={`${idPrefix}-lift-reason`} required>
        <Textarea
          id={`${idPrefix}-lift-reason`}
          rows={3}
          maxLength={FEE_EXEMPTION_TEXT_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={t('liftReasonPlaceholder')}
        />
      </Field>
    </ConfirmDialog>
  );
}
