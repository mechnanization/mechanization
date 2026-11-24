'use client';

import { StickyNote } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { FormSection } from './form-section';

/*
  «ملاحظات» as a card at the end of page 3, from `sm` up (GOD-22, phase 2b). On a
  phone it is `StepNotesField`, under every page. Moved out of `citizen-form.tsx`
  as it was.
*/
export function NotesSection({
  locale,
  value,
  error,
  onChange,
}: {
  locale: string;
  value: string;
  error?: string;
  onChange: (notes: string) => void;
}) {
  /* On a phone, «ملاحظات» is the box under every page instead — see `StepNotesField`. */
  return (
    <div className="hidden sm:block">
        {/*
          «ملاحظات» — the back of the paper form.

          Deliberately *not* a fourth entry in `SECTIONS`. That array drives the
          wizard's step nav, its «الخطوة ٣ من ٣» counter and the next/back
          buttons, and a field nobody is required to fill in must not become a
          step somebody has to pass through. It sits after the last step, says
          «اختياري» where the others carry a number, and gates nothing.

          Not `blanketFlagReason`, which is the box officers were using for this
          because it was the only free text on the form. That one is a *reason
          data is missing*: it is copied onto every gap in the record and its
          presence is part of what lands a registration at «يتطلب مراجعة», so
          writing «الأسرة تنتقل نهاية الشهر» into it flags a clean record for
          review and attaches that sentence to fields it does not describe.
        */}
        <FormSection
          id="notes"
          step={locale === 'en' ? 'Optional' : 'اختياري'}
          icon={StickyNote}
          title={locale === 'en' ? 'Notes' : 'ملاحظات'}

          invalid={Boolean(error)}
        >
          <Field
            label={locale === 'en' ? 'Notes' : 'ملاحظات'}
            /*
              `notes-input`, not `notes`. The `FormSection` card above already
              carries `id="notes"` as the page's scroll anchor, so the textarea
              was a second element with the same id and `htmlFor="notes"`
              resolved to the card — meaning tapping the label focused nothing.
            */
            htmlFor="notes-input"
            error={error}
          >
            <Textarea
              id="notes-input"
              rows={3}
              maxLength={2000}
              placeholder={
                locale === 'en'
                  ? 'e.g. the family is moving at the end of the month; the stairs are broken, use the back entrance.'
                  : 'مثال: الأسرة تنتقل نهاية الشهر · الدرج مكسور، الزيارة القادمة من الخلف.'
              }
              value={value}
              onChange={(event) => onChange(event.target.value)}
            />
          </Field>
        </FormSection>
    </div>
  );
}
