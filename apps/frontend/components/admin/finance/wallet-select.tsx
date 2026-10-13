'use client';

import { useTranslations } from 'next-intl';
import type { TreasuryAccountView } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { TreasuryAmount } from './treasury-amount';
import { walletIcon } from './wallet-icon';

/**
 * «استُلم في حساب» / «يُدفع من حساب» — the wallet, as a dropdown whose every
 * option carries what that wallet holds, and under it the one line that answers
 * «هل يكفي؟»: the chosen wallet's balance once this entry is recorded, in the
 * destructive colour with its minus sign when a payment would take it below
 * zero. The words are the expense form's own alert, directly under it, which
 * also says what to do (COL-3: never colour alone); the line does not repeat
 * them. The server is still the authority: it recomputes under a row lock.
 *
 * A dropdown rather than a list of choices (decided 2026-10-12): the wallet is
 * picked once and rarely changed, and a list of five took the height the rest
 * of the form needed. The balance stays on each option, so choosing still reads
 * the figure it is chosen by. Each option shows the wallet's type icon
 * (`WALLET_ICON`), as on the balances page.
 */
export function WalletSelect({
  id,
  placeholder,
  accounts,
  value,
  onChange,
  amount,
  direction,
  locale,
  invalid,
  disabled,
}: {
  /** On the trigger: the field's label (`Field htmlFor`) names it, and a failed submit focuses it (FRM-2). */
  id: string;
  placeholder: string;
  accounts: readonly TreasuryAccountView[];
  value: string;
  onChange: (accountId: string) => void;
  /** What is being typed, in the wallet's currency; 0 while nothing valid is typed — or for a request, which moves nothing. */
  amount: number;
  /** Receiving raises the balance; paying lowers it and can run it short. */
  direction: 'in' | 'out';
  locale: string;
  invalid?: boolean;
  disabled?: boolean;
}): React.JSX.Element {
  const t = useTranslations('finance.walletPicker');
  const selected = accounts.find((account) => account.id === value);
  const after = selected ? (direction === 'in' ? selected.balance + amount : selected.balance - amount) : 0;
  const short = direction === 'out' && Boolean(selected) && amount > 0 && after < 0;

  const line = (account: TreasuryAccountView): React.JSX.Element => {
    const Icon = walletIcon(account.type);
    return (
      <span className="inline-flex min-w-0 items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{account.name}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {/* The label is read, not seen: the figure beside a wallet is plainly its balance. */}
          <span className="sr-only">{t('balance')} </span>
          <TreasuryAmount amount={account.balance} currency={account.currency} locale={locale} />
        </span>
      </span>
    );
  };

  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          aria-invalid={invalid || short || undefined}
          className={cn((invalid || short) && 'border-destructive')}
        >
          <SelectValue placeholder={placeholder}>{selected ? line(selected) : undefined}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {line(account)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && amount > 0 ? (
        <p
          className={cn(
            'flex flex-wrap items-baseline gap-x-1 text-xs',
            short ? 'font-medium text-destructive' : 'text-muted-foreground',
          )}
        >
          <span>{direction === 'in' ? t('afterIn') : t('afterOut')}</span>
          <TreasuryAmount
            amount={after}
            currency={selected.currency}
            locale={locale}
            className={cn('font-medium', !short && 'text-foreground')}
          />
        </p>
      ) : null}
    </div>
  );
}
