import { createTranslator } from 'next-intl';
import type { SettlementReceipt } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';
import { FORMAT_LOCALE, type Locale } from './api-errors';
import { formatMoney } from './currency';
import { formatDateTime } from './dates';

/**
 * The WhatsApp text sent with a consolidated receipt («وصل قبض بلدي مجمّع»):
 * the municipality, the BRC number, whose bills, each bill with its amount,
 * the total, the cash handed over and the change, the day, and the office's
 * numbers.
 *
 * Never the citizen's رقم مرجعي. It is a login credential (docs/security.md),
 * the settlement's answer does not carry it, and nothing here reads it: the
 * citizen is named by name alone, so even a caller holding a fuller citizen
 * object cannot put the reference into the message. `bulk-receipt-message.test.ts`
 * holds that line.
 *
 * A plain module, not a hook, because the receipt builds the text inside a
 * click handler: a translator over its own slice of the message files, with
 * Latin digits (`FORMAT_LOCALE`), as `api-errors.ts` does.
 */

const translators = {
  ar: createTranslator({ locale: FORMAT_LOCALE.ar, messages: { whatsapp: ar.bulkSettle.whatsapp }, namespace: 'whatsapp' }),
  en: createTranslator({ locale: FORMAT_LOCALE.en, messages: { whatsapp: en.bulkSettle.whatsapp }, namespace: 'whatsapp' }),
};

/** «1,800,000 ل.ل + 40 $» — each currency through the portal's one formatter. */
function sums(totals: Record<string, number>, locale: Locale): string {
  return Object.entries(totals)
    .filter(([, amount]) => amount !== 0)
    .map(([currency, amount]) => formatMoney(amount, currency, locale))
    .join(' + ');
}

export function bulkReceiptMessage(
  receipt: SettlementReceipt,
  options: {
    locale: Locale;
    municipalityName: string;
    contactPhone?: string | null;
    officeWhatsapp?: string | null;
  },
): string {
  const { locale } = options;
  const t = translators[locale];
  const lines: Array<string | null> = [
    options.municipalityName ? t('municipality', { name: options.municipalityName }) : null,
    t('title', { number: receipt.number }),
    '',
    t('payer', { name: receipt.citizen.fullName }),
    t('items'),
    ...receipt.items.map((item) => {
      const values = {
        title: item.title,
        amount: formatMoney(item.amount, item.currency, locale),
        reversed: item.reversed ? 'yes' : 'no',
      };
      return item.invoiceNumber
        ? t('item', { ...values, invoice: item.invoiceNumber })
        : t('itemNoInvoice', values);
    }),
    t('total', { total: sums(receipt.totals, locale) }),
  ];

  const tender = receipt.tender;
  if (tender) {
    const notes: Record<string, number> = { [tender.localCurrency]: tender.local };
    if (tender.foreignCurrency && tender.foreign > 0) notes[tender.foreignCurrency] = tender.foreign;
    const handed = sums(notes, locale);
    if (handed) lines.push(t('cash', { notes: handed }));
    if (tender.foreignCurrency && tender.foreign > 0 && tender.exchangeRate) {
      lines.push(
        t('rate', {
          unit: formatMoney(1, tender.foreignCurrency, locale),
          rate: formatMoney(tender.exchangeRate, tender.localCurrency, locale),
        }),
      );
    }
    if (tender.changeGiven > 0) {
      lines.push(t('change', { change: formatMoney(tender.changeGiven, tender.localCurrency, locale) }));
    }
  }

  lines.push(
    '',
    t('date', { date: formatDateTime(receipt.occurredAt) }),
    options.contactPhone ? t('contact', { phone: options.contactPhone }) : null,
    options.officeWhatsapp ? t('officeWhatsapp', { phone: options.officeWhatsapp }) : null,
  );

  return lines.filter((line): line is string => line !== null).join('\n');
}
