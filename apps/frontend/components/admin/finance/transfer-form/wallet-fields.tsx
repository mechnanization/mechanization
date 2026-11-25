'use client';

import { useTranslations } from 'next-intl';
import { ArrowLeftRight, Repeat2 } from 'lucide-react';
import { getLabels, type TransferKind } from '@mechanization/shared-schemas';
import type { TreasuryAccountView } from '@/lib/api-client';
import { formatTypedAmount } from '@/lib/currency';
import { Alert } from '@/components/ui/alert';
import { Field } from '@/components/ui/field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { decimalsOf } from './figures';
import { FormSection } from './form-section';
import type { RecordTransferState } from './use-record-transfer';

/**
 * Which of the two acts it is, and the wallet the money leaves and the one it
 * reaches. A new source drops a destination that no longer fits it.
 */
export function WalletFields({ form, locale }: { form: RecordTransferState; locale: string }): React.JSX.Element {
  const t = useTranslations('finance.transfers.form');
  const labels = getLabels(locale);
  const {
    wallets,
    kind,
    changeKind,
    fromId,
    setFromId,
    toId,
    setToId,
    from,
    to,
    destinations,
    setAmount,
    setFee,
    errors,
    clear,
  } = form;

  const walletOption = (account: TreasuryAccountView) => (
    <SelectItem key={account.id} value={account.id}>
      {`${account.name} · ${labels.treasuryAccountType[account.type]}`}
    </SelectItem>
  );

  return (
    <>
      <SegmentedControl
        aria-label={t('kind')}
        value={kind}
        onChange={(value) => changeKind(value as TransferKind)}
        options={[
          { value: 'SAME_CURRENCY', label: t('kinds.SAME_CURRENCY'), icon: ArrowLeftRight },
          { value: 'EXCHANGE', label: t('kinds.EXCHANGE'), icon: Repeat2 },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {kind === 'SAME_CURRENCY' ? t('kindHint.SAME_CURRENCY') : t('kindHint.EXCHANGE')}
      </p>

      <FormSection title={t('sections.wallets')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field htmlFor="transfer-fromAccountId" label={t('from')} error={errors.fromAccountId} required>
            <Select
              value={fromId}
              onValueChange={(next) => {
                setFromId(next);
                const nextFrom = wallets.find((account) => account.id === next);
                // A destination that no longer fits the source is cleared rather than kept wrong.
                if (to && (to.id === next || (nextFrom && (kind === 'SAME_CURRENCY') !== (to.currency === nextFrom.currency)))) {
                  setToId('');
                }
                setAmount((current) => formatTypedAmount(current, decimalsOf(nextFrom?.currency)));
                setFee((current) => formatTypedAmount(current, decimalsOf(nextFrom?.currency)));
                clear('fromAccountId');
              }}
            >
              <SelectTrigger id="transfer-fromAccountId">
                <SelectValue placeholder={t('walletPlaceholder')} />
              </SelectTrigger>
              <SelectContent>{wallets.map(walletOption)}</SelectContent>
            </Select>
          </Field>

          <Field htmlFor="transfer-toAccountId" label={t('to')} error={errors.toAccountId} required>
            {/* Keyed on the source, so a destination cleared above is cleared in Radix too (docs/gotchas.md). */}
            <Select
              key={`${fromId}-${kind}`}
              value={toId}
              onValueChange={(next) => {
                setToId(next);
                clear('toAccountId');
              }}
              disabled={!from}
            >
              <SelectTrigger id="transfer-toAccountId">
                <SelectValue placeholder={from ? t('walletPlaceholder') : t('fromFirst')} />
              </SelectTrigger>
              <SelectContent>{destinations.map(walletOption)}</SelectContent>
            </Select>
          </Field>
        </div>
        {from && destinations.length === 0 ? (
          <Alert variant="info">{kind === 'SAME_CURRENCY' ? t('noSameCurrency') : t('noOtherCurrency')}</Alert>
        ) : null}
      </FormSection>
    </>
  );
}
