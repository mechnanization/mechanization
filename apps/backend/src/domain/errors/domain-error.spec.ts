import { isSpecificErrorCode } from '@mechanization/shared-schemas';
import {
  ConflictError,
  NotFoundError,
  TenantMismatchError,
  ValidationError,
} from './domain-error';

describe('DomainError', () => {
  it('carries a specific code, its params and details when thrown with one', () => {
    const error = new ConflictError({
      code: 'PAYMENT_EXCEEDS_BALANCE',
      message: 'Amount 20 exceeds the balance 10',
      params: { amount: 20, outstanding: 10 },
      details: { paymentId: 'p-1' },
    });

    expect(error.code).toBe('PAYMENT_EXCEEDS_BALANCE');
    expect(error.kind).toBe('CONFLICT');
    expect(error.message).toBe('Amount 20 exceeds the balance 10');
    expect(error.params).toEqual({ amount: 20, outstanding: 10 });
    expect(error.details).toEqual({ paymentId: 'p-1' });
    expect(error.name).toBe('ConflictError');
    expect(isSpecificErrorCode(error.code)).toBe(true);
  });

  it('falls back to its kind as the code for a prose throw, keeping the details', () => {
    const error = new ValidationError('نص', [{ path: 'phone', message: 'x' }]);

    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.kind).toBe('VALIDATION_FAILED');
    expect(error.message).toBe('نص');
    expect(error.details).toEqual([{ path: 'phone', message: 'x' }]);
    expect(error.params).toBeUndefined();
    expect(isSpecificErrorCode(error.code)).toBe(false);
  });

  it('keeps the entity form of NotFoundError', () => {
    const error = new NotFoundError('Payment', 'p-9');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe("Payment 'p-9' was not found");
  });

  it('gives the fixed tenant errors their own codes', () => {
    const error = new TenantMismatchError();
    expect(error.code).toBe('TENANT_MISMATCH');
    expect(error.kind).toBe('TENANT_MISMATCH');
  });
});
