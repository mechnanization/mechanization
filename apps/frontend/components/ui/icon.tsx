import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One size scale and one accessibility rule for every icon in the app.
 *
 * ## What it standardises, and what it deliberately does not
 *
 * Icons were imported straight from `lucide-react` at the point of use and
 * sized by hand — `size-3.5`, `size-4`, `size-5`, `h-4 w-4`, sometimes with a
 * colour, usually with `aria-hidden`, occasionally without. The size is the
 * part that drifts: a 3.5 beside a 4 in the same row is visible, and nothing
 * stops the next one being a 5.
 *
 * So this takes the icon as a prop rather than owning a registry of names. A
 * central `<Icon name="user" />` would mean one module importing every glyph
 * the app might ever use, which defeats tree-shaking and puts the whole set in
 * every bundle — a real cost on a phone in the field, for a cosmetic gain. The
 * import stays where the icon is used; what is centralised is how big it is,
 * what colour it takes, and whether it is announced.
 *
 * ## Colour is inherited, on purpose
 *
 * No `tone` prop. An icon beside text belongs to that text and should take its
 * colour from it — which is what `currentColor` already does — so a destructive
 * button's icon turns with the button and a muted row's icon with the row. A
 * `tone` would let the two drift apart, which is the bug it would look like it
 * was preventing.
 *
 * ## Announced or not
 *
 * Decorative by default, because nearly every icon here sits beside the words
 * it illustrates and a screen reader reading both says everything twice. An
 * icon that is the only thing in a control — a ⋯ menu, a close button — is the
 * exception, and passing `label` makes it an `img` with a name.
 */
const SIZES = {
  /** Inline with small print: a chip, a table cell's annotation. */
  xs: 'size-3.5',
  /** The default. Buttons, menu rows, field affixes. */
  sm: 'size-4',
  /** A section heading, an empty state's hint. */
  md: 'size-5',
  /** A page header's tile, a state illustration. */
  lg: 'size-6',
  /** Only where the icon is the subject — a 404, an empty table. */
  xl: 'size-10',
} as const;

export type IconSize = keyof typeof SIZES;

export function Icon({
  as: Glyph,
  size = 'sm',
  label,
  className,
}: {
  /** The glyph itself, e.g. `UserRound` from `lucide-react`. */
  as: React.ComponentType<{ className?: string }>;
  size?: IconSize;
  /**
   * What it means, when it is not beside the words that already say so. Given
   * one, the icon stops being decorative and is announced under this name.
   */
  label?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span
      // `shrink-0` here rather than on every caller: an icon squashed by a long
      // label beside it in a flex row was the commonest of these bugs.
      className={cn('inline-flex shrink-0', SIZES[size], className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* The span above carries the role or hides the subtree; the glyph is plain. */}
      <Glyph className="size-full" />
    </span>
  );
}
