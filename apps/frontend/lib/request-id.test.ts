import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from './api-client';
import {
  heldInDoubt,
  heldKey,
  keyIsSpent,
  markInDoubt,
  newRequestId,
  outcomeInDoubt,
  spendKey,
} from './request-id';

describe('heldKey and spendKey', () => {
  it('hold one key per act, the same each time it is asked for, until it is spent', () => {
    const first = heldKey('t1', 'expense:pay');
    expect(first).toMatch(UUID_V4);
    // What a form that unmounted and mounted again asks for: the same key.
    expect(heldKey('t1', 'expense:pay')).toBe(first);
    spendKey('t1', 'expense:pay');
    const next = heldKey('t1', 'expense:pay');
    expect(next).toMatch(UUID_V4);
    expect(next).not.toBe(first);
    spendKey('t1', 'expense:pay');
  });

  it('keeps acts apart: scopes, wallets and tenants each hold their own', () => {
    const pay = heldKey('t1', 'expense:pay');
    const request = heldKey('t1', 'expense:request');
    const ali = heldKey('t1', 'custody:wallet-a');
    const omar = heldKey('t1', 'custody:wallet-b');
    const otherTown = heldKey('t2', 'expense:pay');
    expect(new Set([pay, request, ali, omar, otherTown]).size).toBe(5);
    spendKey('t1', 'custody:wallet-a');
    expect(heldKey('t1', 'custody:wallet-b')).toBe(omar);
    expect(heldKey('t1', 'expense:pay')).toBe(pay);
    for (const scope of ['expense:pay', 'expense:request', 'custody:wallet-a', 'custody:wallet-b'] as const) spendKey('t1', scope);
    spendKey('t2', 'expense:pay');
  });

  it('gives the two screens that settle one bill the same key', () => {
    // The counter settle page and the citizen cash page both ask for `settle:<paymentId>`.
    expect(heldKey('t1', 'settle:bill-1')).toBe(heldKey('t1', 'settle:bill-1'));
    expect(heldKey('t1', 'settle:bill-1')).not.toBe(heldKey('t1', 'settle:bill-2'));
    spendKey('t1', 'settle:bill-1');
    spendKey('t1', 'settle:bill-2');
  });

  it('holds the income form and each staff member’s salary apart', () => {
    const income = heldKey('t1', 'income:new');
    const ali = heldKey('t1', 'salary:staff-ali');
    const omar = heldKey('t1', 'salary:staff-omar');
    expect(new Set([income, ali, omar, heldKey('t1', 'expense:pay')]).size).toBe(4);
    // Paying Ali is confirmed: Omar's salary dialog, still waiting on a lost answer, keeps its key.
    spendKey('t1', 'salary:staff-ali');
    expect(heldKey('t1', 'salary:staff-omar')).toBe(omar);
    expect(heldKey('t1', 'income:new')).toBe(income);
    expect(heldKey('t1', 'salary:staff-ali')).not.toBe(ali);
    for (const scope of ['income:new', 'salary:staff-ali', 'salary:staff-omar', 'expense:pay'] as const) spendKey('t1', scope);
  });

  it('spending a key nobody holds is harmless', () => {
    expect(() => spendKey('t1', 'settle:never-held')).not.toThrow();
  });
});

describe('markInDoubt and heldInDoubt', () => {
  it('marks a held key in doubt until it is spent, and the next key starts clear', () => {
    const key = heldKey('t1', 'salary:staff-ali');
    expect(heldInDoubt('t1', 'salary:staff-ali')).toBe(false);
    markInDoubt('t1', 'salary:staff-ali');
    expect(heldInDoubt('t1', 'salary:staff-ali')).toBe(true);
    // A dialog closed and opened again asks again: the key and the mark are both still there.
    expect(heldKey('t1', 'salary:staff-ali')).toBe(key);
    expect(heldInDoubt('t1', 'salary:staff-ali')).toBe(true);
    // The retry is answered (replayed, or refused as already recorded): the act is confirmed.
    spendKey('t1', 'salary:staff-ali');
    expect(heldInDoubt('t1', 'salary:staff-ali')).toBe(false);
    heldKey('t1', 'salary:staff-ali');
    expect(heldInDoubt('t1', 'salary:staff-ali')).toBe(false);
    spendKey('t1', 'salary:staff-ali');
  });

  it('keeps scopes and tenants apart', () => {
    heldKey('t1', 'expense:pay');
    heldKey('t1', 'expense:request');
    heldKey('t2', 'expense:pay');
    markInDoubt('t1', 'expense:pay');
    expect(heldInDoubt('t1', 'expense:pay')).toBe(true);
    expect(heldInDoubt('t1', 'expense:request')).toBe(false);
    expect(heldInDoubt('t2', 'expense:pay')).toBe(false);
    for (const [tenant, scope] of [['t1', 'expense:pay'], ['t1', 'expense:request'], ['t2', 'expense:pay']] as const) {
      spendKey(tenant, scope);
    }
  });

  it('marks nothing for a scope that holds no key', () => {
    // Nothing was sent under it, so there is nothing a retry could be answered from.
    markInDoubt('t1', 'salary:never-held');
    expect(heldInDoubt('t1', 'salary:never-held')).toBe(false);
  });
});

