import { describe, expect, it } from 'vitest';
import { firstFieldToFix, isExpenseField } from './expense-form';

describe('firstFieldToFix', () => {
  it('is null when nothing is wrong', () => {
    expect(firstFieldToFix({})).toBeNull();
    expect(firstFieldToFix({ amount: undefined })).toBeNull();
  });

  it('names the control of the only field with an error', () => {
    expect(firstFieldToFix({ paidOn: 'اختر تاريخاً صحيحاً' })).toBe('expense-date');
    expect(firstFieldToFix({ adjustmentReason: 'x' })).toBe('expense-adjustment');
    expect(firstFieldToFix({ invoiceNumber: 'x' })).toBe('expense-invoice');
  });

  it('takes the first in screen order, not the order the errors were found in', () => {
    expect(firstFieldToFix({ description: 'x', amount: 'x', payee: 'x' })).toBe('expense-amount');
    expect(firstFieldToFix({ invoiceNumber: 'x', accountId: 'x' })).toBe('expense-account');
  });

  it('puts the reason for an urgent payment ahead of everything, because it sits above the fields', () => {
    expect(firstFieldToFix({ amount: 'x', urgentReason: 'x' })).toBe('expense-urgent');
  });

  it('puts the invoice number before the back-dating reason, which sits under it', () => {
    // The date and the invoice number share a row; the reason appears below them once the date is in the past.
    expect(firstFieldToFix({ adjustmentReason: 'x', invoiceNumber: 'x' })).toBe('expense-invoice');
    expect(firstFieldToFix({ adjustmentReason: 'x', paidOn: 'x' })).toBe('expense-date');
  });
});

describe('isExpenseField', () => {
  it('knows the fields the form has a message for', () => {
    for (const field of [
      'urgentReason',
      'accountId',
      'amount',
      'categoryId',
      'payee',
      'description',
      'paidOn',
      'invoiceNumber',
      'adjustmentReason',
    ]) {
      expect(isExpenseField(field)).toBe(true);
    }
  });

  it('does not know what the schema checks that the officer cannot edit', () => {
    expect(isExpenseField('clientRequestId')).toBe(false);
    expect(isExpenseField('hasPhysicalReceipt')).toBe(false);
    expect(isExpenseField('')).toBe(false);
  });
});
