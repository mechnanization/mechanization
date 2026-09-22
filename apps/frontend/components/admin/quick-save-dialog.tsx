'use client';

import { useEffect, useState } from 'react';
import { Loader2, TriangleAlert, Zap } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * «حفظ سريع / بيانات ناقصة» — one reason for a visit that could not be
 * completed (P3-T6, D12).
 *
 * The record this exists for is the one an officer could barely start: a name, a
 * phone, and a household that was not there. Without it that visit produces
 * nothing at all — the form refuses to save, and the officer walks away with a
 * page of blanks and a household nobody will find again.
 *
 * Three things about it are load-bearing and easy to get wrong:
 *
 *  - **It fills per-field flags; it does not replace them.** That is D12
 *    exactly. The reason is copied onto every gap the record still has, as an
 *    *overridable default* — a reviewer opening the record sees which fields
 *    are missing and why, not one sentence attached to nothing actionable.
 *  - **It cannot supply a name or a discriminator.** `isLebanese`,
 *    `firstName`/`lastName` and نوع العقار / نوع الإشغال are in
 *    `NON_FLAGGABLE_FIELDS`, so no reason — blanket or explicit — excuses them.
 *    A record without those is not a record with gaps; it is not a record.
 *  - **It excuses only fields that are actually empty.** A malformed phone
 *    number is a typo to correct, not missing data to excuse, and auto-flagging
 *    it would blank what the officer typed and hide the mistake behind a
 *    sentence that does not describe it. Those still fail, and the officer fixes
 *    them.
 *
 * All three are enforced server-side by `autoFlags`; this dialog states them
 * where the decision is made, so an officer who is about to use it knows what
 * it will and will not cover.
 */

/**
 * The reasons a doorstep actually produces.
 *
 * Presets rather than a bare textarea, because the field this excuses is the
 * one nobody wants to type on a phone in a stairwell — and «لا» typed thirty
 * times is exactly the outcome the four-character floor exists to prevent. Each
 * is a full sentence a reviewer can act on, and each is still editable.
 */
const PRESETS_AR: readonly string[] = [
  'الأسرة غائبة ولم يتوفر من يعطي البيانات',
  'رفض صاحب العلاقة إعطاء بيانات إضافية',
  'الوحدة مقفلة ولم يتم الرد بعد عدة محاولات',
  'البيانات لدى صاحب العقار وهو خارج البلدة',
  'المبنى متضرر ويتعذّر الوصول إلى السكان',
];

const PRESETS_EN: readonly string[] = [
  'The household was away and nobody could supply the details',
  'The resident declined to give further information',
  'The unit was locked and nobody answered after several attempts',
  'The details are held by the owner, who is out of town',
  'The building is damaged and the residents could not be reached',
];

export function QuickSaveDialog({
  open,
  onOpenChange,
  /** How many gaps the reason will be asked to cover, for the confirmation line. */
  gapCount,
  submitting,
  error,
  onConfirm,
  locale = 'ar',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gapCount: number;
  submitting: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  locale?: string;
}) {
  const en = locale === 'en';
  const presets = en ? PRESETS_EN : PRESETS_AR;

  const [reason, setReason] = useState('');

  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  const trimmed = reason.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={en ? 'Close' : 'إغلاق'} className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Zap className="size-5 text-warning" aria-hidden />
            {en ? 'Quick save — incomplete data' : 'حفظ سريع — بيانات ناقصة'}
          </DialogTitle>
          <DialogDescription>
            {en
              ? 'One reason, copied onto every field this record still cannot answer. The record is filed as «requires review».'
              : 'سبب واحد يُنسخ على كل حقل لا يستطيع هذا السجل الإجابة عنه. يُحفظ السجل بحالة «يتطلب مراجعة».'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setReason(preset)}
                aria-pressed={trimmed === preset}
                className={cn(
                  'rounded-md border px-2.5 py-1.5 text-start text-xs transition-colors',
                  trimmed === preset
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'hover:bg-accent',
                )}
              >
                {preset}
              </button>
            ))}
          </div>

          <Field
            label={en ? 'Reason' : 'السبب'}
            htmlFor="blanket-reason"
            required
          >
            <Textarea
              id="blanket-reason"
              rows={2}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={presets[0]}
            />
          </Field>

          <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {en
                ? 'It cannot supply the name, whether the person is Lebanese, or the property and occupancy types — nothing excuses those. Values that were entered but are invalid are typos to fix, not gaps to excuse, and will still be reported.'
                : 'لا يغطي هذا السبب الاسم ولا الجنسية ولا نوع العقار ونوع الإشغال — لا شيء يعفي منها. أما القيم المُدخلة وغير الصالحة فهي أخطاء تُصحَّح لا نواقص تُبرَّر، وستظل تُعرض.'}
            </span>
          </p>

          {gapCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {en
                ? `About ${gapCount} field(s) are currently empty on this record.`
                : `يوجد نحو ${gapCount} حقل فارغ في هذا السجل حالياً.`}
            </p>
          ) : null}

          {error ? (
            <Alert tone="error" size="sm">
              {error}
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          {/*
            The same four-character floor the per-field reason has, checked here
            so the officer is not sent to the server to be told. «لا» records
            that somebody pressed the button, not why the data is missing.
          */}
          <Button onClick={() => onConfirm(trimmed)} disabled={submitting || trimmed.length < 4}>
            {submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Save with this reason' : 'حفظ مع هذا السبب'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