// A well-formed v4 UUID: version nibble 4, variant nibble 8/9/a/b.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function failed(status: number, code = status === 0 ? 'NETWORK_ERROR' : 'CONFLICT'): ApiRequestError {
  return new ApiRequestError(status, { code, message: 'x' });
}

describe('newRequestId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a v4 UUID, different each time', () => {
    const first = newRequestId();
    expect(first).toMatch(UUID_V4);
    expect(newRequestId()).not.toBe(first);
  });

  it('still makes one where crypto.randomUUID does not exist (plain http)', () => {
    // A municipality reaching the portal over http on its own network has no
    // `randomUUID`, so the fallback is the only path there, not an edge case.
    vi.stubGlobal('crypto', {});
    expect(newRequestId()).toMatch(UUID_V4);
  });
});

describe('keyIsSpent', () => {
  it('is true for each refusal that says the key’s act was recorded', () => {
    for (const code of [
      'TREASURY_REQUEST_KEY_REUSED',
      'EXPENSE_ALREADY_VOID',
      'INCOME_ALREADY_VOID',
      'TRANSFER_ALREADY_VOID',
      'TRANSACTION_ALREADY_REVERSED',
      'PAYMENT_IDEMPOTENCY_KEY_REUSED',
    ]) {
      expect({ code, spent: keyIsSpent(failed(409, code)) }).toEqual({ code, spent: true });
    }
  });

  it('spends an income key whose voucher was recorded and cancelled since', () => {
    // The income form's own case: an earlier press recorded RV-…, the manager voided it, and the
    // retry with the held key is refused. Keeping that key would refuse every later press too.
    const refusal = new ApiRequestError(409, {
      code: 'INCOME_ALREADY_VOID',
      message: 'x',
      params: { voucherNumber: 'RV-2610-0004' },
    });
    expect(keyIsSpent(refusal)).toBe(true);
  });

  it('keeps the key on every other refusal: it proves only that this attempt wrote nothing', () => {
    // 401 and 403 after a lost answer, 408 from a proxy, 429 from the throttler, a validation 400:
    // none of them says the earlier attempt with this key was not recorded.
    const cases: Array<[number, string]> = [
      [400, 'VALIDATION_FAILED'],
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'EXPENSE_CATEGORY_NOT_FOUND'],
      [408, 'HTTP_ERROR'],
      [409, 'TREASURY_INSUFFICIENT_FUNDS'],
      [409, 'CUSTODY_EXCEEDS_HELD'],
      [409, 'EXPENSE_REQUEST_ALREADY_DECIDED'],
      [429, 'HTTP_ERROR'],
    ];
    for (const [status, code] of cases) {
      expect({ status, code, spent: keyIsSpent(failed(status, code)) }).toEqual({ status, code, spent: false });
    }
  });

  it('keeps the key when there was no answer, or a server error: the act may have been recorded', () => {
    for (const status of [0, 500, 502, 503, 504]) {
      expect({ status, spent: keyIsSpent(failed(status)) }).toEqual({ status, spent: false });
    }
  });

  it('keeps the key for anything that is not an API answer', () => {
    expect(keyIsSpent(new Error('TREASURY_REQUEST_KEY_REUSED'))).toBe(false);
    expect(keyIsSpent(new TypeError('Failed to fetch'))).toBe(false);
    expect(keyIsSpent(null)).toBe(false);
    expect(keyIsSpent(undefined)).toBe(false);
    expect(keyIsSpent('TRANSFER_ALREADY_VOID')).toBe(false);
  });
});

describe('outcomeInDoubt', () => {
  it('is true where nothing says the money did not move', () => {
    for (const status of [0, 408, 429, 500, 502, 503, 504]) {
      expect({ status, doubt: outcomeInDoubt(failed(status)) }).toEqual({ status, doubt: true });
    }
    expect(outcomeInDoubt(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('is false for an answer that refused the attempt outright', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect({ status, doubt: outcomeInDoubt(failed(status)) }).toEqual({ status, doubt: false });
    }
  });
});
