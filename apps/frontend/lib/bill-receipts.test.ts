import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, onlineManager } from '@tanstack/react-query';
import { reverseTransactionSchema } from '@mechanization/shared-schemas';
import { ApiRequestError } from './api-client';
import {
  REVERSAL_REASON_MAX,
  billPageLink,
  claimUnderReview,
  mayReverseReceipt,
  receiptsReadAgain,
  reversalFailure,
  reversalReasonValid,
} from './bill-receipts';

describe('mayReverseReceipt', () => {
  const standing = { isReversal: false, reversed: false };
  const owed = { paymentStatus: 'UNPAID' };

  it('offers «عكس الوصل» on a standing receipt to the manager', () => {
    expect(mayReverseReceipt(standing, 'SUPER_ADMIN', owed)).toBe(true);
  });

  it.each(['ACCOUNTANT', 'COLLECTOR', 'AUDITOR', 'VIEWER', undefined, null])(
    'offers it to no one else (%s): the route is the manager’s',
    (role) => {
      expect(mayReverseReceipt(standing, role, owed)).toBe(false);
    },
  );

  it('never on the opposing row, nor on a receipt already reversed', () => {
    expect(mayReverseReceipt({ isReversal: true, reversed: false }, 'SUPER_ADMIN', owed)).toBe(false);
    expect(mayReverseReceipt({ isReversal: false, reversed: true }, 'SUPER_ADMIN', owed)).toBe(false);
  });

  it('not while a transfer the citizen reported waits for a clerk: the reversal would erase the claim', () => {
    expect(mayReverseReceipt(standing, 'SUPER_ADMIN', { paymentStatus: 'PENDING_REVIEW' })).toBe(false);
  });

  it.each(['UNPAID', 'OVERDUE', 'PAID'])('on a bill with no claim waiting (%s)', (paymentStatus) => {
    expect(mayReverseReceipt(standing, 'SUPER_ADMIN', { paymentStatus })).toBe(true);
  });
});

