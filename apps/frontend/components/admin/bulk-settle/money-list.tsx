'use client';

import { Fragment } from 'react';
import { Money } from '@/components/ui/money';

/**
 * Sums in several currencies on one line — «1,800,000 ل.ل + 40 $» — each drawn
 * by `Money` in full (PRIM-10, PRIM-11), the municipality's own currency first
 * when the caller orders them so (`dueByCurrency`). Used by the selection bar,
 * the settle dialog and the consolidated receipt.
 */
export function MoneyList({
  entries,
  locale,
  className,
}: {
  entries: ReadonlyArray<{ currency: string; amount: number }>;
  locale: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={className ?? 'inline-flex flex-wrap items-baseline gap-x-1.5'}>
      {entries.map((entry, index) => (
        <Fragment key={entry.currency}>
          {index > 0 ? <span>+</span> : null}
          <Money amount={entry.amount} currency={entry.currency} locale={locale} exact />
        </Fragment>
      ))}
    </span>
  );
}
