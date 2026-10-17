'use client';

import { usePathname } from 'next/navigation';
import { formatLbp, formatMoney, isCompactable, lbpCompactParts, moneyParts } from '@/lib/currency';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';
import { cn } from '@/lib/utils';

/**
 * A sum of money on screen (PRIM-10, PRIM-11): the figure, then its unit.
 *
 * ## The figure is isolated left to right; the unit is not
 *
 * The signed figure sits in its own `<bdi dir="ltr">`, so a negative balance
 * keeps its minus on the left of the digits on an Arabic page — left to the
 * bidi algorithm, a leading minus in a right-to-left run lands on the far side
 * of the number («ل.ل 1,500,000-»). The unit stays outside it, in the page's
 * own direction, so «ل.ل» sits after the figure in reading order, on its left
 * in Arabic, exactly where it sits on every other screen (UX-1). A minus is
 * U+2212, as wide as «+», so a column of movements lines up (`moneyParts`).
 *
 * ## `wrap`
 *
 * One line by default, as a figure in a table wants. With `wrap` the unit may
 * drop under the figure when the box is too narrow for both — the treasury's
 * wallet strip at 360px, where the only alternative was cutting the figure.
 * The figure itself never breaks.
 *
 * ## `currency`
 *
 * ليرة by default. A dollar or euro figure is drawn the same way, with
 * `formatForeign`'s digits and symbol; it is never compacted.
 */
export function Money({
  amount,
  className,
  locale: propLocale,
  /** Renders the full grouped figure regardless of size. For a single row on
   *  a detail page, where there is room and the exact number is the point. */
  exact = false,
  currency = 'LBP',
  signed = false,
  wrap = false,
}: {
  amount: number;
  className?: string;
  locale?: string;
  exact?: boolean;
  /** `LBP` unless said otherwise; anything else is never compacted. */
  currency?: string;
  /** «+» before a positive figure, for a movement in a ledger. A negative one always has its minus. */
  signed?: boolean;
  /** Lets the unit drop under the figure in a narrow box, rather than the figure being cut. */
  wrap?: boolean;
}): React.JSX.Element {
  const pathname = usePathname();
  const locale = propLocale ?? (pathname?.split('/')[2] === 'en' ? 'en' : 'ar');
  const full = currency === 'LBP' ? formatLbp(amount, locale) : formatMoney(amount, currency, locale);
  const compacted = !exact && currency === 'LBP' && isCompactable(amount);
  const parts = compacted ? lbpCompactParts(amount, locale) : moneyParts(amount, currency, locale, signed);

  const figure = (
    <>
      <bdi dir="ltr" className="whitespace-nowrap">
        {parts.figure}
      </bdi>{' '}
      <span className="whitespace-nowrap">{parts.unit}</span>
    </>
  );

  // Nothing to reveal when the displayed figure is already the exact one —
  // a tooltip that repeats its own trigger is noise on every hover.
  if (!compacted) {
    return (
      <span className={cn('tabular-nums', wrap ? 'whitespace-normal' : 'whitespace-nowrap', className)}>
        {figure}
      </span>
    );
  }

  return (
    <Tooltip>
      {/*
        `title` as well as the Radix tooltip, and deliberately not instead of
        it: the tooltip does not open on a touchscreen, which is half the
        devices this dashboard is used on (the brief calls out administrative
        tablets). `title` is the one affordance that survives long-press and
        keyboard focus without a hover.
      */}
      <TooltipTrigger asChild>
        <span
          title={full}
          // `help` rather than `default`: this text does something on hover,
          // and nothing else on the row does.
          className={cn(
            'cursor-help tabular-nums decoration-dotted underline-offset-4 hover:underline',
            wrap ? 'whitespace-normal' : 'whitespace-nowrap',
            className,
          )}
        >
          {figure}
        </span>
      </TooltipTrigger>
      <TooltipContent className="tabular-nums">{full}</TooltipContent>
    </Tooltip>
  );
}