describe('claimUnderReview', () => {
  it('is a bill whose reported transfer no clerk has confirmed or rejected, and nothing else', () => {
    expect(['PENDING_REVIEW', 'UNPAID', 'OVERDUE', 'PAID'].map((paymentStatus) => claimUnderReview({ paymentStatus }))).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('billPageLink', () => {
  it('links a bill paid in full to its receipts, where «عكس الوصل» is', () => {
    expect(billPageLink({ paymentStatus: 'PAID' })).toBe('receipts');
  });

  it('links a cancelled bill to its receipts, never to a cash form that would take nothing', () => {
    expect(billPageLink({ paymentStatus: 'CANCELLED' })).toBe('receipts');
  });

  it.each(['UNPAID', 'OVERDUE', 'PENDING_REVIEW'])('links an owed bill (%s) to the cash form, its receipts under it', (paymentStatus) => {
    expect(billPageLink({ paymentStatus })).toBe('settle');
  });
});

describe('reversalReasonValid', () => {
  // The server's own limits, read off its schema rather than restated here.
  const { minLength, maxLength } = reverseTransactionSchema.shape.note;

  it('gives the box the longest reason the server takes', () => {
    expect(maxLength).not.toBeNull();
    expect(REVERSAL_REASON_MAX).toBe(maxLength);
  });

  it('takes a reason at either of the server’s limits, and refuses one past them', () => {
    expect(minLength).not.toBeNull();
    expect(reversalReasonValid('س'.repeat(minLength!))).toBe(true);
    expect(reversalReasonValid('س'.repeat(minLength! - 1))).toBe(false);
    expect(reversalReasonValid('س'.repeat(maxLength!))).toBe(true);
    expect(reversalReasonValid('س'.repeat(maxLength! + 1))).toBe(false);
    expect(reversalReasonValid('')).toBe(false);
  });

  it('trims first, as the server does', () => {
    const short = 'س'.repeat(minLength! - 1);
    expect(reversalReasonValid(`  ${short}  `)).toBe(false);
    expect(reversalReasonValid(`  ${short}س  `)).toBe(true);
  });
});

/*
  The dialog's own sequence, on TanStack's real cache: the list is on screen
  (an observer holds it), the press fails, the key is invalidated and awaited,
  and the cache is read. After a re-read that did not answer, what the cache
  holds is the list from before the press.
*/
describe('receiptsReadAgain', () => {
  type Receipts = { items: Array<{ id: string; reversed: boolean }> };
  const key = ['payment-transactions', 't', 'bill-1'];
  const before: Receipts = { items: [{ id: 'rcp-1', reversed: false }] };
  const after: Receipts = { items: [{ id: 'rcp-1', reversed: true }] };

  afterEach(() => {
    onlineManager.setOnline(true);
    vi.useRealTimers();
  });

  /** A cache with the list loaded at 10:00 and on screen, and a press at 10:05; `reread` answers every read after the first. */
  async function listOnScreen(reread: () => Promise<Receipts>) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-10T10:00:00.000Z'));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    const observer = new QueryObserver<Receipts>(client, {
      queryKey: key,
      queryFn: () => (reads++ === 0 ? Promise.resolve(before) : reread()),
    });
    const unsubscribe = observer.subscribe(() => undefined);
    await vi.waitFor(() => expect(client.getQueryData(key)).toEqual(before));
    vi.setSystemTime(new Date('2026-06-10T10:05:00.000Z'));
    return { client, unsubscribe, pressedAt: Date.now() };
  }

  it('hands on the list a read made after the press answered with', async () => {
    const { client, unsubscribe, pressedAt } = await listOnScreen(() => Promise.resolve(after));
    await client.invalidateQueries({ queryKey: key });
    expect(receiptsReadAgain(client.getQueryState<Receipts>(key), pressedAt)).toEqual(after.items);
    unsubscribe();
  });

  it('hands on nothing when the re-read failed, though the cache still holds the list from before the press', async () => {
    const { client, unsubscribe, pressedAt } = await listOnScreen(() => Promise.reject(new Error('offline')));
    await client.invalidateQueries({ queryKey: key });
    expect(client.getQueryData(key)).toEqual(before);
    expect(receiptsReadAgain(client.getQueryState<Receipts>(key), pressedAt)).toBeUndefined();
    unsubscribe();
  });

  it('hands on nothing while the re-read waits for a connection', async () => {
    const { client, unsubscribe, pressedAt } = await listOnScreen(() => Promise.resolve(after));
    onlineManager.setOnline(false);
    await client.invalidateQueries({ queryKey: key });
    expect(client.getQueryState(key)?.fetchStatus).toBe('paused');
    expect(receiptsReadAgain(client.getQueryState<Receipts>(key), pressedAt)).toBeUndefined();
    unsubscribe();
  });

  it('hands on nothing when no read ran after the press', () => {
    const pressedAt = Date.parse('2026-06-10T10:05:00.000Z');
    const read = { status: 'success', fetchStatus: 'idle', dataUpdatedAt: pressedAt - 60_000, data: before } as const;
    expect(receiptsReadAgain(read, pressedAt)).toBeUndefined();
    expect(receiptsReadAgain(undefined, pressedAt)).toBeUndefined();
  });
});

describe('reversalFailure', () => {
  const failed = (status: number, code: string): ApiRequestError => new ApiRequestError(status, { code, message: 'x' });
  const standing = [{ id: 'rcp-1', reversed: false }];
  const reversed = [{ id: 'rcp-1', reversed: true }];

  it('reads «already reversed» as done: an earlier press whose answer was lost went through', () => {
    // A retry after a lost answer: the server refuses the second reversal, and the list may not show it yet.
    expect(reversalFailure(failed(409, 'TRANSACTION_ALREADY_REVERSED'), undefined, 'rcp-1')).toBe('already-reversed');
    expect(reversalFailure(failed(409, 'TRANSACTION_ALREADY_REVERSED'), standing, 'rcp-1')).toBe('already-reversed');
  });

  it('reads a press that was not confirmed as gone through when the receipts read again show it reversed', () => {
    expect(reversalFailure(failed(0, 'NETWORK_ERROR'), reversed, 'rcp-1')).toBe('went-through');
    expect(reversalFailure(failed(503, 'INTERNAL_ERROR'), reversed, 'rcp-1')).toBe('went-through');
  });

  it('keeps a press that was not confirmed in doubt while the receipts read again do not show it reversed', () => {
    expect(reversalFailure(failed(0, 'NETWORK_ERROR'), standing, 'rcp-1')).toBe('in-doubt');
    // Another receipt reversed on the same bill says nothing about this one.
    expect(reversalFailure(failed(0, 'NETWORK_ERROR'), [{ id: 'rcp-2', reversed: true }, ...standing], 'rcp-1')).toBe(
      'in-doubt',
    );
  });

  it('says the receipts were not read again when they could not be', () => {
    expect(reversalFailure(failed(0, 'NETWORK_ERROR'), undefined, 'rcp-1')).toBe('unread');
    expect(reversalFailure(failed(504, 'INTERNAL_ERROR'), undefined, 'rcp-1')).toBe('unread');
  });

  it('leaves any other refusal as a refusal of this attempt', () => {
    expect(reversalFailure(failed(409, 'TREASURY_INSUFFICIENT_FUNDS'), standing, 'rcp-1')).toBe('refused');
    expect(reversalFailure(failed(403, 'FORBIDDEN'), undefined, 'rcp-1')).toBe('refused');
  });

  it('reads a refusal as done when the receipts read again show another press reversed it first', () => {
    expect(reversalFailure(failed(409, 'TREASURY_INSUFFICIENT_FUNDS'), reversed, 'rcp-1')).toBe('already-reversed');
  });
});
