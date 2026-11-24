import { useState } from 'react';
import { AlertTriangle, DoorClosed, Loader2 } from 'lucide-react';
import { getLabels, isUnoccupied, VACANCY_BASIS, type VacancyBasis } from '@mechanization/shared-schemas';
import { type UnitWithOccupants } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field } from '@/components/ui/field';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Textarea } from '@/components/ui/textarea';
import { liveSpells, effectiveUnitStatus, today } from '../../building-unit-forms';

// ────────────────────────────  «تأكيد الشغور»  ────────────────────────────

/**
 * The safeguard «تأكيد الشغور» never had.
 *
 * One tap used to write «شاغرة» over whatever the unit said, and that tap
 * exempts the owner from the occupancy fee — the flat stops being billed as
 * lived in. Nothing asked what the officer had seen, nothing recorded who
 * decided it, and nothing could put it back.
 *
 * So this asks three things and states one. **What it rests on** has no
 * default, because a pre-selected basis is exactly what muscle memory confirms
 * — and the law distinguishes them: a تصريح بالشغور filed by the owner is the
 * strongest, a neighbour's word the weakest, and a unit is presumed occupied
 * until something says otherwise (هيئة التشريع والاستشارات 725/2003). **When**
 * it was seen empty, back-datable from a paper round. **What shows it**, in the
 * notes, required whatever the basis — and for hearsay, who said so. And it
 * states the consequence — including naming the owner
 * whose bill this changes, because that is the fact an officer can check
 * against the person standing in front of them.
 *
 * It also says what it will overwrite where the flat already claims to be
 * occupied: «مؤجرة» on the register and «شاغرة» at the door is a contradiction
 * worth a second look before it is resolved silently.
 *
 * It opens under the unit's actions like «كشف ضرر» and «فتح حالة متابعة» rather
 * than as a dialog: it is one more thing recorded against the unit on screen,
 * and the panel above it already names which one.
 */
export function ConfirmVacancyForm({
  unit,
  locale,
  busy,
  onSubmit,
}: {
  unit: UnitWithOccupants;
  locale: string;
  busy: boolean;
  /**
   * Handed to the panel's `run`, like every other form under a unit. A refusal
   * — «يسكنها مستأجر مسجَّل» — lands in the panel's error line directly under
   * this form, and the form stays open to be corrected.
   */
  onSubmit: (input: { basis: VacancyBasis; observedAt?: string; notes: string }) => void;
}) {
  const en = locale === 'en';
  const labels = getLabels(locale);
  // A fresh question every time it opens — the form mounts when its button is
  // pressed, and the panel keys it on the unit so never the previous flat's.
  const [basis, setBasis] = useState<VacancyBasis | null>(null);
  const [observedAt, setObservedAt] = useState(today());
  const [notes, setNotes] = useState('');

  const owners = liveSpells(unit).filter((occupant) => occupant.role === 'OWNER');
  const status = effectiveUnitStatus(unit);
  const overwriting = status && !isUnoccupied(status) ? status : null;
  /*
    Every basis says what it saw, not only hearsay. The notes are what a
    disputed exemption is read against a year later, and «معاينة ميدانية» with
    nothing under it says no more than the button did. The server insists only
    for hearsay (`confirmVacancySchema`), so this is the stricter of the two.
  */
  const notesMissing = !notes.trim();

  return (
    <div className="space-y-3 rounded-md border bg-background p-3">
      {owners.length > 0 ? (
        <SummaryList>
          <SummaryRow label={en ? 'Owner on record' : 'المالك المسجَّل'}>
            {owners
              .map((owner) => owner.citizenName ?? (en ? 'Unnamed' : 'بلا اسم'))
              .join(en ? ', ' : '، ')}
          </SummaryRow>
        </SummaryList>
      ) : null}

      {overwriting ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed">
          <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          {en
            ? `The register currently says «${labels.unitStatus[overwriting]}». Confirming replaces that.`
            : `الوحدة مسجَّلة حالياً «${labels.unitStatus[overwriting]}». التأكيد يستبدل هذه الحالة.`}
        </p>
      ) : null}

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-medium">
          {en ? 'What says it is empty?' : 'ما الذي يثبت شغورها؟'}{' '}
          <span className="text-destructive">*</span>
        </legend>
        {/*
          Rows under a rule rather than four outlined boxes. Boxed, every option
          looked like a separate button of equal weight and the one chosen
          differed only by a tint; here each has a radio mark, so the choice
          reads as one answer to one question — and it still has no default,
          see above.
        */}
        <div className="divide-y divide-border/60" role="radiogroup">
          {VACANCY_BASIS.map((option) => {
            const checked = basis === option;
            return (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setBasis(option)}
                className={cn(
                  'flex min-h-11 w-full items-center gap-3 px-1 py-2 text-start text-sm transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  checked ? 'font-medium text-primary' : 'text-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'flex size-4 shrink-0 items-center justify-center rounded-full border',
                    checked ? 'border-primary' : 'border-muted-foreground/50',
                  )}
                >
                  {checked ? <span className="size-2 rounded-full bg-primary" /> : null}
                </span>
                {labels.vacancyBasis[option]}
              </button>
            );
          })}
        </div>
      </fieldset>

      <Field
        label={en ? 'Seen empty on' : 'تاريخ المعاينة'}
        htmlFor="vacancy-observed"
      >
        <DatePicker
          id="vacancy-observed"
          max={today()}
          value={observedAt}
          onChange={setObservedAt}
          locale={en ? 'en' : 'ar'}
        />
      </Field>

      <Field label={en ? 'Notes' : 'ملاحظات'} htmlFor="vacancy-notes" required>
        <Textarea
          id="vacancy-notes"
          rows={2}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder={
            en ? 'Locked, no furniture, no meter reading' : 'مقفلة، بلا أثاث، والعداد متوقف'
          }
        />
      </Field>

      <Button
        size="sm"
        disabled={busy || !basis || notesMissing}
        onClick={() => {
          if (!basis || notesMissing) return;
          onSubmit({
            basis,
            ...(observedAt && observedAt !== today() ? { observedAt } : {}),
            notes: notes.trim(),
          });
        }}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <DoorClosed className="size-4" aria-hidden />
        )}
        {en ? 'Confirm vacant' : 'تأكيد الشغور'}
      </Button>
    </div>
  );
}

