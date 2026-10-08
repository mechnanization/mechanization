import {
  DOCUMENT_PREFIX,
  formatDocumentNumber,
  isDocumentNumber,
  municipalPeriod,
} from '@mechanization/shared-schemas';

/**
 * The shape of «INV-2610-0001», without a database.
 *
 * The allocator's behaviour — the reset, the locking, the block — needs real
 * Postgres and lives in `document-number.integration.spec.ts`.
 */
describe('document numbering', () => {
  describe('the period', () => {
    it('is the last two of the year and the month, on the municipality\'s calendar', () => {
      expect(municipalPeriod('2026-10-08')).toBe('2610');
      expect(municipalPeriod('2026-01-31')).toBe('2601');
      expect(municipalPeriod('2027-12-01')).toBe('2712');
    });

    /*
      The boundary that matters: the server runs in UTC and Beirut is ahead of
      it, so a payment taken just after midnight local time falls on the next
      day — and, on the first of the month, in the next month's book. The clerk
      who took it will say it belongs there.
    */
    it('turns over in Beirut, not in UTC', () => {
      expect(municipalPeriod(require('@mechanization/shared-schemas').municipalToday(
        new Date('2026-10-31T22:30:00.000Z'),
      ))).toBe('2611');
    });
  });

  describe('a number', () => {
    it('reads prefix, period, counter', () => {
      expect(formatDocumentNumber('INVOICE', '2610', 1)).toBe('INV-2610-0001');
      expect(formatDocumentNumber('RECEIPT', '2610', 42)).toBe('RCP-2610-0042');
      expect(formatDocumentNumber('VOUCHER', '2601', 999)).toBe('PV-2601-0999');
      expect(formatDocumentNumber('TRANSFER', '2712', 1000)).toBe('TR-2712-1000');
    });

    /*
      Padding widens rather than wrapping. A month that somehow issues more than
      9,999 documents gets a five-digit counter; truncating to four would print
      a number already given to a document earlier that month, which is the one
      thing a receipt book may not do.
    */
    it('widens past four digits rather than repeating one', () => {
      expect(formatDocumentNumber('RECEIPT', '2610', 10_000)).toBe('RCP-2610-10000');
    });

    it('gives each book its own letters', () => {
      expect(Object.values(DOCUMENT_PREFIX).sort()).toEqual(['INV', 'PV', 'RCP', 'TR']);
      // Four distinct prefixes, so a number read aloud says which book it is from.
      expect(new Set(Object.values(DOCUMENT_PREFIX)).size).toBe(4);
    });
  });

  describe('recognising one', () => {
    it('accepts both shapes, because the old one is still on paper', () => {
      expect(isDocumentNumber('INV-2610-0001')).toBe(true);
      expect(isDocumentNumber('RCP-000014')).toBe(true);
      expect(isDocumentNumber('  TR-2610-0001  ')).toBe(true);
    });

    it('refuses what is not one', () => {
      expect(isDocumentNumber('2610-0001')).toBe(false);
      expect(isDocumentNumber('XYZ-2610-0001')).toBe(false);
      expect(isDocumentNumber('RCP-26100001')).toBe(false);
      expect(isDocumentNumber('')).toBe(false);
    });
  });
});
