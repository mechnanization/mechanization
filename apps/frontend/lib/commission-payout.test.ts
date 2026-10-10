import { describe, expect, it } from 'vitest';
import { payoutAllowance } from '@mechanization/shared-schemas';
import { ApiRequestError } from './api-client';
import { commissionScope, payoutDialogView, payoutFieldErrors, payoutKeyAfterFailure } from './commission-payout';
import { heldKey, spendKey } from './request-id';

const refused = (status: number, code: string) => new ApiRequestError(status, { code, message: 'x' });

describe('commissionScope', () => {
  it('holds one key per inspector, outliving the dialog, until it is spent', () => {
    const hassan = heldKey('t1', commissionScope('inspector-1'));
    const ali = heldKey('t1', commissionScope('inspector-2'));
    expect(ali).not.toBe(hassan);
    // The dialog closed and opened again asks for the same key, so a retry is answered from it.
    expect(heldKey('t1', commissionScope('inspector-1'))).toBe(hassan);
    spendKey('t1', commissionScope('inspector-1'));
    spendKey('t1', commissionScope('inspector-2'));
  });
});

describe('payoutKeyAfterFailure', () => {
  it('keeps the key in doubt when the answer was lost: the payout may have gone through', () => {
    // The reproduced double payout: status 0, then a fresh key paid again.
    expect(payoutKeyAfterFailure(refused(0, 'NETWORK_ERROR'))).toBe('doubt');
    expect(payoutKeyAfterFailure(refused(502, 'HTTP_ERROR'))).toBe('doubt');
    expect(payoutKeyAfterFailure(refused(408, 'HTTP_ERROR'))).toBe('doubt');
    expect(payoutKeyAfterFailure(new TypeError('Failed to fetch'))).toBe('doubt');
  });

  it('keeps the key on a refusal of this attempt alone', () => {
    expect(payoutKeyAfterFailure(refused(400, 'VALIDATION_FAILED'))).toBe('keep');
    expect(payoutKeyAfterFailure(refused(409, 'TREASURY_INSUFFICIENT_FUNDS'))).toBe('keep');
    expect(payoutKeyAfterFailure(refused(403, 'INSPECTOR_PAYOUT_MANAGER_ONLY'))).toBe('keep');
  });

  it('spends it once the server says an act exists under it', () => {
    expect(payoutKeyAfterFailure(refused(409, 'TREASURY_REQUEST_KEY_REUSED'))).toBe('spend');
    expect(payoutKeyAfterFailure(refused(409, 'EXPENSE_ALREADY_VOID'))).toBe('spend');
    expect(payoutKeyAfterFailure(refused(409, 'INSPECTOR_PAYOUT_REQUEST_REUSED'))).toBe('spend');
  });
});

describe('payoutFieldErrors', () => {
  const owed50 = payoutAllowance({ pendingBalance: 50 });
  const base = { live: true, hasAccount: true, typed: 20, allowance: owed50, short: false, retrying: false };

  it('refuses before the request what the server would refuse', () => {
    expect(payoutFieldErrors(base)).toEqual({});
    expect(payoutFieldErrors({ ...base, typed: 0 })).toEqual({ amount: 'amount' });
    expect(payoutFieldErrors({ ...base, typed: 50.01 })).toEqual({ amount: 'overOwed' });
    expect(payoutFieldErrors({ ...base, short: true })).toEqual({ amount: 'short' });
    expect(payoutFieldErrors({ ...base, hasAccount: false })).toEqual({ accountId: 'accountId' });
    expect(payoutFieldErrors({ ...base, allowance: payoutAllowance({ pendingBalance: 0 }) })).toEqual({
      amount: 'overOwed',
    });
  });

  it('does not refuse the retry of a lost press on figures that may already carry it', () => {
    // $50 owed, $50 paid by the press whose answer was lost: re-read, nothing is owed and the safe is short.
    const afterLost = { ...base, typed: 50, allowance: payoutAllowance({ pendingBalance: 0 }), short: true };
    expect(payoutFieldErrors({ ...afterLost, retrying: true })).toEqual({});
    expect(payoutFieldErrors({ ...afterLost, retrying: false })).toEqual({ amount: 'overOwed' });
  });

  it('still asks for an amount and a wallet while retrying', () => {
    expect(payoutFieldErrors({ ...base, typed: 0, retrying: true })).toEqual({ amount: 'amount' });
    expect(payoutFieldErrors({ ...base, hasAccount: false, retrying: true })).toEqual({ accountId: 'accountId' });
  });

  it('asks for no wallet before go-live', () => {
    expect(payoutFieldErrors({ ...base, live: false, hasAccount: false })).toEqual({});
  });
});

describe('payoutDialogView', () => {
  const profile = { pendingBalance: 50 };
  const overview = { active: true };

  it('keeps the form when a background re-read fails, and says so', () => {
    // The reproduced loss: a refocus read of /treasury answered 500 with the figures still cached.
    expect(payoutDialogView({ data: profile, isError: false }, { data: overview, isError: true })).toEqual({
      state: 'ready',
      profile,
      overview,
      refreshFailed: true,
    });
    expect(payoutDialogView({ data: profile, isError: true }, { data: overview, isError: false })).toMatchObject({
      state: 'ready',
      refreshFailed: true,
    });
  });

  it('gives the dialog to the error only while a read has never answered', () => {
    expect(payoutDialogView({ data: undefined, isError: true }, { data: overview, isError: false })).toEqual({
      state: 'failed',
    });
    expect(payoutDialogView({ data: profile, isError: false }, { data: undefined, isError: true })).toEqual({
      state: 'failed',
    });
    expect(payoutDialogView({ data: undefined, isError: false }, { data: overview, isError: false })).toEqual({
      state: 'loading',
    });
    expect(payoutDialogView({ data: profile, isError: false }, { data: overview, isError: false })).toEqual({
      state: 'ready',
      profile,
      overview,
      refreshFailed: false,
    });
  });
});
