import { Money } from '@/components/ui/money';

/**
 * A treasury figure in its own currency, always in full.
 *
 * Drawn by `Money` with `exact`: a balance read against a counted safe must
 * never be shortened to «12.5 مليون». Through `Money` rather than a string of
 * its own, so «ل.ل» sits where it does on every other screen (UX-1) and one
 * minus sign, U+2212, runs through every treasury table: `Money` isolates the
 * signed figure left to right, which is what keeps a negative balance's minus
 * on the left of its digits on an Arabic page.
 *
 * `signed` puts «+» on money that came in, for a ledger's movement column.
 * `wrap` lets the unit drop under the figure in a narrow box — a wallet in the
 * 360px strip — rather than the figure being cut.
 */
export function TreasuryAmount({
  amount,
  currency,
  locale,
  className,
  signed = false,
  wrap = false,
}: {
  amount: number;
  currency: string;
  locale: string;
  className?: string;
  signed?: boolean;
  wrap?: boolean;
}): React.JSX.Element {
  return (
    <Money
      amount={amount}
      currency={currency}
      locale={locale}
      exact
      signed={signed}
      wrap={wrap}
      className={className}
    />
  );
}
