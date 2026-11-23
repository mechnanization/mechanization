import { describe, expect, it } from 'vitest';
import { paymentReceiptMessage } from './payment-receipt-message';

const REFERENCE = 'REF-7731-SECRET';

describe('paymentReceiptMessage', () => {
  it('names the municipality, the receipt, the payer, the bill and the amount', () => {
    const text = paymentReceiptMessage({
      municipalityName: 'البازورية',
      number: 'INV-2610-0003',
      payerName: 'أحمد علي',
      title: 'رسم النفايات 2026',
      amount: 900_000,
      remaining: 0,
      receivedOn: '10/10/2026',
    });
    expect(text).toContain('بلدية البازورية');
    expect(text).toContain('وصل قبض رقم INV-2610-0003');
    expect(text).toContain('المكلّف: أحمد علي');
    expect(text).toContain('البند: رسم النفايات 2026');
    expect(text).toContain('تم تسديد كامل المبلغ. شكراً لكم.');
    expect(text).toContain('التاريخ: 10/10/2026');
  });

  it('never carries the رقم مرجعي — there is no parameter to pass one through', () => {
    // paymentReceiptMessage takes a payer's name, never a citizen object, so
    // there is no field this call could put REFERENCE into even by mistake.
    const text = paymentReceiptMessage({
      municipalityName: 'البازورية',
      number: 'INV-2610-0003',
      payerName: 'أحمد علي',
      title: 'رسم النفايات 2026',
      amount: 900_000,
      remaining: 400_000,
      receivedOn: '10/10/2026',
      contactPhone: '07 123 456',
      officeWhatsapp: '+96170000000',
    });
    expect(text).not.toContain(REFERENCE);
    expect(text).not.toMatch(/الرقم المرجعي|رقم مرجعي|reference/i);
    expect(text).toContain('الرصيد المتبقي');
  });
});
