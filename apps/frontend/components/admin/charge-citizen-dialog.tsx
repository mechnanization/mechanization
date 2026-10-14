'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
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
        closeLabel={locale === 'en' ? 'Close' : 'إغلاق'}
        className="flex max-h-[85dvh] flex-col gap-0 p-0 sm:max-w-lg"
      >
        <DialogHeader className="shrink-0 space-y-1 border-b p-6 text-start">
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="size-5 text-primary" aria-hidden />
            {locale === 'en' ? 'Direct Charge Citizen' : 'إضافة مطالبة لمواطن'}
          </DialogTitle>
          <DialogDescription>
            {locale === 'en'
              ? 'One-off individual charge without periodic billing recurrence.'
              : 'مطالبة فردية لمرة واحدة، دون إشعار أو تكرار.'}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <Field
            label={locale === 'en' ? 'Citizen' : 'المواطن'}
            htmlFor="charge-citizen"
            required
          >
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

          <Field
            label={locale === 'en' ? 'Fee / Bill Type' : 'نوع الرسم / سبب المطالبة'}
            htmlFor="charge-title"
            required
          >
            <BillTypeSelect
              id="charge-title"
              locale={locale}
              value={values.title}
              onChange={(title) => set({ title })}
              existingTitles={existingTitles}
              placeholder={
                locale === 'en'
                  ? 'Select from previous bills or type a new title…'
                  : 'اختر من الرسوم السابقة أو اكتب اسماً جديداً…'
              }
            />
          </Field>

          <div className="grid gap-5">
            <Field
              label={locale === 'en' ? 'Amount (LBP)' : 'المبلغ بالليرة اللبنانية'}
              htmlFor="charge-amount"
              required
            >
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
            <Field
              label={locale === 'en' ? 'Due Date' : 'تاريخ الاستحقاق'}
              htmlFor="charge-due"
              required
            >
              <Input
                id="charge-due"
                type="date"
                dir="ltr"
                className="text-start"
                value={values.dueDate}
                onChange={(event) => set({ dueDate: event.target.value })}
              />
            </Field>
          </div>
        </div>

        <DialogFooter className="shrink-0 gap-2 border-t p-6">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {locale === 'en' ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button disabled={!complete || submitting} onClick={() => onSubmit(values)}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {locale === 'en' ? 'Add Charge' : 'إضافة المطالبة'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
