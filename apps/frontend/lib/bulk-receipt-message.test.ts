import { describe, expect, it } from 'vitest';
import type { SettlementReceipt } from '@mechanization/shared-schemas';
import { bulkReceiptMessage } from './bulk-receipt-message';

const REFERENCE = 'REF-7731-SECRET';

/**
 * A settlement as the API returns it — plus, on the citizen, the رقم مرجعي a
 * fuller citizen object would carry. The answer never has it; the point is that
 * the builder could not print it even if a caller passed one in.
 */
function receipt(overrides: Partial<SettlementReceipt> = {}): SettlementReceipt {
  const citizen = {
    id: 'citizen-a',
    fullName: 'أحمد علي',
    fatherName: 'محمد',
    phone: '+96170123456',
    whatsapp: null,
    referenceNumber: REFERENCE,
  } as SettlementReceipt['citizen'];
  return {
    id: 'settlement-1',
    number: 'BRC-2610-0001',
    occurredAt: '2026-10-10T09:30:00.000Z',
    method: 'CASH',
    citizen,
    collectorName: null,
    externalRef: null,
    recordedByName: 'سامي',
    items: [
      {
        paymentId: 'p1',
        transactionId: 't1',
        receiptNumber: 'RCP-2610-0010',
        invoiceNumber: 'INV-2610-0003',
        title: 'رسم النفايات 2026',
        periodKey: '2026',
        dueDate: '2026-03-31T00:00:00.000Z',
        properties: [{ propertyNumber: '123', unitType: 'APARTMENT', unitCode: 'A-1' }],
        amount: 900_000,
        currency: 'LBP',
        reversed: false,
      },
      {
        paymentId: 'p2',
        transactionId: 't2',
        receiptNumber: 'RCP-2610-0011',
        invoiceNumber: null,
        title: 'رسم الأرصفة',
        periodKey: 'ONCE',
        dueDate: '2025-12-31T00:00:00.000Z',
        properties: [],
        amount: 40,
        currency: 'USD',
        reversed: true,
      },
    ],
    totals: { LBP: 900_000, USD: 40 },
    tender: { local: 0, localCurrency: 'LBP', foreign: 60, foreignCurrency: 'USD', exchangeRate: 89_500, changeGiven: 890_000 },
    ...overrides,
  };
}

describe('bulkReceiptMessage', () => {
  it('names the receipt, the payer, every bill and the total', () => {
    const text = bulkReceiptMessage(receipt(), { locale: 'ar', municipalityName: 'البازورية' });
    expect(text).toContain('بلدية البازورية');
    expect(text).toContain('BRC-2610-0001');
    expect(text).toContain('أحمد علي');
    expect(text).toContain('INV-2610-0003 — رسم النفايات 2026: 900,000 ل.ل');
    // A bill raised before invoice numbers existed is named by its title; a reversed one says so.
    expect(text).toContain('رسم الأرصفة: 40 $ (معكوسة)');
    expect(text).toContain('900,000 ل.ل + 40 $');
    expect(text).toContain('الباقي المُعاد: 890,000 ل.ل');
  });

  it('never carries the رقم مرجعي, in either language', () => {
    for (const locale of ['ar', 'en'] as const) {
      const text = bulkReceiptMessage(receipt(), {
        locale,
        municipalityName: 'البازورية',
        contactPhone: '07 123 456',
        officeWhatsapp: '+96170000000',
      });
      expect(text).not.toContain(REFERENCE);
      expect(text).not.toMatch(/الرقم المرجعي|رقم مرجعي|reference/i);
    }
  });

  it('leaves out the cash lines for a settlement that was not cash', () => {
    const text = bulkReceiptMessage(
      receipt({ method: 'WHISH_MONEY', tender: null, externalRef: 'TRX-99' }),
      { locale: 'en', municipalityName: 'Bazourieh' },
    );
    expect(text).toContain('Combined municipal receipt no. BRC-2610-0001');
    expect(text).not.toContain('Received in cash');
    expect(text).not.toContain('Change handed back');
  });
});
