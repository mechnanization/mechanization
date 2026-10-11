'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { Download, Loader2, MessageCircle, Printer } from 'lucide-react';
import { getLabels } from '@mechanization/shared-schemas';
import type { SettlementReceipt } from '@/lib/api-client';
import { bulkReceiptMessage } from '@/lib/bulk-receipt-message';
import { dueByCurrency, propertyLines } from '@/lib/bulk-settle';
import { currencyUnit, formatMoney } from '@/lib/currency';
import { formatDateTime } from '@/lib/dates';
import { formatPhone } from '@/lib/phone';
import { downloadFile, renderReceiptPdf, shareFile } from '@/lib/receipt-pdf';
import { buildWhatsappHref } from '@/lib/whatsapp';
import { cn } from '@/lib/utils';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/ui/money';
import { SummaryList, SummaryRow } from '@/components/ui/summary-list';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ReceiptLetterhead } from '@/components/admin/payment-receipt';
import { MoneyList } from './money-list';

/**
 * «وصل قبض بلدي مجمّع» — the consolidated receipt for several of one citizen's
 * bills settled in one press: the official heading, the BRC number with its
 * date and time, whose bills, each bill with its own «RCP-» receipt, the totals
 * per currency, the cash handed over and the change, two signatures, and a QR
 * code holding the BRC number alone.
 *
 * Everything on it is what the server recorded (`SettlementReceipt`, STA-6):
 * shown right after the settlement from the answer itself, and on a reprint
 * from `GET fees/settlements/:id`.
 *
 * Never the citizen's رقم مرجعي — a login credential (docs/security.md). The
 * answer does not carry it, and neither the paper, the PDF nor the WhatsApp
 * text (`lib/bulk-receipt-message.ts`) asks for it.
 *
 * ## Paper
 *
 * A document page (PRIM-28): the receipt is the page's one `data-print-root`,
 * printed black on white on A4 portrait over as many sheets as its bills need,
 * the table's heading row repeating. On screen it is drawn in the theme's
 * tokens like the statement; the PDF is photographed in the light theme
 * (`renderReceiptPdf`), on A4 portrait, cut between table rows. Thermal
 * printing has no layout in the portal and is not offered here.
 */
