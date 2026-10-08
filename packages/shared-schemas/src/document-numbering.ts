import { municipalToday } from './cash-policy';

/**
 * The numbering on every document the municipality issues.
 *
 * «INV-2610-0001» — the book, the year and month it was issued in, and a
 * counter that restarts at 0001 on the first of each month. Four books share
 * the scheme so a number read over the phone says which one it came from:
 * «ألفان وستمئة وعشرة» on its own could be either half of the same payment.
 *
 * The counter lives in `document_counters` (migration 0079) rather than a
 * Postgres sequence, because `nextval` only ever climbs and nothing resets it
 * monthly without racing whatever is drawing from it. See the migration for
 * what that costs and what it buys.
 *
 * Documents issued before 0079 keep their six-digit form («RCP-000014»). The
 * two shapes coexist deliberately: renumbering a receipt already handed to a
 * resident would make the paper in their hand disagree with the register.
 */

/** The four books, and the letters each one's numbers carry. */
export const DOCUMENT_PREFIX = {
  /** فاتورة — the bill a resident is handed. */
  INVOICE: 'INV',
  /** وصل قبض — the receipt for money actually taken. */
  RECEIPT: 'RCP',
  /** أمر صرف — an expense voucher. */
  VOUCHER: 'PV',
  /** سند مناقلة — money moved between the municipality's own wallets. */
  TRANSFER: 'TR',
} as const;

export type DocumentKind = keyof typeof DOCUMENT_PREFIX;

/**
 * «YYMM» on the municipality's own calendar — '2610' for October 2026.
 *
 * Derived from `municipalToday`, so the month turns over in Beirut rather than
 * wherever the server happens to run. A payment taken at 1am Beirut time on the
 * first belongs to the new month's book, which is what the clerk who took it
 * will say it belongs to.
 */
export function municipalPeriod(today: string = municipalToday()): string {
  // `municipalToday` is YYYY-MM-DD; the last two of the year, then the month.
  return `${today.slice(2, 4)}${today.slice(5, 7)}`;
}

/**
 * One document's number.
 *
 * Padded to four digits and never truncated: a month that somehow issues more
 * than 9,999 documents gets a five-digit counter rather than a number that
 * repeats one from earlier in the month.
 */
export function formatDocumentNumber(kind: DocumentKind, period: string, value: number): string {
  return `${DOCUMENT_PREFIX[kind]}-${period}-${String(value).padStart(4, '0')}`;
}

/**
 * Whether a string is one of our numbers, in either shape.
 *
 * Both are accepted on purpose — the six-digit form is what every document
 * issued before migration 0079 carries, and those are the ones most likely to
 * be typed in from a piece of paper.
 */
export function isDocumentNumber(value: string): boolean {
  return /^(INV|RCP|PV|TR)-(\d{4}-\d{4,}|\d{6})$/.test(value.trim());
}
