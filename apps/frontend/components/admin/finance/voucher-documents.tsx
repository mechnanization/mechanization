'use client';

import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import type { ExpenseVoucherView, IncomeVoucherView } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/dates';
import { tafqeetAmount } from '@/lib/tafqeet';
import { Alert } from '@/components/ui/alert';
import { SummaryList } from '@/components/ui/summary-list';
import {
  DocumentRow as Row,
  LetterheadCrest,
  LetterheadLines,
  SignatureBlock,
  documentPrintCss,
  type MunicipalLetterhead,
} from './official-document';
import { TreasuryAmount } from './treasury-amount';

/** One voucher to a sheet, read top to bottom: portrait. */
const PRINT_CSS = documentPrintCss('voucher-document', 'A4 portrait');

/**
 * «أمر صرف / حوالة دفع بلدية» — the printed payment order for one «PV-»
 * voucher: a supplier's invoice, a salary, an inspector's commission.
 *
 * Every figure and name is the voucher's as the server holds it (STA-6): the
 * number, the day, the payee as written that day, the بند with its budget
 * chapter and article, the wallet it left. The amount is printed in figures and
 * in words, and the words are the operative figure on a Lebanese municipal
 * document, which is why they come from `tafqeetAmount` and never from a
 * second converter. A cancelled voucher still prints — an auditor asks for
 * it — but says so above everything else, on screen and on paper.
 *
 * Three signatures: the accountant who prepared it, the head of municipality
 * who authorises spending, and the beneficiary acknowledging receipt. The
 * wording and the layout are the municipality's to confirm (docs/finance.md
 * §13.2); nothing here claims a legal form.
 */
