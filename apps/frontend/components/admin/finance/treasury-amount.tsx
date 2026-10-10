import { Money } from '@/components/ui/money';
import { formatMoney } from '@/lib/currency';
import { cn } from '@/lib/utils';

/**
 * A treasury figure in its own currency, always in full.
 *
 * ليرة goes through `Money` (PRIM-10) with `exact`: a balance read against a
 * counted safe must never be shortened to «12.5 مليون». Anything else goes
 * through `formatMoney`, which spells dollars the one way the portal does.
 */
export function TreasuryAmount({
  amount,
  currency,
  locale,
  className,
}: {
  amount: number;
  currency: string;
  locale: string;
  className?: string;
}): React.JSX.Element {
  if (currency === 'LBP') return <Money amount={amount} locale={locale} exact className={className} />;
  return (
    <span className={cn('whitespace-nowrap tabular-nums', className)}>{formatMoney(amount, currency, locale)}</span>
  );
}
