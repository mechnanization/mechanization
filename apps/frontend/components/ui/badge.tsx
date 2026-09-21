import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Ported from the Albazourieh platform's shadcn/ui badge, reshaped to the
 * sibling Solar system's chip: a squared `rounded-md` rather than a full pill,
 * `font-medium` rather than `font-semibold`, and a hair less horizontal padding.
 *
 * The pill shape reads as a *button* — it is the same geometry as the rounded
 * controls beside it — which is misleading on a column of status labels nobody
 * can click. Squaring it off and dropping the weight settles the badge back
 * into the row as an annotation on the data rather than an object above it.
 */
const badgeVariants = cva(
  'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground hover:bg-primary/80',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80',
        destructive:
          'border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80',
        outline: 'text-foreground',
        success: 'border-transparent bg-emerald-600 text-white hover:bg-emerald-600/80',
        warning: 'border-transparent bg-amber-500 text-white hover:bg-amber-500/80',

        /*
         * Soft variants.
         *
         * The six above are all *solid* — a saturated block carrying white
         * text. That is right for a badge appearing once beside a heading, and
         * wrong for the place badges are densest here: a column of them down a
         * table, where twenty-five solid pills out-shout every name and number
         * beside them and the eye lands on the colour instead of the row.
         *
         * These carry the same hue as a ~10% wash behind coloured text, so a
         * state still reads at a glance without competing with the data. The
         * solid set is untouched — nothing using it today changes.
         *
         * The dark-mode text steps up (`dark:text-*-400`): the 700 weights
         * that clear 4.5:1 on the cream page fall under 3:1 on a dark card.
         */
        'soft-default': 'border-transparent bg-primary/10 text-primary',
        'soft-success':
          'border-transparent bg-emerald-600/10 text-emerald-700 dark:text-emerald-400',
        'soft-warning': 'border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400',
        'soft-destructive': 'border-transparent bg-destructive/10 text-destructive',
        'soft-info': 'border-transparent bg-sky-500/10 text-sky-700 dark:text-sky-400',
        'soft-muted': 'border-transparent bg-muted text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

/**
 * Small pill: a label, a role, a count.
 *
 * A `<span>`, not the `<div>` the shadcn original uses. A badge is phrasing
 * content — it sits inside a sentence, beside a title, within a `<p>` — and a
 * `<div>` there is invalid HTML that the browser silently repairs by closing
 * the paragraph early. The repaired DOM then no longer matches what the server
 * sent, so it surfaces as a hydration error pointing at this component rather
 * than at the paragraph that actually contains it.
 *
 * `inline-flex` in `badgeVariants` already did the layout work, so nothing
 * about the rendering changes — only which element carries it.
 */
function Badge({ className, variant, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/*
 * `STATUS_BADGE_VARIANT`, `STATUS_TONE`, `STATUS_ICON` and `StatusBadge` were
 * here — the one place a طلب's review state was rendered, shared by the
 * dashboard table, the map's citizen drawer and the citizen profile page.
 *
 * Records are entered by staff now, so a filing has no state to render: it
 * exists because a clerk entered it. What is left of "status" in this product
 * is a *payment* status, and that keeps its tones next to the money it
 * describes rather than in a shared component — there is one screen for it,
 * and a generic badge serving two unrelated vocabularies is how the two drift.
 */

export { Badge, badgeVariants };
