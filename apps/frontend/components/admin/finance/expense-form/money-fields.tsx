'use client';

import { useTranslations } from 'next-intl';
import { Send } from 'lucide-react';
import type { TreasuryAccountView } from '@/lib/api-client';
import { currencyUnit, formatTypedAmount } from '@/lib/currency';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { WalletSelect } from '../wallet-select';
import type { RecordExpenseState } from './use-record-expense';

/**
 * The figure and the wallet it leaves, with what each of them stops: the urgent
 * ceiling under the figure, the shortage under the wallet. Two cells of the
 * form's grid.
 */
export function MoneyFields({
  form,
  accounts,
  locale,
}: {
  form: RecordExpenseState;
  accounts: TreasuryAccountView[];
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.expenses.form');
  const {
    mode,
    pays,
    errors,
    account,
    amount,
    setAmount,
    accountId,
    setAccountId,
    spending,
    short,
    overCeiling,
    retrying,
    refusesOverCeiling,
    refusedOverCeiling,
    ceilingText,
    choose,
    done,
  } = form;

  return (
    <>
      {/* The figure is the point of the task: typed first, in the heaviest type of the form (PRIM-25). */}
      <div className="space-y-2">
        <Field htmlFor="expense-amount" label={t('amount')} error={errors.amount} required>
          <CurrencyInput
            id="expense-amount"
            unit={account ? currencyUnit(account.currency, locale) : ''}
            value={amount}
            placeholder="0"
            invalid={Boolean(errors.amount) || short || refusesOverCeiling}
            /*
              The height of every other field (40px, 48px on a touch screen); the
              figure in a larger, heavier type. `Input` sets `text-base sm:text-sm`,
              and tailwind-merge keeps a `sm:` class against an unprefixed one: the
              size is given at both breakpoints or it falls back to 14px from 640px.
            */
            inputClassName="text-lg font-semibold sm:text-lg"
            onChange={(value) => setAmount(formatTypedAmount(value, account?.currency === 'LBP' ? 0 : 2))}
          />
        </Field>

        {/*
          Above the ceiling — as typed, or as the server judged it — the way on is
          the request: one press switches to it and keeps what was typed. Under the
          figure it is about, so it is on screen while the figure is typed. Not
          while a lost press may have paid it: then the way on is the same press
          again, which the server answers from its key. Gone once the act is
          recorded: a replay spends the key, and the composer mounts a fresh form.
        */}
        {done ? null : overCeiling && retrying && !refusedOverCeiling ? (
          <Alert variant="warning" live="status" title={t('ceiling.overTitle')}>
            {t('ceiling.inDoubtBody', { ceiling: ceilingText })}
          </Alert>
        ) : (overCeiling || refusedOverCeiling) && mode === 'URGENT' ? (
          <Alert variant="warning" live="status" title={t('ceiling.overTitle')}>
            <div className="space-y-2">
              <p>{overCeiling ? t('ceiling.overBody', { ceiling: ceilingText }) : t('ceiling.refusedBody')}</p>
              <Button type="button" size="sm" variant="outline" disabled={done} onClick={() => choose('REQUEST')}>
                <Send className="size-4" aria-hidden />
                {t('ceiling.sendAsRequest')}
              </Button>
            </div>
          </Alert>
        ) : null}
      </div>

      <div className="space-y-2">
        <Field htmlFor="expense-account" label={t('account')} error={errors.accountId} required>
          <WalletSelect
            id="expense-account"
            placeholder={t('accountPlaceholder')}
            accounts={accounts}
            value={accountId}
            onChange={setAccountId}
            // A request moves nothing yet: its wallet shows what it holds, not what it would.
            amount={pays ? spending : 0}
            direction="out"
            locale={locale}
            invalid={Boolean(errors.accountId)}
            disabled={done}
          />
        </Field>
        {mode === 'REQUEST' ? <p className="text-xs text-muted-foreground">{t('requestNote')}</p> : null}
        {short ? (
          <Alert variant="destructive" live="status" title={t('shortTitle')}>
            {t('shortBody')}
          </Alert>
        ) : null}
      </div>
    </>
  );
}
