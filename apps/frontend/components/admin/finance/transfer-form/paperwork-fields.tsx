'use client';

import { useTranslations } from 'next-intl';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FormSection } from './form-section';
import type { RecordTransferState } from './use-record-transfer';

/** The statement the voucher carries, the day it happened and why an earlier one. */
export function PaperworkFields({ form, locale }: { form: RecordTransferState; locale: string }): React.JSX.Element {
  const t = useTranslations('finance.transfers.form');
  const {
    kind,
    description,
    setDescription,
    transferredOn,
    setTransferredOn,
    today,
    backdated,
    backdateReason,
    setBackdateReason,
    errors,
    clear,
  } = form;

  return (
    <FormSection title={t('sections.paperwork')}>
      <Field htmlFor="transfer-description" label={t('description')} error={errors.description} required>
        <Textarea
          id="transfer-description"
          rows={2}
          maxLength={500}
          value={description}
          placeholder={kind === 'EXCHANGE' ? t('descriptionPlaceholderExchange') : t('descriptionPlaceholder')}
          onChange={(event) => {
            setDescription(event.target.value);
            clear('description');
          }}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field htmlFor="transfer-date" label={t('date')} required>
          <DatePicker
            id="transfer-date"
            value={transferredOn}
            max={today}
            locale={locale === 'en' ? 'en' : 'ar'}
            onChange={(value) => setTransferredOn(value || today)}
          />
        </Field>
        {backdated ? (
          <Field htmlFor="transfer-backdateReason" label={t('backdateReason')} error={errors.backdateReason} required>
            <Input
              id="transfer-backdateReason"
              value={backdateReason}
              maxLength={500}
              placeholder={t('backdatePlaceholder')}
              invalid={Boolean(errors.backdateReason)}
              onChange={(event) => {
                setBackdateReason(event.target.value);
                clear('backdateReason');
              }}
            />
          </Field>
        ) : null}
      </div>
    </FormSection>
  );
}
