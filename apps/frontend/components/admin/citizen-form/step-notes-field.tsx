'use client';

import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * «ملاحظات» on a phone — under every step, not parked after the last one.
 *
 * The desktop layout can afford to put this at the bottom of a long page: the
 * whole record is on one scroll, so "after العقارات" is somewhere an officer
 * passes anyway. A phone shows one step at a time, and the notes card lived
 * inside the `hidden sm:block` column — so on the device this form is actually
 * used on, in a stairwell, there was **no way to write a note at all**.
 *
 * What makes that expensive is *when* the note occurs to someone. It is never
 * at the end: it is «الدرج مكسور» while they are standing on the stairs, and
 * «الأسرة تنتقل نهاية الشهر» while the person is saying it, halfway through
 * البيانات الشخصية. A box reachable only from the last step asks them to hold
 * the sentence in their head across two «التالي» presses, and what actually
 * happened instead is that officers typed it into «سبب عام لنقص البيانات» —
 * the one free-text box that *was* reachable — which flags a clean record for
 * review and attaches the sentence to fields it does not describe.
 *
 * So it is rendered once, outside the step switch, and every step has it.
 *
 * ## Why it is not collapsed behind a tap
 *
 * A fold would buy back about 100px on a screen that already scrolls, and it
 * would cost the one property that makes this worth doing: that the box is
 * *there*, needing nothing, at the moment the sentence occurs. It is also the
 * last thing in the step, so the height it takes displaces nothing — an
 * officer reaches it after the step's own fields, on the way to «التالي».
 *
 * It stays visually quiet while empty — dashed, on the page's own tone — so
 * that being present on all three steps does not make it loud on all three.
 */
export function StepNotesField({
  value,
  error,
  onChange,
  locale,
}: {
  value: string;
  error?: string;
  onChange: (notes: string) => void;
  locale: string;
}) {
  const en = locale === 'en';
  const written = value.trim().length > 0;

  return (
    <div
      /*
        Not `id="notes"`. The desktop card on page 3 owns that, and both are in
        the document at once — sharing the id would give the page two elements
        answering to `notes`, one of them `display:none` on any given screen,
        where `scrollIntoView` is a silent no-op.
      */
      id="notes-mobile"
      className={cn(
        'scroll-mt-28 rounded-xl border p-3 transition-colors',
        error
          ? 'border-destructive/50 bg-destructive/5'
          : written
            ? 'border-border/80 bg-card shadow-2xs'
            : 'border-dashed border-border/70 bg-muted/10',
      )}
    >
      <Field
        label={en ? 'Notes' : 'ملاحظات'}
        htmlFor="notes-mobile-input"
        error={error}
      >
        <Textarea
          id="notes-mobile-input"
          rows={2}
          maxLength={2000}
          placeholder={
            en
              ? 'e.g. the stairs are broken — use the back entrance next time.'
              : 'مثال: الدرج مكسور، الزيارة القادمة من الخلف.'
          }
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      </Field>
    </div>
  );
}
