import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { CircleCheck, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * An inline note attached to the thing it is about: a validation refusal under
 * a form, "no exchange rate is set" inside the panel that needed one, "this
 * list was cut short" under the rows it was cut from.
 *
 * Ported from shadcn/ui's Alert, which has no Radix part, so it is plain markup
 * with `cva` (D-kit, KIT-1). It replaces the hand-rolled banner this repo had
 * 61 copies of — a `div` carrying `border-destructive/30 bg-destructive/10
 * text-destructive` and a sentence (CTL-12). `ErrorState` stays what it is: the
 * state of a *panel* that failed to load. This is a note beside content that
 * rendered.
 *
 * ## Four deviations from the shadcn source, each deliberate
 *
 * 1. **Layout, not absolute positioning.** The source pins the icon with
 *    `[&>svg]:absolute [&>svg]:left-4` and pushes the text over with `pl-7`.
 *    Both are physical, so in Arabic the icon sits over the text (RTL-1). This
 *    is a flex row with a gap, which needs no direction at all.
 * 2. **The tone is not the text colour.** The source's destructive variant
 *    paints every word `text-destructive`. Measured against this repo's tokens
 *    (WCAG 2.x, sRGB, the tint alpha-composited over `--card`), tone-coloured
 *    text on its own 10% tint reads 4.27:1 for `warning`, 4.12:1 for
 *    `destructive`, 4.38:1 for `success` and 4.11:1 for `info` in the light
 *    theme — all under COL-4's 4.5:1 floor, which is why §17.3 lists those
 *    exact pairs as failing. So the tint carries the tone, the icon carries it
 *    in colour (icons answer to 3:1, and the lowest here is 4.00:1), and every
 *    word is `foreground`: 16.5:1 or better on each tint in light, 14.2:1 or
 *    better in dark. Colour is therefore never the only signal either — there
 *    is always an icon, and a title saying what happened (COL-3).
 * 3. **`role` is a decision, not a default.** The source hardcodes
 *    `role="alert"`, which is assertive: a screen reader interrupts whatever it
 *    was reading. That is right for a refusal the user just caused and wrong
 *    for a standing note that was in the page when it loaded. `live` picks:
 *    `alert` for a validation error (FRM-2), `status` for something that
 *    changed after a read (A11Y-5), and the default `none` for a note that was
 *    always there.
 * 4. **No `default` grey variant.** A note with no tone is a paragraph; it does
 *    not need a box. The four variants are the four meanings COL-2 fixes.
 *
 * Every string is the caller's (KIT-6): `title` and the children are passed in,
 * and the icon is `aria-hidden`, so there is nothing here to translate.
 */
const alertVariants = cva('flex w-full items-start gap-3 rounded-lg border p-3 text-start', {
  variants: {
    variant: {
      info: 'border-info/30 bg-info/10',
      success: 'border-success/30 bg-success/10',
      warning: 'border-warning/30 bg-warning/10',
      destructive: 'border-destructive/30 bg-destructive/10',
    },
  },
  defaultVariants: { variant: 'info' },
});

/** The icon colour only — see deviation 2. `warning` is a tint and a mark, never a fill (COL-2). */
const iconVariants = cva('mt-0.5 size-4 shrink-0', {
  variants: {
    variant: {
      info: 'text-info',
      success: 'text-success',
      warning: 'text-warning',
      destructive: 'text-destructive',
    },
  },
  defaultVariants: { variant: 'info' },
});

/** The mark that says which kind of note this is without reading it (COL-3). */
const DEFAULT_ICON = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  destructive: CircleAlert,
} as const;

type AlertVariant = NonNullable<VariantProps<typeof alertVariants>['variant']>;

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof alertVariants> {
  /** The one line that says what happened. Optional: a one-sentence note needs no heading. */
  title?: React.ReactNode;
  /** Overrides the variant's own mark. `null` draws none. */
  icon?: React.ComponentType<{ className?: string }> | null;
  /**
   * How loudly a screen reader says it. `alert` interrupts and is for a refusal
   * the user just caused; `status` is polite and is for something that changed
   * after the page settled; `none` is for a note that was already there.
   */
  live?: 'alert' | 'status' | 'none';
}

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  ({ className, variant, title, icon, live = 'none', children, ...props }, ref) => {
    const tone: AlertVariant = variant ?? 'info';
    const Icon = icon === null ? null : (icon ?? DEFAULT_ICON[tone]);

    return (
      <div
        ref={ref}
        role={live === 'none' ? undefined : live}
        className={cn(alertVariants({ variant }), className)}
        {...props}
      >
        {Icon ? <Icon className={iconVariants({ variant })} aria-hidden /> : null}
        <div className="min-w-0 flex-1 space-y-1">
          {title ? <AlertTitle>{title}</AlertTitle> : null}
          {children ? <AlertDescription>{children}</AlertDescription> : null}
        </div>
      </div>
    );
  },
);
Alert.displayName = 'Alert';

/**
 * The note's heading. `p`, not `h5`: shadcn uses a heading element, but an
 * alert is not a section of the document and a stray `h5` breaks the page's
 * heading outline (A11Y-3).
 */
const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p ref={ref} className={cn('text-sm font-semibold leading-snug text-foreground', className)} {...props} />
  ),
);
AlertTitle.displayName = 'AlertTitle';

/** The body. `foreground`, not `muted-foreground`, which lands at 4.44:1 on a tint over the page surface. */
const AlertDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn('text-sm leading-relaxed text-foreground', className)} {...props} />
  ),
);
AlertDescription.displayName = 'AlertDescription';

export { Alert, AlertDescription, AlertTitle, alertVariants };
