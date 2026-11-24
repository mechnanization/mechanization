import { Label } from '@/components/ui/label';

/**
 * One numbered question in the wizard's first step.
 *
 * ## Why a number rather than just a label
 *
 * This step now asks five things in a fixed order, and the order is the
 * instruction: pick a sector, place the building, confirm what parcel that
 * turned out to be, say whether it is partitioned, list any other parcels it
 * stands on. Each answer narrows the next. A flat stack of labelled fields
 * would present them as five independent questions an officer may answer in
 * any order — and answering the third first is precisely the sequence the old
 * form imposed and this one exists to undo.
 *
 * The ordinals are computed by the caller rather than by a counter here,
 * because the first one disappears on a correction: a building being edited
 * already has a parcel, so it already has a sector, and «اختر القطاع» would be
 * a question whose answer is printed below it.
 *
 * ## Why it does not wrap `Field`
 *
 * `Field` requires an `htmlFor`, which three of these five have no single
 * input to point at — the map, the partition choice and the repeatable parcel
 * list are all sections rather than controls. A `<label>` aimed at an id that
 * does not exist is worse than a heading: it announces to a screen reader that
 * activating it will focus something, and nothing is focused.
 */
export function StepField({
  ordinal,
  title,
  error,
  required,
  htmlFor,
  en,
  children,
}: {
  ordinal: number;
  title: string;
  error?: string;
  required?: boolean;
  /** Present only where the section really is one control. */
  htmlFor?: string;
  /**
   * Passed rather than read from a context, unlike `Field`'s own copy of this.
   *
   * `Field` falls back to Arabic when it is rendered outside a
   * `FieldFlagProvider`, which is correct for a form that is Arabic by default
   * — but this wizard is rendered at `/en/` too and provides no flag context at
   * all, so an inherited default would print «(اختياري)» in the middle of an
   * English form.
   */
  en: boolean;
  children: React.ReactNode;
}) {
  return (
    /*
      The step number sits in a gutter on a desktop, and inline on a phone.

      A 36px `ps-9` gutter is cheap on a 1280px page and expensive on a 390px
      one: stacked with the page and card padding it was taking roughly a fifth
      of the screen away from the controls themselves, which is why the map
      inside step 2 rendered as a narrow strip with dead space beside it. On a
      phone the number joins the title row instead, and the section reclaims the
      full width. One element either way — `sm:absolute` lifts the same badge
      out of the flow once there is room for a gutter.
    */
    <section className="relative sm:ps-10">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {/*
            `aria-hidden`, because the number is the visual account of an order a
            screen reader already gets from the document: the sections are in the
            DOM in the order they are asked. Announcing "1" before every label would
            add a digit to each heading and no information to any of them.
          */}
          <span
            aria-hidden
            className="flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/25 bg-primary/10 text-xs font-bold tabular-nums text-primary sm:absolute sm:start-0 sm:top-0 sm:size-7"
          >
            {ordinal}
          </span>
          {htmlFor ? (
            <Label htmlFor={htmlFor} className="text-xs font-medium text-foreground/90">
              {title}
            </Label>
          ) : (
            <p className="text-xs font-medium text-foreground/90">{title}</p>
          )}
          {required ? (
            <span
              className="text-xs font-bold text-destructive"
              aria-label={en ? 'Required field' : 'حقل إلزامي'}
            >
              *
            </span>
          ) : (
            <span className="text-xs font-normal text-muted-foreground">
              {en ? '(optional)' : '(اختياري)'}
            </span>
          )}
        </div>

        {children}

        {error ? (
          <p role="alert" className="text-xs font-medium text-destructive">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
