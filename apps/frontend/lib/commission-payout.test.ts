import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { payoutAllowance } from '@mechanization/shared-schemas';
import { ApiRequestError } from './api-client';
import {
  commissionScope,
  payoutDialogView,
  payoutFieldErrors,
  payoutKeyAfterFailure,
  payoutRequest,
} from './commission-payout';
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

describe('payoutRequest', () => {
  const press = {
    amount: 200,
    accountId: 'wallet-usd',
    paidOn: '2026-10-09',
    note: ' عمولة أيلول ',
    reference: '',
    clientRequestId: 'key-1',
  };

  it('sends a wallet and no date once live', () => {
    expect(payoutRequest({ ...press, live: true })).toEqual({
      amount: 200,
      currency: 'USD',
      accountId: 'wallet-usd',
      note: 'عمولة أيلول',
      reference: undefined,
      clientRequestId: 'key-1',
    });
  });

  /*
    Review of 2026-10-11: before go-live the request carried no key, so a payout
    whose answer was lost, pressed again, was recorded twice (owed 500 → 100 for
    one $200 handover). The server answers a retry from the key since 0089.
  */
  it('carries the held key before go-live too, with the picked day and no wallet', () => {
    const request = payoutRequest({ ...press, live: false });
    expect(request).toMatchObject({ amount: 200, currency: 'USD', note: 'عمولة أيلول', clientRequestId: 'key-1' });
    expect(request.accountId).toBeUndefined();
    // Midday of the picked day, so no timezone moves it to the day before.
    expect(request.paidAt).toBe(new Date('2026-10-09T12:00:00').toISOString());
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
    expect(payoutKeyAfterFailure(refused(403, 'COMMISSION_SELF_PAYOUT'))).toBe('keep');
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

/**
 * The dialog itself follows the rules above (STA-1, STA-4).
 *
 * The component is not rendered here (this suite collects `lib/**` and runs
 * without a DOM), so, as `print-pages.test.ts` does for the print pages, it is
 * read. The helpers above decide; this checks the dialog asks them, rather than
 * the shape it had before: a fresh `crypto.randomUUID()` per failure, a key
 * held in a `useRef` that died with the form, and the error checked before the
 * data — the three that paid a commission twice (PR #109 review).
 */
describe('the payout dialog', () => {
  const source = readFileSync(join(__dirname, '..', 'components', 'admin', 'inspector-payout-dialog.tsx'), 'utf8');

  it('sends the key held for this inspector, minted nowhere else', () => {
    expect(source).toMatch(/clientRequestId:\s*heldKey\(tenant,\s*scope\)/);
    expect(source).toMatch(/const scope = commissionScope\(staff\.id\)/);
    expect(source).not.toMatch(/randomUUID|newRequestId/);
    // One builder for both shapes, so the key cannot be left off the figure-only one again.
    expect(source).toMatch(/payoutRequest\(\{/);
  });

  it('holds a lost press in doubt before go-live as after, so the figures it lowered do not refuse its retry', () => {
    expect(source).toMatch(/heldInDoubt\(tenant,\s*scope\)/);
    expect(source).not.toMatch(/live\s*&&\s*heldInDoubt/);
  });

  it('decides what a failure does to the key through payoutKeyAfterFailure, and marks a lost answer in doubt', () => {
    expect(source).toMatch(/payoutKeyAfterFailure\(caught\)/);
    expect(source).toMatch(/markInDoubt\(tenant,\s*scope\)/);
  });

  it('locks the form after a 2xx', () => {
    expect(source).toMatch(/setDone\(true\)/);
    expect(source).toMatch(/disabled=\{\s*busy \|\| done/);
  });

  it('draws through payoutDialogView, so a failed re-read never unmounts the form', () => {
    expect(source).toMatch(/payoutDialogView\(profile,\s*overview\)/);
    expect(source).not.toMatch(/profile\.isError\s*\|\|\s*overview\.isError/);
  });
});
