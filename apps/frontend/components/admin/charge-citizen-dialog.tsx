'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { BillTypeSelect } from '@/components/admin/bill-type-select';
import { CitizenPicker, type PickedCitizen } from '@/components/admin/citizen-picker';

export interface ChargeValues {
  citizenId: string;
  title: string;
  amount: string;
  dueDate: string;
}

const EMPTY: ChargeValues = { citizenId: '', title: '', amount: '', dueDate: '' };

function formatLbp(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits ? Number(digits).toLocaleString('en-US') : '';
}

/**
 * A one-off charge on a single citizen.
 *
 * Deliberately not the same form as "إصدار رسم جديد": that one writes a rule
 * and fans it out, this one records a single debt with nothing behind it —
 * a penalty, a certificate fee, a correction. Sharing a form would have meant
 * a frequency selector on something that never recurs.
 */
export function ChargeCitizenDialog({
  open,
  onOpenChange,
  tenant,
  token,
  submitting,
  error,
  onSubmit,
  locale = 'ar',
  existingTitles = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenant: string;
  /** The staff session's token; the picker searches the register with it. */
  token: string | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (values: ChargeValues) => void;
  locale?: string;
  existingTitles?: string[];
}) {
  const t = useTranslations('fees.charge');
  const tCommon = useTranslations('common');
  const [values, setValues] = useState<ChargeValues>(EMPTY);
  /** The file chosen in the picker (`CitizenPicker`), whose id `values.citizenId` carries. */
  const [picked, setPicked] = useState<PickedCitizen | null>(null);

  useEffect(() => {
    if (open) {
      setValues(EMPTY);
      setPicked(null);
    }
  }, [open]);

  const set = (patch: Partial<ChargeValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  const complete =
    values.citizenId !== '' &&
    values.title.trim().length >= 3 &&
    Number(values.amount.replace(/\D/g, '')) > 0 &&
    values.dueDate !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={tCommon('close')}
        className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg"
      >
        <DialogHeader className="shrink-0 space-y-1 border-b p-6 text-start">
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-5 text-primary" aria-hidden />
            {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <Alert variant="destructive" live="alert">
              {error}
            </Alert>
          ) : null}

          <Field label={t('citizen')} htmlFor="charge-citizen" required>
            <CitizenPicker
              id="charge-citizen"
              tenant={tenant}
              token={token}
              value={picked}
              onChange={(citizen) => {
                setPicked(citizen);
                set({ citizenId: citizen?.id ?? '' });
              }}
            />
          </Field>

          <Field label={t('billType')} htmlFor="charge-title" required>
            <BillTypeSelect
              id="charge-title"
              locale={locale}
              value={values.title}
              onChange={(title) => set({ title })}
              existingTitles={existingTitles}
              placeholder={t('billTypePlaceholder')}
            />
          </Field>

          <div className="grid gap-5">
            <Field label={t('amount')} htmlFor="charge-amount" required>
              <Input
                id="charge-amount"
                inputMode="numeric"
                dir="ltr"
                className="text-start"
                placeholder="250,000"
                value={values.amount}
                onChange={(event) => set({ amount: formatLbp(event.target.value) })}
              />
            </Field>
            <Field label={t('dueDate')} htmlFor="charge-due" required>
              <DatePicker
                id="charge-due"
                value={values.dueDate}
                onChange={(dueDate) => set({ dueDate })}
                locale={locale === 'en' ? 'en' : 'ar'}
              />
            </Field>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button disabled={!complete || submitting} onClick={() => onSubmit(values)}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
