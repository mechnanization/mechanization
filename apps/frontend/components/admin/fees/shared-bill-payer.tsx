'use client';

import { useTranslations } from 'next-intl';
import { Field } from '@/components/ui/field';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/**
 * «الدافع من المسجّلين على الوحدة» — who is paying a shared unit bill (0099,
 * D5): owed in full by everyone registered on the unit, paid by any of them,
 * the receipt naming the one who did. The server refuses a payment on it that
 * names nobody (`SHARED_BILL_PAYER_REQUIRED`).
 *
 * The unit's «مالك مسؤول» is marked in the list. Where the choice starts is
 * the page's (`defaultPayer`). Used by the counter's settle page and the
 * citizen file's cash page alike.
 */
export function SharedBillPayerField({
  id,
  debtors,
  value,
  onChange,
  disabled,
}: {
  id: string;
  debtors: ReadonlyArray<{ citizenId: string; name: string; responsible?: boolean }>;
  value: string;
  onChange: (citizenId: string) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('counterPayment');
  return (
    <Field label={t('payer')} htmlFor={id} required>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={t('payerPlaceholder')} />
        </SelectTrigger>
        <SelectContent>
          {debtors.map((debtor) => (
            <SelectItem key={debtor.citizenId} value={debtor.citizenId}>
              {debtor.responsible ? t('payerResponsible', { name: debtor.name }) : debtor.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
