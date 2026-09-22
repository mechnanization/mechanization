import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, OctagonAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The message a screen gives back — a refusal, a caveat, a confirmation.
 *
 * ## What this replaces
 *
 * There was no such component, so every screen wrote its own. A census of the
 * app at the time this landed found well over a hundred hand-rolled boxes: a
 * paragraph carrying `rounded-lg border border-destructive/40 bg-destructive/5
 * p-3 text-sm text-destructive`, and beside it the same idea at `rounded-md`,
 * at `p-4`, at `bg-destructive/10`, at `text-xs` — three roundings, three
 * paddings, two opacities and two text sizes for one thing, and that is only
 * the refusals.
 *
 * They drift because nothing holds them together: a screen written in March
 * copies the nearest neighbour, and the neighbour was itself a copy. Worse
 * than the inconsistency, `role="alert"` was on some and not others, so whether
 * a screen reader announced a refusal depended on which line somebody happened
 * to copy.
 *
 * ## The tones are the ones the rest of the system already has
 *
 * `success`, `warning`, `error` and `info` name the same four design tokens
 * `Badge`'s soft variants use, and the colour comes from the token — which is
 * re-declared in the `.dark` block, so there is no `dark:` half to write here
 * and none to forget.
 *
 * ## Announcing
 *
 * `role="alert"` interrupts a screen reader, which is right for something that
 * just went wrong and wrong for a note that was on the page all along. So it
 * follows the tone by default — errors and warnings announce, info and success
 * do not — and `live` overrides it either way. A static caveat rendered with
 * `live` would talk over whatever the officer was reading.
 */
const alertVariants = cva(
  'flex items-start gap-2 rounded-lg border [&>svg]:mt-0.5 [&>svg]:shrink-0',
  {
    variants: {
      tone: {
        error: 'border-destructive/40 bg-destructive/5 text-destructive',
        warning: 'border-warning/40 bg-warning/10 text-warning',
        success: 'border-success/40 bg-success/10 text-success',
        info: 'border-info/40 bg-info/10 text-info',
        /** A caveat that is not a state — the same box, in the page's own ink. */
        muted: 'border-border bg-muted/40 text-muted-foreground',
      },
      size: {
        /** Inside a card or under a field. */
        sm: 'px-3 py-2 text-xs leading-relaxed [&>svg]:size-3.5',
        /** The page's own answer to what was just pressed. */
        md: 'p-3 text-sm [&>svg]:size-4',
      },
    },
    defaultVariants: { tone: 'error', size: 'md' },
  },
);

const TONE_ICON = {
  error: OctagonAlert,
  warning: AlertTriangle,
  success: CheckCircle2,
  info: Info,
  muted: Info,
} as const;

export interface AlertProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof alertVariants> {
  /** A heading above the message, for an alert carrying more than one line. */
  title?: React.ReactNode;
  /**
   * `false` drops the icon — for a dense list of notes where five identical
   * triangles are noise rather than signal. A component may also be passed to
   * override the tone's own.
   */
  icon?: boolean | React.ComponentType<{ className?: string }>;
  /**
   * Whether assistive technology is interrupted. Defaults to the tone: an
   * error or a warning is something that just happened, info and success are
   * usually already on the page when it renders.
   */
  live?: boolean;
}

export function Alert({
  tone = 'error',
  size,
  title,
  icon = true,
  live,
  className,
  children,
  ...props
}: AlertProps): React.JSX.Element {
  const key = tone ?? 'error';
  const Glyph = typeof icon === 'boolean' ? TONE_ICON[key] : icon;
  const announces = live ?? (key === 'error' || key === 'warning');

  return (
    <div
      // `alert` is assertive on its own; the others are polite or silent.
      role={announces ? 'alert' : undefined}
      className={cn(alertVariants({ tone, size }), className)}
      {...props}
    >
      {icon === false ? null : <Glyph aria-hidden />}
      <div className="min-w-0 flex-1 space-y-0.5">
        {title ? <span className="block font-semibold">{title}</span> : null}
        {children ? (
          <div className="min-w-0 [&_a]:underline [&_a]:underline-offset-2">{children}</div>
        ) : null}
      </div>
    </div>
  );
}

export { alertVariants };
