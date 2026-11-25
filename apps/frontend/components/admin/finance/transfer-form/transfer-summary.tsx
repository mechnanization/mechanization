'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { TreasuryRate } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { TreasuryAmount } from '../treasury-amount';
import { percent } from './figures';
import type { RecordTransferState } from './use-record-transfer';

/**
 * The summary, sticky beside the fields: both wallets before and after, the rate
 * against the official one, what would stop or flag the act, and the two actions.
 * Below `lg` it falls under the fields, directly above the button it qualifies.
 */
export function TransferSummary({
  form,
  rate,
  locale,
  backHref,
}: {
  form: RecordTransferState;
  rate: TreasuryRate;
  locale: string;
  /** Where «إلغاء» goes. */
  backHref: string;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.form');
  const {
    kind,
    from,
    to,
    leaving,
    sourceAfter,
    destinationAfter,
    typedReceived,
    short,
    retrying,
    legs,
    judgement,
    busy,
    done,
  } = form;

  return (
    <aside className="lg:sticky lg:top-6 lg:h-[calc(100dvh-6.5rem)]">
      <Card className={cn('flex h-full flex-col', short && 'border-destructive/30')}>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <h2 className="text-sm font-semibold">{t('summaryTitle')}</h2>

          {from ? (
            <SummaryList>
              <SummaryRow label={t('summarySource', { name: from.name })}>
                <TreasuryAmount amount={from.balance} currency={from.currency} locale={locale} />
              </SummaryRow>
              <SummaryRow label={t('summaryLeaving')}>
                <TreasuryAmount amount={leaving} currency={from.currency} locale={locale} />
              </SummaryRow>
              <SummaryRow label={t('summaryAfter')} className={cn(short && 'text-destructive')}>
                <TreasuryAmount amount={sourceAfter} currency={from.currency} locale={locale} />
              </SummaryRow>
            </SummaryList>
          ) : (
            <p className="text-sm text-muted-foreground">{t('summaryEmpty')}</p>
          )}

          {to ? (
            <SummaryList className="border-t pt-1">
              <SummaryRow label={t('summaryDestination', { name: to.name })}>
                <TreasuryAmount amount={to.balance} currency={to.currency} locale={locale} />
              </SummaryRow>
              <SummaryRow label={t('summaryArriving')}>
                <TreasuryAmount amount={typedReceived} currency={to.currency} locale={locale} />
              </SummaryRow>
              <SummaryRow label={t('summaryAfter')}>
                <TreasuryAmount amount={destinationAfter} currency={to.currency} locale={locale} />
              </SummaryRow>
            </SummaryList>
          ) : null}

          {kind === 'EXCHANGE' && from && to ? (
            <SummaryList className="border-t pt-1">
              {/* A rate is an amount of the base currency per one unit of the other: «89,500 ل.ل». */}
              <SummaryRow label={t('summaryRate')}>
                {legs ? <TreasuryAmount amount={legs.rate} currency={rate.baseCurrency} locale={locale} /> : '—'}
              </SummaryRow>
              <SummaryRow label={t('summaryOfficial')}>
                {rate.exchangeRate ? (
                  <TreasuryAmount amount={rate.exchangeRate} currency={rate.baseCurrency} locale={locale} />
                ) : (
                  t('noOfficialRate')
                )}
              </SummaryRow>
              {judgement?.deviationPercent !== null && judgement?.deviationPercent !== undefined ? (
                <SummaryRow
                  label={t('summaryDeviation')}
                  className={cn('tabular-nums', judgement.beyondTolerance && 'text-warning')}
                >
                  {`${percent(judgement.deviationPercent)}%`}
                </SummaryRow>
              ) : null}
            </SummaryList>
          ) : null}

          {short ? (
            <Alert variant={retrying ? 'warning' : 'destructive'} live="status" title={t('shortTitle')}>
              {retrying ? t('shortInDoubt') : t('shortBody')}
            </Alert>
          ) : null}

          {judgement?.requiresReview ? (
            <Alert variant="info" title={t('reviewTitle')}>
              {judgement.noOfficialRate
                ? t('reviewNoRate')
                : judgement.large && !judgement.beyondTolerance
                  ? t('reviewLarge', { threshold: rate.largeExchangeThreshold })
                  : t('reviewTolerance')}
            </Alert>
          ) : null}

          {/* `mt-auto` pushes the actions to the foot of a panel taller than its content. */}
          <div className="mt-auto flex flex-col gap-2 pt-2">
            <Button type="submit" disabled={busy || done || (short && !retrying)}>
              {busy ? t('saving') : kind === 'EXCHANGE' ? t('submitExchange') : t('submit')}
            </Button>
            <Button asChild type="button" variant="outline" disabled={busy}>
              <Link href={backHref}>{t('cancel')}</Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    </aside>
  );
}
