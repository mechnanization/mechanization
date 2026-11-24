'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { getLabels, VACANCY_END_REASON, type VacancyEndReason } from '@mechanization/shared-schemas';
import { type UnitVacancyConfirmation } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { today } from '../../building-unit-forms';

/**
 * The undo, asked the way `EndOccupancyDialog` asks.
 *
 * The reason is not a formality: it decides what the flat goes back to, and the
 * dialog says which before it is pressed. «سُجِّل بالخطأ» puts back the حالة the
 * confirmation replaced — the register was wrong and this is the correction.
 * «لم تعد شاغرة» leaves the unit occupied-by-someone-unrecorded, which is the
 * presumption the law starts from and the state that bills the owner again
 * until whoever moved in is recorded.
 */
export function EndVacancyDialog({
  vacancy,
  unitCode,
  locale,
  onOpenChange,
  onConfirm,
}: {
  /** The standing confirmation; the dialog is open while this is set. */
  vacancy: UnitVacancyConfirmation | null;
  unitCode: string;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: {
    reason: VacancyEndReason;
    endedAt?: string;
    notes: string;
  }) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [reason, setReason] = useState<VacancyEndReason | null>(null);
  const [endedAt, setEndedAt] = useState(today());
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (vacancy) {
      setReason(null);
      setEndedAt(today());
      setNotes('');
      setFailure(null);
      setBusy(false);
    }
  }, [vacancy]);

  if (!vacancy) return null;

  const restored = vacancy.previousUnitStatus
    ? labels.unitStatus[vacancy.previousUnitStatus]
    : en
      ? 'Occupancy not established'
      : 'الإشغال غير محدد';

  const confirm = async () => {
    if (!reason || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await onConfirm({
        reason,
        ...(reason === 'NO_LONGER_VACANT' && endedAt ? { endedAt } : {}),
        notes: notes.trim(),
      });
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not lift the vacancy.'
            : 'تعذّر إلغاء تأكيد الشغور.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <div className="min-w-0 space-y-1.5 text-start">
            <DialogTitle>
              {en ? 'Lift the vacancy on unit ' : 'إلغاء تأكيد شغور الوحدة '}
              <span dir="ltr" className="font-mono">
                {unitCode}
              </span>
              {en ? '?' : '؟'}
            </DialogTitle>
            <DialogDescription>
              {en
                ? 'The confirmation is closed and kept on record — it is not deleted.'
                : 'يُغلق التأكيد ويبقى محفوظاً في السجل — لا يُحذف.'}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">
              {en ? 'Why?' : 'السبب'} <span className="text-destructive">*</span>
            </legend>
            <div className="grid gap-2" role="radiogroup">
              {VACANCY_END_REASON.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={reason === option}
                  onClick={() => setReason(option)}
                  className={cn(
                    'min-h-11 rounded-md border px-3 py-2 text-start text-sm transition-colors',
                    reason === option
                      ? 'border-primary bg-primary/10 font-medium text-primary'
                      : 'hover:bg-accent',
                  )}
                >
                  {labels.vacancyEndReason[option]}
                </button>
              ))}
            </div>
          </fieldset>

          {/* What the flat will read afterwards, said before it is pressed. */}
          {reason ? (
            <p className="rounded-md bg-accent/40 px-2.5 py-2 text-xs leading-relaxed">
              {reason === 'RECORDED_IN_ERROR'
                ? en
                  ? `The unit goes back to «${restored}».`
                  : `تعود الوحدة إلى «${restored}».`
                : en
                  ? 'The unit is treated as occupied by somebody not yet recorded, and is billed to its owner again until they are. Record whoever lives there next.'
                  : 'تُعدّ الوحدة مشغولة بمن لم يُسجَّل بعد، وتعود الرسوم على المالك إلى أن يُسجَّل. سجّل من يسكنها بعد ذلك.'}
            </p>
          ) : null}

          {reason === 'NO_LONGER_VACANT' ? (
            <Field label={en ? 'Occupied again since' : 'تاريخ انتهاء الشغور'} htmlFor="vacancy-ended">
              <DatePicker
                id="vacancy-ended"
                min={vacancy.observedAt.slice(0, 10)}
                max={today()}
                value={endedAt}
                onChange={setEndedAt}
                locale={en ? 'en' : 'ar'}
              />
            </Field>
          ) : null}

          <Field label={en ? 'Notes' : 'ملاحظات'} htmlFor="vacancy-end-notes">
            <Textarea
              id="vacancy-end-notes"
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder={
                en ? 'A family moved in at the start of the month' : 'سكنتها أسرة مطلع الشهر'
              }
            />
          </Field>

          {failure ? (
            <Alert variant="destructive" live="alert">
              {failure}
            </Alert>
          ) : null}
        </div>

        <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
            className="w-full sm:w-auto"
          >
            {en ? 'Cancel' : 'إلغاء'}
          </Button>
          <Button
            onClick={() => void confirm()}
            disabled={busy || !reason}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {en ? 'Lift the vacancy' : 'إلغاء تأكيد الشغور'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

