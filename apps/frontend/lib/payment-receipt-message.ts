import { formatLbp } from './currency';

/**
 * The WhatsApp text sent with a single receipt («وصل قبض»): the municipality,
 * the receipt number, the payer's name, the bill, the amount, the cash line,
 * the balance or the thank-you, the date and the office's numbers.
 *
 * Never the citizen's رقم مرجعي. It is a login credential (docs/security.md):
 * the line is gone from this message (SEC-01, 2026-11-23), it goes into a
 * `wa.me/?text=` URL that sits in the browser's history and the provider's
 * logs, and the citizen is named by name alone here, so even a caller holding
 * a fuller citizen object cannot put the reference back in — there is no
 * parameter for it. `payment-receipt-message.test.ts` holds that line, as
 * `bulk-receipt-message.test.ts` holds it for the consolidated receipt.
 */
export function paymentReceiptMessage(params: {
  municipalityName: string;
  number: string;
  payerName: string;
  title: string;
  amount: number;
  tenderLine?: string | null;
  remaining: number;
  receivedOn: string;
  contactPhone?: string | null;
  officeWhatsapp?: string | null;
}): string {
  const { municipalityName, number, payerName, title, amount, tenderLine, remaining, receivedOn, contactPhone, officeWhatsapp } =
    params;
  return [
    `بلدية ${municipalityName}`,
    `وصل قبض رقم ${number}`,
    '',
    `المكلّف: ${payerName}`,
    `البند: ${title}`,
    `المبلغ المقبوض: ${formatLbp(amount)}`,
    tenderLine ? `نقداً: ${tenderLine}` : null,
    remaining > 0 ? `الرصيد المتبقي: ${formatLbp(remaining)}` : 'تم تسديد كامل المبلغ. شكراً لكم.',
    '',
    `التاريخ: ${receivedOn}`,
    contactPhone ? `للاستفسار: ${contactPhone}` : null,
    officeWhatsapp ? `واتساب البلدية: ${officeWhatsapp}` : null,
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}