export function ExpenseVoucherDocument({
  voucher,
  letterhead,
  locale,
}: {
  voucher: ExpenseVoucherView;
  letterhead: MunicipalLetterhead;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.vouchers');
  const tp = useTranslations('finance.vouchers.payment');

  return (
    <VoucherSheet
      title={tp('title')}
      number={voucher.voucherNumber}
      dateLine={t('issuedOn', { date: formatDate(voucher.occurredAt) })}
      letterhead={letterhead}
      voided={voucher.status === 'VOID' ? { at: voucher.voidedAt, reason: voucher.voidReason } : null}
      amount={voucher.amount}
      currency={voucher.currency}
      locale={locale}
    >
      <SummaryList className="rounded-md border px-3">
        <Row label={tp('payee')}>
          <span className="font-semibold">{voucher.payee}</span>
        </Row>
        <Row label={t('category')}>{voucher.category.name}</Row>
        <Row label={t('budget')}>
          <BudgetCodes chapter={voucher.category.chapterCode} item={voucher.category.itemCode} />
        </Row>
        <Row label={tp('paidFrom')}>{voucher.account.name}</Row>
        <Row label={t('description')}>{voucher.description}</Row>
        {voucher.invoiceNumber ? (
          <Row label={tp('invoice')}>
            <bdi>{voucher.invoiceNumber}</bdi>
          </Row>
        ) : null}
        {voucher.adjustmentReason ? <Row label={t('backdated')}>{voucher.adjustmentReason}</Row> : null}
        <Row label={t('recordedBy')}>{voucher.recordedByName ?? '—'}</Row>
      </SummaryList>

      <section className="grid gap-8 pt-4 sm:grid-cols-3">
        <SignatureBlock title={tp('signatures.accountant')} />
        <SignatureBlock title={tp('signatures.mayor')} />
        <SignatureBlock title={tp('signatures.beneficiary')} note={tp('signatures.beneficiaryNote')} />
      </section>
    </VoucherSheet>
  );
}

/**
 * «سند قبض إيرادات بلدية» — the printed receipt for one «RV-» voucher, to hand
 * to whoever paid: a permit fee, the Independent Municipal Fund, a donation.
 *
 * As `ExpenseVoucherDocument`, plus the time it was received and a QR code.
 * The code carries the voucher number and nothing else (docs/finance.md §13.1,
 * assumption 3): there is no public page to verify it against — that would be
 * a new unauthenticated surface — so it is a quick way to type the number into
 * the register's search, not a seal.
 */
export function IncomeVoucherDocument({
  voucher,
  letterhead,
  locale,
}: {
  voucher: IncomeVoucherView;
  letterhead: MunicipalLetterhead;
  locale: string;
}): React.JSX.Element {
  const t = useTranslations('finance.vouchers');
  const tr = useTranslations('finance.vouchers.receipt');
  const category = locale === 'en' ? voucher.category.labelEn || voucher.category.labelAr : voucher.category.labelAr;

  return (
    <VoucherSheet
      title={tr('title')}
      number={voucher.voucherNumber}
      dateLine={t('issuedAt', { date: formatDateTime(voucher.occurredAt) })}
      letterhead={letterhead}
      voided={voucher.status === 'VOID' ? { at: voucher.voidedAt, reason: voucher.voidReason } : null}
      amount={voucher.amount}
      currency={voucher.currency}
      locale={locale}
      code={
        <figure className="flex flex-col items-center gap-1.5">
          {/* Fixed dark on light, whatever the theme: a scanner reads contrast, not tokens (COL-9). */}
          <div className="rounded-md border bg-white p-2">
            <QRCodeSVG value={voucher.voucherNumber} size={88} level="M" bgColor="#ffffff" fgColor="#000000" />
          </div>
          <figcaption className="text-xs text-muted-foreground">{tr('qrCaption')}</figcaption>
        </figure>
      }
    >
      <SummaryList className="rounded-md border px-3">
        <Row label={tr('payer')}>
          <span className="font-semibold">{voucher.payerName || '—'}</span>
        </Row>
        <Row label={t('category')}>{category}</Row>
        <Row label={t('budget')}>
          <BudgetCodes chapter={voucher.category.chapterCode} item={voucher.category.itemCode} />
        </Row>
        <Row label={tr('receivedInto')}>{voucher.account.name}</Row>
        <Row label={t('description')}>{voucher.description}</Row>
        {voucher.externalReference ? (
          <Row label={tr('reference')}>
            <bdi>{voucher.externalReference}</bdi>
          </Row>
        ) : null}
        {voucher.adjustmentReason ? <Row label={t('backdated')}>{voucher.adjustmentReason}</Row> : null}
        <Row label={t('recordedBy')}>{voucher.recordedByName ?? '—'}</Row>
      </SummaryList>

      <section className="grid gap-8 pt-4 sm:grid-cols-2">
        <SignatureBlock title={tr('signatures.cashier')} />
        <SignatureBlock title={tr('signatures.accountant')} />
      </section>
    </VoucherSheet>
  );
}

/** What both vouchers share: the letterhead, the number, the cancellation, the amount in figures and words. */
function VoucherSheet({
  title,
  number,
  dateLine,
  letterhead,
  voided,
  amount,
  currency,
  locale,
  code,
  children,
}: {
  title: string;
  number: string;
  dateLine: string;
  letterhead: MunicipalLetterhead;
  voided: { at: string | null; reason: string | null } | null;
  amount: number;
  currency: string;
  locale: string;
  /** Printed beside the amount: the receipt's QR code. */
  code?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const t = useTranslations('finance.vouchers');
  const words = tafqeetAmount(amount, currency);

  return (
    <article
      id="voucher-document"
      className="mx-auto w-full max-w-3xl space-y-6 rounded-lg border bg-card p-4 text-sm shadow-sm sm:p-8"
    >
      <style>{PRINT_CSS}</style>

      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <LetterheadLines letterhead={letterhead} />
        <LetterheadCrest crest={letterhead.crest} />
        <div className="space-y-1 text-end">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-xs">
            {t('number')}{' '}
            {/* A document number is a code: Latin, left to right (BAN-9, RTL-2). */}
            <span dir="ltr" className="font-mono text-sm font-semibold">
              {number}
            </span>
          </p>
          <p className="text-xs">{dateLine}</p>
        </div>
      </header>

      {/* Inside the printed area on purpose: a cancelled voucher's paper must say so. */}
      {voided ? (
        <Alert variant="destructive" title={t('voidTitle')}>
          {t('voidBody', { date: voided.at ? formatDate(voided.at) : '—', reason: voided.reason ?? '—' })}
        </Alert>
      ) : null}

      <section className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1 space-y-2 rounded-md border p-4">
          <p className="text-xs text-muted-foreground">{t('amount')}</p>
          <TreasuryAmount
            amount={amount}
            currency={currency}
            locale={locale}
            className={voided ? 'text-2xl font-bold line-through' : 'text-2xl font-bold'}
          />
          {words ? (
            <p className="text-sm">
              <span className="text-muted-foreground">{t('amountInWords')}</span>{' '}
              {/* Arabic in both locales: the words are the operative figure, and they are Arabic. */}
              <span lang="ar" dir="rtl" className="font-medium">
                {words}
              </span>
            </p>
          ) : null}
        </div>
        {code}
      </section>

      {children}

      <footer className="border-t pt-3 text-xs text-muted-foreground">
        {t('printed', { date: formatDateTime(new Date()) })}
      </footer>
    </article>
  );
}

/** «الباب 12 — البند 320», or a plain statement that the municipality has not coded this بند yet. */
function BudgetCodes({ chapter, item }: { chapter: string | null; item: string | null }): React.JSX.Element {
  const t = useTranslations('finance.vouchers');
  if (!chapter || !item) return <span className="text-muted-foreground">{t('noBudgetCodes')}</span>;
  return (
    <span>
      {t('budgetCodes', { chapter, item })}
    </span>
  );
}
