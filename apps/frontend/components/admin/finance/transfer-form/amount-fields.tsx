'use client';

import { useTranslations } from 'next-intl';
import type { TreasuryRate } from '@/lib/api-client';
import { currencyUnit, formatTypedAmount, parseAmount } from '@/lib/currency';
import { Alert } from '@/components/ui/alert';
import { CurrencyInput } from '@/components/ui/currency-input';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { decimalsOf, percent } from './figures';
import { FormSection } from './form-section';
import type { RecordTransferState } from './use-record-transfer';

/**
 * What leaves, what the bank charges and, for an exchange, what arrives at what
 * rate, with the changer and the reason a rate far from the official one needs.
 */
export function AmountFields({
  form,
  rate,
  locale,
}: {
  form: RecordTransferState;
  rate: TreasuryRate;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.form');
  const {
    kind,
    from,
    to,
    amount,
    setAmount,
    fee,
    setFee,
    quotedRate,
    setQuotedRate,
    received,
    setReceived,
    receivedFromRate,
    typedAmount,
    short,
    judgement,
    changer,
    setChanger,
    reason,
    setReason,
    errors,
    clear,
  } = form;

  return (
    <FormSection title={t('sections.amounts')}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          htmlFor="transfer-amount"
          label={kind === 'EXCHANGE' ? t('amountSold') : t('amount')}
          error={errors.amount}
          required
        >
          <CurrencyInput
            id="transfer-amount"
            unit={from ? currencyUnit(from.currency, locale) : ''}
            value={amount}
            placeholder="0"
            invalid={Boolean(errors.amount) || short}
            onChange={(raw) => {
              const next = formatTypedAmount(raw, decimalsOf(from?.currency));
              setAmount(next);
              if (kind === 'EXCHANGE' && parseAmount(quotedRate) > 0) {
                setReceived(receivedFromRate(parseAmount(next), parseAmount(quotedRate)));
              }
              clear('amount');
            }}
          />
        </Field>

        <Field htmlFor="transfer-feeAmount" label={t('fee')} error={errors.feeAmount} optionalLabel={t('optional')}>
          <CurrencyInput
            id="transfer-feeAmount"
            unit={from ? currencyUnit(from.currency, locale) : ''}
            value={fee}
            placeholder="0"
            invalid={Boolean(errors.feeAmount)}
            onChange={(raw) => {
              setFee(formatTypedAmount(raw, decimalsOf(from?.currency)));
              clear('feeAmount');
            }}
          />
        </Field>
      </div>
      <p className="text-xs text-muted-foreground">{t('feeHint')}</p>

      {kind === 'EXCHANGE' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="transfer-rate" label={t('quotedRate')} optionalLabel={t('optional')}>
            <CurrencyInput
              id="transfer-rate"
              unit={t('rateUnit', { base: currencyUnit(rate.baseCurrency, locale) })}
              value={quotedRate}
              placeholder={rate.exchangeRate ? String(rate.exchangeRate) : '0'}
              onChange={(raw) => {
                const next = formatTypedAmount(raw, 2);
                setQuotedRate(next);
                setReceived(receivedFromRate(typedAmount, parseAmount(next)));
                clear('receivedAmount');
              }}
            />
          </Field>

          <Field htmlFor="transfer-receivedAmount" label={t('received')} error={errors.receivedAmount} required>
            <CurrencyInput
              id="transfer-receivedAmount"
              unit={to ? currencyUnit(to.currency, locale) : ''}
              value={received}
              placeholder="0"
              invalid={Boolean(errors.receivedAmount)}
              onChange={(raw) => {
                setReceived(formatTypedAmount(raw, decimalsOf(to?.currency)));
                // Typed directly, the received figure is the fact; the quoted rate no longer drives it.
                setQuotedRate('');
                clear('receivedAmount');
              }}
            />
          </Field>
        </div>
      ) : null}

      {kind === 'EXCHANGE' && judgement?.beyondTolerance ? (
        <Alert variant="warning" live="status" title={t('toleranceTitle')}>
          {t('toleranceBody', {
            deviation: percent(judgement.deviationPercent ?? 0),
            tolerance: percent(rate.tolerancePercent),
          })}
        </Alert>
      ) : null}

      {kind === 'EXCHANGE' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="transfer-changer" label={t('changer')} optionalLabel={t('optional')}>
            <Input
              id="transfer-changer"
              value={changer}
              maxLength={200}
              placeholder={t('changerPlaceholder')}
              onChange={(event) => setChanger(event.target.value)}
            />
          </Field>
          {judgement?.beyondTolerance ? (
            <Field htmlFor="transfer-adjustmentReason" label={t('adjustmentReason')} error={errors.adjustmentReason} required>
              <Input
                id="transfer-adjustmentReason"
                value={reason}
                maxLength={1000}
                placeholder={t('adjustmentPlaceholder')}
                invalid={Boolean(errors.adjustmentReason)}
                onChange={(event) => {
                  setReason(event.target.value);
                  clear('adjustmentReason');
                }}
              />
            </Field>
          ) : null}
        </div>
      ) : null}
    </FormSection>
  );
}
