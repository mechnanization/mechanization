import { describe, expect, it } from 'vitest';
import { REVERSAL_REASON_MAX, mayReverseReceipt, reversalReasonValid } from './bill-receipts';

describe('mayReverseReceipt', () => {
  const standing = { isReversal: false, reversed: false };

  it('offers «عكس الوصل» on a standing receipt to the manager', () => {
    expect(mayReverseReceipt(standing, 'SUPER_ADMIN')).toBe(true);
  });

  it.each(['ACCOUNTANT', 'COLLECTOR', 'AUDITOR', 'VIEWER', undefined, null])(
    'offers it to no one else (%s): the route is the manager’s',
    (role) => {
      expect(mayReverseReceipt(standing, role)).toBe(false);
    },
  );

  it('never on the opposing row, nor on a receipt already reversed', () => {
    expect(mayReverseReceipt({ isReversal: true, reversed: false }, 'SUPER_ADMIN')).toBe(false);
    expect(mayReverseReceipt({ isReversal: false, reversed: true }, 'SUPER_ADMIN')).toBe(false);
  });
});

describe('reversalReasonValid', () => {
  it('reads the box’s limit from the server’s schema', () => {
    expect(REVERSAL_REASON_MAX).toBe(500);
  });

  it('takes a reason the server takes, and refuses one it would refuse', () => {
    expect(reversalReasonValid('سُجّلت على الفاتورة الخطأ')).toBe(true);
    // Trimmed first, as the server trims it.
    expect(reversalReasonValid('  خط  ')).toBe(false);
    expect(reversalReasonValid('')).toBe(false);
    expect(reversalReasonValid('س'.repeat(501))).toBe(false);
  });
});
