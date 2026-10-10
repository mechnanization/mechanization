'use client';

import { useTranslations } from 'next-intl';
import type { TransferView } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/dates';
import { tafqeetAmount } from '@/lib/tafqeet';
import { Alert } from '@/components/ui/alert';
import { SummaryList } from '@/components/ui/summary-list';
import {
  DocumentRow,
  LetterheadCrest,
  LetterheadLines,
  SignatureBlock,
  documentPrintCss,
  type MunicipalLetterhead,
} from './official-document';
import { TreasuryAmount } from './treasury-amount';

const PRINT_CSS = documentPrintCss('transfer-document', 'A4 portrait');

/** How far the rate used strays from the official one, in percent, two places. */
function deviationOf(rate: number, official: number): number {
  return Math.round((Math.abs(rate - official) / official) * 10_000) / 100;
}

/**
 * «سند تحويل داخلي» / «سند مصارفة وتبديل عملة» — one transfer on an A4 sheet,
 * to be signed by whoever handed the money over, whoever received it, and the
 * accountant.
 *
 * Every figure is the transfer's as the server holds it (STA-6). Each side is
 * printed in its own currency, in figures and in Arabic words — on an exchange
 * the two sides are different sums, and each is a figure somebody signs for.
 * An exchange also carries the rate used beside the official one and how far
 * apart they were, the صرّاف, the reason, and whether an auditor has cleared it.
 * A fee prints with the «PV-» number of the voucher that books it, which is
 * filed separately in the expense register. A cancelled transfer still prints,
 * marked cancelled above everything else.
 *
 * The wording and layout are the municipality's to confirm (docs/finance.md
 * §13.2); nothing here claims a legal form.
 */
export function TransferDocument({
  transfer,
  letterhead,
  locale,
  baseCurrency,
}: {
  transfer: TransferView;
  letterhead: MunicipalLetterhead;
  locale: string;
  /** The currency a rate is counted in: base per one unit of the other side. */
  baseCurrency: string;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.document');
  const exchange = transfer.kind === 'EXCHANGE';
  const voided = transfer.status === 'VOID';

  return (
    <article
      id="transfer-document"
      className="mx-auto w-full max-w-3xl space-y-6 rounded-lg border bg-card p-4 text-sm shadow-sm sm:p-8"
    >
      <style>{PRINT_CSS}</style>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <LetterheadLines letterhead={letterhead} />
        <LetterheadCrest crest={letterhead.crest} />
        <div className="space-y-1 text-end">
          <h2 className="text-lg font-semibold">{t(`title.${transfer.kind}`)}</h2>
          <p className="text-xs">
            {t('number')}{' '}
            {/* A document number is a code: Latin, left to right (BAN-9, RTL-2). */}
            <span dir="ltr" className="font-mono text-sm font-semibold">
              {transfer.transferNumber}
            </span>
          </p>
          <p className="text-xs">{t('dateTime', { date: formatDateTime(transfer.occurredAt) })}</p>
        </div>
      </header>

      {/* Inside the printed area on purpose: a cancelled transfer's paper must say so. */}
      {voided ? (
        <Alert variant="destructive" title={t('voidTitle')}>
          {t('voidBody', {
            date: transfer.voidedAt ? formatDate(transfer.voidedAt) : '—',
            reason: transfer.voidReason ?? '—',
          })}
        </Alert>
      ) : null}

      <section className="grid gap-4 sm:grid-cols-2">
        <Side
          title={t('fromSide')}
          wallet={transfer.from.name}
          amount={transfer.amount}
          currency={transfer.from.currency}
          locale={locale}
          struck={voided}
        />
        <Side
          title={t('toSide')}
          wallet={transfer.to.name}
          amount={transfer.receivedAmount}
          currency={transfer.to.currency}
          locale={locale}
          struck={voided}
        />
      </section>

      <SummaryList className="rounded-md border px-3">
        {transfer.fee ? (
          <DocumentRow label={t('fee')}>
            <TreasuryAmount amount={transfer.fee.amount} currency={transfer.from.currency} locale={locale} />{' '}
            <span className="text-xs text-muted-foreground">
              {t('feeVoucher')}{' '}
              <span dir="ltr" className="font-mono">
                {transfer.fee.voucherNumber}
              </span>
            </span>
          </DocumentRow>
        ) : null}
        {exchange && transfer.exchangeRate !== null ? (
          <DocumentRow label={t('rate')}>
            <TreasuryAmount amount={transfer.exchangeRate} currency={baseCurrency} locale={locale} />
          </DocumentRow>
        ) : null}
        {exchange ? (
          <DocumentRow label={t('official')}>
            {transfer.officialExchangeRate !== null ? (
              <>
                <TreasuryAmount amount={transfer.officialExchangeRate} currency={baseCurrency} locale={locale} />
                {transfer.exchangeRate !== null ? (
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    {t('deviation', {
                      deviation: deviationOf(transfer.exchangeRate, transfer.officialExchangeRate).toLocaleString('en-US'),
                    })}
                  </span>
                ) : null}
              </>
            ) : (
              t('noOfficial')
            )}
          </DocumentRow>
        ) : null}
        {transfer.moneyChangerName ? <DocumentRow label={t('changer')}>{transfer.moneyChangerName}</DocumentRow> : null}
        {transfer.adjustmentReason ? <DocumentRow label={t('rateReason')}>{transfer.adjustmentReason}</DocumentRow> : null}
        <DocumentRow label={t('description')}>{transfer.description}</DocumentRow>
        {transfer.backdateReason ? <DocumentRow label={t('backdated')}>{transfer.backdateReason}</DocumentRow> : null}
        <DocumentRow label={t('recordedBy')}>{transfer.recordedByName ?? '—'}</DocumentRow>
        {transfer.review ? (
          <DocumentRow label={t('review')}>
            {transfer.review.reviewedAt
              ? t('reviewedLine', {
                  name: transfer.review.reviewedByName ?? '—',
                  date: formatDate(transfer.review.reviewedAt),
                })
              : t('pendingLine')}
          </DocumentRow>
        ) : null}
      </SummaryList>

      <section className="grid gap-8 pt-4 sm:grid-cols-3">
        <SignatureBlock title={t('signatures.handedOver')} />
        <SignatureBlock title={t('signatures.received')} />
        <SignatureBlock title={t('signatures.accountant')} />
      </section>

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        {t('printed', { date: formatDateTime(new Date()) })}
      </footer>
    </article>
  );
}

/** One side of the move: the wallet, the figure, and the figure in words. */
function Side({
  title,
  wallet,
  amount,
  currency,
  locale,
  struck,
}: {
  title: string;
  wallet: string;
  amount: number;
  currency: string;
  locale: string;
  struck: boolean;
}): React.JSX.Element {
  const t = useTranslations('finance.transfers.document');
  const words = tafqeetAmount(amount, currency);
  return (
    <div className="min-w-0 space-y-2 rounded-md border p-4">
      <p className="text-xs text-muted-foreground">{title}</p>
      <p className="font-semibold">{wallet}</p>
      <TreasuryAmount
        amount={amount}
        currency={currency}
        locale={locale}
        className={struck ? 'text-xl font-bold line-through' : 'text-xl font-bold'}
      />
      {words ? (
        <p className="text-sm">
          <span className="text-muted-foreground">{t('inWords')}</span>{' '}
          {/* Arabic in both locales: the words are the operative figure, and they are Arabic. */}
          <span lang="ar" dir="rtl" className="font-medium">
            {words}
          </span>
        </p>
      ) : null}
    </div>
  );
}
