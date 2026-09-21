'use client';

import { useEffect, useState } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import type { CitizenListItem } from '@/lib/api-client';
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
  citizens,
  submitting,
  error,
  onSubmit,
  locale = 'ar',
  existingTitles = [],
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  citizens: CitizenListItem[];
  submitting: boolean;
  error: string | null;
  onSubmit: (values: ChargeValues) => void;
  locale?: string;
  existingTitles?: string[];
}) {
  const [values, setValues] = useState<ChargeValues>(EMPTY);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) {
      setValues(EMPTY);
      setQuery('');
    }
  }, [open]);

  const set = (patch: Partial<ChargeValues>) =>
    setValues((previous) => ({ ...previous, ...patch }));

  const q = query.trim().toLowerCase();
  const digitsOnly = q.replace(/\D/g, '');
  const matches = q
    ? citizens
        .filter(
          (row) =>
            row.fullName.toLowerCase().includes(q) ||
            (row.referenceNumber ?? '').toLowerCase().includes(q) ||
            (row.phone ?? '').toLowerCase().includes(q) ||
            (digitsOnly.length > 0 && (row.phone ?? '').replace(/\D/g, '').includes(digitsOnly)) ||
            (row.whatsapp ?? '').toLowerCase().includes(q) ||
            (row.identityDocNumber ?? '').toLowerCase().includes(q) ||
            row.id.toLowerCase().includes(q),
        )
        .slice(0, 8)
    : [];

  const chosen = citizens.find((row) => row.id === values.citizenId);

  const complete =
    values.citizenId !== '' &&
    values.title.trim().length >= 3 &&
    Number(values.amount.replace(/\D/g, '')) > 0 &&
    values.dueDate !== '';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={locale === 'en' ? 'Close' : 'إغلاق'}
        className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-lg"
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
            <div className="space-y-2">
              <Input
                id="charge-citizen"
                placeholder={locale === 'en' ? 'Citizen name or reference number' : 'اسم المواطن أو الرقم المرجعي'}
                value={chosen ? `${chosen.fullName} — ${chosen.referenceNumber}` : query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  if (values.citizenId) set({ citizenId: '' });
                }}
              />
              {!chosen && matches.length > 0 ? (
                <ul className="overflow-hidden rounded-lg border">
                  {matches.map((row) => (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => {
                          set({ citizenId: row.id });
                          setQuery('');
                        }}
                        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-start text-sm transition-colors hover:bg-accent"
                      >
                        <span className="font-medium">{row.fullName}</span>
                        <span className="font-mono text-xs text-muted-foreground" dir="ltr">
                          {row.referenceNumber}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
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
