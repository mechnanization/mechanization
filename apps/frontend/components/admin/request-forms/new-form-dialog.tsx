'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createRequestFormSchema } from '@mechanization/shared-schemas';
import { logApiError } from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { createRequestForm } from '@/lib/request-forms-api';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

/**
 * «نموذج جديد»: a name and a fee, then the builder (docs/request-forms-plan.md §6). The form starts switched off with an
 * empty draft, so nothing reaches a citizen until the manager has added questions, published and switched it on. The other
 * settings take their defaults and are set on the builder's own page, beside the questions they go with.
 */
export function NewFormDialog({
  tenant,
  token,
  locale,
  onCancel,
  onCreated,
}: {
  tenant: string;
  token: string;
  locale: string;
  onCancel: () => void;
  onCreated: (id: string) => void;
}): React.JSX.Element {
  const t = useTranslations('requests.forms');
  const [name, setName] = useState('');
  const [fee, setFee] = useState('');
  const [errors, setErrors] = useState<{ name?: string; fee?: string }>({});
  const inFlight = useRef(false);

  const create = async () => {
    if (inFlight.current) return;
    const parsed = createRequestFormSchema.safeParse({
      nameAr: name,
      feeAmount: parseAmount(fee),
      propertyMode: 'OPTIONAL',
      askCapacity: false,
      askPurpose: false,
    });
    if (!parsed.success) {
      const next: { name?: string; fee?: string } = {};
      for (const issue of parsed.error.issues) {
        if (issue.path[0] === 'nameAr') next.name = t('builder.settings.nameRequired');
        if (issue.path[0] === 'feeAmount') next.fee = t('builder.settings.feeInvalid');
      }
      setErrors(next);
      document.getElementById(next.name ? 'new-form-name' : 'new-form-fee')?.focus();
      throw new Error(next.name ?? next.fee ?? t('list.createError'));
    }
    setErrors({});
    inFlight.current = true;
    try {
      const form = await createRequestForm(tenant, token, parsed.data);
      onCreated(form.id);
    } catch (caught) {
      logApiError(caught);
      throw caught instanceof Error && caught.message ? caught : new Error(t('list.createError'));
    } finally {
      inFlight.current = false;
    }
  };

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onCancel())}
      destructive={false}
      title={t('list.newTitle')}
      description={t('list.newHint')}
      confirmLabel={t('list.create')}
      busyLabel={t('list.creating')}
      cancelLabel={t('builder.actions.cancel')}
      onConfirm={create}
    >
      <div className="space-y-4">
        <Field htmlFor="new-form-name" label={t('builder.settings.nameAr')} required error={errors.name}>
          <Input id="new-form-name" dir="rtl" value={name} invalid={Boolean(errors.name)} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field htmlFor="new-form-fee" label={t('builder.settings.fee')} error={errors.fee}>
          <CurrencyInput
            id="new-form-fee"
            unit={currencyUnit('LBP', locale)}
            value={fee}
            placeholder="0"
            invalid={Boolean(errors.fee)}
            onChange={(raw) => setFee(formatTypedAmount(raw, 0))}
          />
        </Field>
      </div>
    </ConfirmDialog>
  );
}