export function BulkPaymentReceipt({
  receipt,
  locale,
  municipalityName,
  governorate,
  district,
  contactPhone,
  officeWhatsapp,
  canSend,
}: {
  receipt: SettlementReceipt;
  locale: string;
  municipalityName: string;
  governorate?: string | null;
  district?: string | null;
  contactPhone?: string | null;
  officeWhatsapp?: string | null;
  /**
   * Whether «إرسال عبر واتساب» is offered (`RECEIPT_SEND_ROLES`). Required, so
   * a caller decides rather than inheriting a default that fails open.
   */
  canSend: boolean;
}): React.JSX.Element {
  const t = useTranslations('bulkSettle.receipt');
  const labels = getLabels(locale);
  const lang = locale === 'en' ? 'en' : 'ar';
  const paperRef = useRef<HTMLElement>(null);
  const [busy, setBusy] = useState<null | 'share' | 'download'>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  const { citizen, tender } = receipt;
  const phone = citizen.phone ?? citizen.whatsapp;
  const message = bulkReceiptMessage(receipt, { locale: lang, municipalityName, contactPhone, officeWhatsapp });
  const waHref = buildWhatsappHref(citizen.whatsapp ?? citizen.phone, message);
  const localCurrency = tender?.localCurrency ?? 'LBP';
  // Ordered as everywhere else: the municipality's own currency first.
  const totals = dueByCurrency(
    Object.entries(receipt.totals).map(([currency, amount]) => ({ currency, remaining: amount })),
    localCurrency,
  );

  const handlePdf = async (mode: 'share' | 'download'): Promise<void> => {
    const node = paperRef.current;
    if (!node) return;
    setBusy(mode);
    setShareNote(null);
    try {
      const file = await renderReceiptPdf(node, t('fileName', { number: receipt.number }), {
        orientation: 'portrait',
        breakBefore: 'tr',
      });
      if (mode === 'download') {
        downloadFile(file);
        return;
      }
      if (await shareFile(file, message)) return;
      // No file sharing here (most desktop browsers): the PDF is saved, and WhatsApp opens with the text.
      downloadFile(file);
      setShareNote(t('shareFallback'));
      if (waHref) window.open(waHref, '_blank', 'noopener,noreferrer');
    } catch (error) {
      console.error(error);
      setShareNote(t('pdfFailed'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          {t('print')}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          disabled={busy !== null}
          onClick={() => void handlePdf('download')}
        >
          {busy === 'download' ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <Download className="size-4" aria-hidden />
          )}
          {t('pdf')}
        </Button>
        {canSend ? (
          <Button
            type="button"
            size="sm"
            className="gap-1.5"
            disabled={busy !== null || !waHref}
            onClick={() => void handlePdf('share')}
          >
            {busy === 'share' ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <MessageCircle className="size-4" aria-hidden />
            )}
            {t('whatsapp')}
          </Button>
        ) : null}
      </div>
      {canSend && !waHref ? <p className="text-end text-xs text-muted-foreground">{t('noPhone')}</p> : null}
      {shareNote ? (
        <Alert variant="warning" live="status">
          {shareNote}
        </Alert>
      ) : null}

      <article
        ref={paperRef}
        data-print-root
        dir={lang === 'ar' ? 'rtl' : 'ltr'}
        className="mx-auto w-full max-w-3xl space-y-5 rounded-lg border bg-card p-4 text-card-foreground shadow-sm sm:p-6"
      >
        <header className="flex flex-col-reverse items-center gap-4 border-b-2 border-current pb-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            {/* The BRC number and nothing else, as plain text: a reprint is looked up by it. */}
            <QRCodeSVG value={receipt.number} size={88} level="M" marginSize={0} title={t('qr', { number: receipt.number })} />
            <div className="space-y-1">
              <h2 className="text-xl font-bold">{t('title')}</h2>
              <SummaryList>
                <SummaryRow label={t('number')} className="font-mono">
                  <span dir="ltr">{receipt.number}</span>
                </SummaryRow>
                <SummaryRow label={t('date')} className="tabular-nums">
                  <span dir="ltr">{formatDateTime(receipt.occurredAt)}</span>
                </SummaryRow>
              </SummaryList>
            </div>
          </div>
          <ReceiptLetterhead municipalityName={municipalityName} governorate={governorate} district={district} />
        </header>

        <section className="grid gap-x-6 sm:grid-cols-2">
          <SummaryList>
            <SummaryRow label={t('receivedFrom')}>{citizen.fullName}</SummaryRow>
            {citizen.fatherName ? <SummaryRow label={t('fatherName')}>{citizen.fatherName}</SummaryRow> : null}
            {phone ? (
              <SummaryRow label={t('phone')} className="tabular-nums">
                <span dir="ltr">{formatPhone(phone)}</span>
              </SummaryRow>
            ) : null}
          </SummaryList>
          <SummaryList>
            <SummaryRow label={t('method')}>
              {labels.paymentMethod[receipt.method as keyof typeof labels.paymentMethod] ?? receipt.method}
            </SummaryRow>
            {receipt.collectorName ? <SummaryRow label={t('collector')}>{receipt.collectorName}</SummaryRow> : null}
            {receipt.externalRef ? (
              <SummaryRow label={t('externalRef')} className="font-mono">
                <span dir="ltr">{receipt.externalRef}</span>
              </SummaryRow>
            ) : null}
            {receipt.recordedByName ? <SummaryRow label={t('recordedBy')}>{receipt.recordedByName}</SummaryRow> : null}
          </SummaryList>
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold">{t('items')}</h3>
          <div className="overflow-x-auto rounded-md border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>{t('colInvoice')}</TableHead>
                  <TableHead>{t('colProperty')}</TableHead>
                  <TableHead>{t('colPeriod')}</TableHead>
                  <TableHead>{t('colReceipt')}</TableHead>
                  <TableHead className="text-end">{t('colAmount')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {receipt.items.map((item) => {
                  const lines = propertyLines(item.properties);
                  // A reversed bill is struck through, and said in a word left unstruck (COL-3).
                  const struck = item.reversed ? 'line-through' : undefined;
                  return (
                    <TableRow key={item.paymentId} className="hover:bg-transparent">
                      <TableCell className="whitespace-normal py-2 align-top">
                        {item.invoiceNumber ? (
                          <bdi dir="ltr" className={cn('block font-mono text-xs font-semibold', struck)}>
                            {item.invoiceNumber}
                          </bdi>
                        ) : (
                          <span className={cn('block text-xs', struck)}>{t('none')}</span>
                        )}
                        <span className={cn('block text-xs', struck)}>{item.title}</span>
                        {item.reversed ? <span className="block text-xs font-semibold">{t('reversed')}</span> : null}
                      </TableCell>
                      <TableCell className={cn('whitespace-normal py-2 align-top text-xs', struck)}>
                        {lines.length === 0
                          ? t('none')
                          : lines.map((line) => (
                              <span key={`${line.parcel}|${line.unitType}|${line.unitCode}`} className="block">
                                {t(`property.${line.key}`, {
                                  parcel: line.parcel ?? '',
                                  type: line.unitType
                                    ? (labels.unitType[line.unitType as keyof typeof labels.unitType] ?? line.unitType)
                                    : '',
                                  code: line.unitCode ?? '',
                                })}
                              </span>
                            ))}
                      </TableCell>
                      <TableCell className={cn('py-2 align-top text-xs', struck)}>
                        {item.periodKey === 'ONCE' ? t('once') : <bdi dir="ltr">{item.periodKey}</bdi>}
                      </TableCell>
                      <TableCell className={cn('py-2 align-top', struck)}>
                        <bdi dir="ltr" className="font-mono text-xs">
                          {item.receiptNumber}
                        </bdi>
                      </TableCell>
                      <TableCell className={cn('py-2 text-end align-top', struck)}>
                        <Money amount={item.amount} currency={item.currency} locale={locale} exact />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <SummaryList>
            <SummaryRow label={t('totals')}>
              <MoneyList entries={totals} locale={locale} />
            </SummaryRow>
          </SummaryList>
        </section>

        {tender ? (
          <section className="space-y-1">
            <h3 className="text-sm font-semibold">{t('cash')}</h3>
            <SummaryList>
              <SummaryRow label={t('notesIn', { unit: currencyUnit(tender.localCurrency, locale) })}>
                <Money amount={tender.local} currency={tender.localCurrency} locale={locale} exact />
              </SummaryRow>
              {tender.foreignCurrency && tender.foreign > 0 ? (
                <SummaryRow label={t('notesIn', { unit: currencyUnit(tender.foreignCurrency, locale) })}>
                  <Money amount={tender.foreign} currency={tender.foreignCurrency} locale={locale} exact />
                </SummaryRow>
              ) : null}
              {tender.foreignCurrency && tender.foreign > 0 && tender.exchangeRate ? (
                <SummaryRow label={t('rate')} className="tabular-nums">
                  {t.rich('rateValue', {
                    unit: formatMoney(1, tender.foreignCurrency, locale),
                    rate: formatMoney(tender.exchangeRate, tender.localCurrency, locale),
                    v: (chunks) => <span dir="ltr">{chunks}</span>,
                  })}
                </SummaryRow>
              ) : null}
              <SummaryRow label={t('change')}>
                <Money amount={tender.changeGiven} currency={tender.localCurrency} locale={locale} exact />
              </SummaryRow>
            </SummaryList>
          </section>
        ) : null}

        {/* Signed by hand on the printed copy: the cashier who took the money, the accountant who checked it. */}
        <section className="grid grid-cols-2 gap-8 pt-10">
          <div className="space-y-1 border-t border-current pt-2 text-sm">
            <p className="font-semibold">{t('cashier')}</p>
            <p className="text-xs">{t('signature')}</p>
          </div>
          <div className="space-y-1 border-t border-current pt-2 text-sm">
            <p className="font-semibold">{t('accountant')}</p>
            <p className="text-xs">{t('signature')}</p>
          </div>
        </section>
      </article>
    </div>
  );
}
