import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { getLabels, type OccupancyEndReason, type OccupancyRole } from '@mechanization/shared-schemas';
import { type AfterTenancyAnswer, type UnitOccupant } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { AfterTenancyQuestion, afterTenancyComplete, afterTenancyPayload } from '@/components/admin/after-tenancy-question';
import { today } from '../../building-unit-forms';

// ─────────────────────────  Who is, and was, in a unit  ─────────────────────────

/** «إنهاء الملكية» / «إنهاء الإيجار» / «خروج الشاغل» — the action named for what it ends. */
export function endActionLabel(role: OccupancyRole, en: boolean): string {
  if (role === 'OWNER') return en ? 'End ownership' : 'إنهاء الملكية';
  if (role === 'TENANT') return en ? 'End tenancy' : 'إنهاء الإيجار';
  return en ? 'Occupant left' : 'خروج الشاغل';
}

/**
 * The reasons that fit a capacity — mirrored by the server, which refuses the
 * rest. An owner does not «move out» (the deed is not a residence) and a tenant
 * does not sell; «سُجِّل بالخطأ» fits everyone.
 */
function reasonsFor(role: OccupancyRole): OccupancyEndReason[] {
  return role === 'OWNER'
    ? ['OWNERSHIP_TRANSFERRED', 'RECORDED_IN_ERROR']
    : ['MOVED_OUT', 'RECORDED_IN_ERROR'];
}

/** What «إنهاء الإشغال» sends — the reason, the date, and for a tenancy what the flat is now. */
export type EndOccupancyAnswer = { reason: OccupancyEndReason; toDate?: string } & AfterTenancyAnswer;

/**
 * The confirmation «إنهاء الإشغال» never had.
 *
 * Field inspectors pressed the old text link by mistake — it sat on the same
 * row as the person's name, on a phone — and the spell ended on the spot,
 * releasing the flat from the citizen's own file and stopping its bill. So this
 * asks three things before anything is written: that this is the person meant
 * (the name and unit are in the title), when they left, and **why** — a choice
 * with no default, because a pre-selected answer is exactly what muscle memory
 * confirms. It does not ask the person to type a name: this is a correction an
 * inspector makes standing in a stairwell, not the deletion of a record.
 */
export function EndOccupancyDialog({
  occupant,
  unitCode,
  asksStatus = false,
  locale,
  onOpenChange,
  onConfirm,
}: {
  /** The spell being ended; the dialog is open while this is set. */
  occupant: UnitOccupant | null;
  unitCode: string;
  /**
   * A tenant or occupant is leaving and nobody else is recorded living in the
   * flat, so what it is now has to be said — see `AfterTenancyQuestion`.
   */
  asksStatus?: boolean;
  locale: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: EndOccupancyAnswer) => Promise<void>;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  const [reason, setReason] = useState<OccupancyEndReason | null>(null);
  const [toDate, setToDate] = useState(today());
  const [after, setAfter] = useState<AfterTenancyAnswer>({});
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  // A fresh question every time it opens — never the previous person's answer.
  useEffect(() => {
    if (occupant) {
      setReason(null);
      setToDate(today());
      setAfter({});
      setFailure(null);
      setBusy(false);
    }
  }, [occupant]);

  if (!occupant) return null;

  const name = occupant.citizenName ?? (en ? 'this person' : 'هذا الشخص');
  const action = endActionLabel(occupant.role, en);
  const tenancy = occupant.role !== 'OWNER';
  const ready = Boolean(reason) && (!asksStatus || afterTenancyComplete(after));

  const confirm = async () => {
    if (!reason || !ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      // Today is the server's default; only a back-dated end is sent.
      await onConfirm({
        reason,
        ...(toDate && toDate !== today() ? { toDate } : {}),
        ...(asksStatus ? afterTenancyPayload(after) : {}),
      });
      onOpenChange(false);
    } catch (caught) {
      setFailure(
        caught instanceof Error && caught.message
          ? caught.message
          : en
            ? 'Could not end the occupancy.'
            : 'تعذّر إنهاء الإشغال.',
      );
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={busy ? undefined : onOpenChange}>
      <DialogContent className="max-w-md" closeLabel={en ? 'Cancel' : 'إلغاء'}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span
              aria-hidden
              className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive"
            >
              <AlertTriangle className="size-5" />
            </span>
            <div className="min-w-0 space-y-1.5 text-start">
              <DialogTitle>
                {en ? `${action}: ${name} in unit ` : `${action}: ${name} في الوحدة `}
                <span dir="ltr" className="font-mono">
                  {unitCode}
                </span>
                {en ? '?' : '؟'}
              </DialogTitle>
              <DialogDescription>
                {tenancy
                  ? en
                    ? 'They move to «Former» on this unit and stop being charged for it. Their card stays on their file as an ended tenancy, documents included, and the owner stays the owner.'
                    : 'ينتقل إلى «سابق» على هذه الوحدة وتتوقف رسومها عليه. تبقى بطاقته في ملفه كإيجار منتهٍ مع مستنداتها، ويبقى المالك مالكاً.'
                  : en
                    ? 'They move to «Former» on this unit, the unit is released from their file, and fees for it stop being charged to them.'
                    : 'ينتقل إلى «سابق» على هذه الوحدة، وتُفصل الوحدة عن ملفه، وتتوقف الرسوم عليه عنها.'}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-3">
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-medium">
              {en ? 'Why?' : 'السبب'} <span className="text-destructive">*</span>
            </legend>
            <div className="grid gap-2" role="radiogroup">
              {reasonsFor(occupant.role).map((option) => (
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
                  {labels.occupancyEndReason[option]}
                </button>
              ))}
            </div>
            {reason === 'RECORDED_IN_ERROR' ? (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {en
                  ? 'Kept on record as what was entered, and hidden from the unit’s history.'
                  : 'يبقى محفوظاً كسجل لما أُدخل، ولا يظهر في تاريخ الوحدة.'}
              </p>
            ) : null}
          </fieldset>

          {reason !== 'RECORDED_IN_ERROR' ? (
            <Field label={en ? 'Left on' : 'تاريخ الانتهاء'} htmlFor="end-occupancy-date">
              <DatePicker
                id="end-occupancy-date"
                min={occupant.fromDate.slice(0, 10)}
                max={today()}
                value={toDate}
                onChange={setToDate}
                locale={en ? 'en' : 'ar'}
              />
            </Field>
          ) : null}

          {asksStatus && reason ? (
            <AfterTenancyQuestion value={after} onChange={setAfter} locale={locale} />
          ) : null}
          {tenancy && !asksStatus && reason ? (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {en
                ? 'Someone else is still recorded living in this unit, so its status stays as it is.'
                : 'ما زال شخص آخر مسجَّلاً ساكناً في هذه الوحدة، فتبقى حالتها كما هي.'}
            </p>
          ) : null}

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
            variant="destructive"
            onClick={() => void confirm()}
            disabled={busy || !ready}
            className="w-full sm:w-auto"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
