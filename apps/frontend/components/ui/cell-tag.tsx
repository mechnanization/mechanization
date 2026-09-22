import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * A value in a table cell — the word itself, with nothing drawn around it.
 *
 * This replaces `<Badge>` everywhere a badge was being used to render a *value*
 * inside a table. Two things were wrong with that, and they are the same thing
 * seen from two sides:
 *
 *  - **The chrome outranked the data.** A `<td>` holding «سكني - تجاري» in a
 *    grey box, next to a `<td>` holding «Zone 6» as plain text, says the first
 *    one is a different *kind* of thing. It is not: both are one column's value
 *    for one row. The box was decoration that read as meaning.
 *  - **It broke the column.** A badge carries `px-2` of its own, so its text
 *    started eight pixels in from the cell's edge while the `<th>` above it sat
 *    flush. Every badge column was a column whose heading and values did not
 *    line up — visible the moment two of them sit side by side.
 *
 * So: no border, no background, no padding. The tone survives as *text* colour,
 * which is what was carrying the meaning all along — «غير صالح للسكن» in red
 * reads as fast as a red pill does, and it sits under its own heading.
 *
 * `Badge` is untouched and still right where a badge is an *annotation* rather
 * than a value: a count beside a title, «أنت» after a name in a card, a chip in
 * a list of what a backup includes.
 */
/*
 * Tokens, never raw palette colours. `--success`, `--warning` and `--info` are
 * re-declared for the dark theme, so one class is correct in both; a literal
 * `text-emerald-700` would need a `dark:` twin that somebody has to remember.
 */
const TONE = {
  /** The ordinary case: a value that is just a value. */
  neutral: 'text-foreground',
  /** Present but unremarkable — a type, a category, a frequency. */
  muted: 'text-muted-foreground',
  /** Settled, paid, active, surveyed. */
  success: 'text-success',
  /** Wants attention but is not wrong — scheduled, under review, pending. */
  warning: 'text-warning',
  /** Overdue, unsafe, failed, disabled. */
  destructive: 'text-destructive',
  /** A value the reader is being pointed at rather than warned about. */
  primary: 'text-primary',
} as const;

export type CellTone = keyof typeof TONE;

export interface CellTagProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: CellTone;
}

/**
 * `inline-flex` with a gap so a leading icon still lines up with the text —
 * several of these columns pair a glyph with a word — and `text-xs` because
 * that is the size the badges it replaces were, and the size the plain values
 * in the neighbouring columns already use. A `<span>`, so it nests inside a
 * paragraph or a flex row without closing it.
 */
function CellTag({ tone = 'neutral', className, ...props }: CellTagProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium',
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export { CellTag };
