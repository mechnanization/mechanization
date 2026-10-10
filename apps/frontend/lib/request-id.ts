import { ApiRequestError } from './api-client';

/** A fresh retry key: one per act a form is about to record — a payment, a voucher, a handover. */
export function newRequestId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
        (Number(c) ^ (Math.random() * 16) >> (Number(c) / 4)).toString(16),
      );
}

/**
 * The keys held for acts not yet confirmed, by `${tenant}:${scope}`.
 *
 * Module state, not component state, on purpose: a key held by a form dies
 * with the form, and a form unmounts for reasons that have nothing to do with
 * the act — a dialog closed, a background re-read that failed and swapped the
 * page for an error panel, a navigation and back. The next attempt then
 * carried a new key and recorded the act a second time (reproduced on the
 * handover and the expense form). Held here, a key outlives every unmount for
 * the life of the tab, and is dropped only when the server confirms its act.
 * A reload starts empty, which is the one loss the server cannot tell apart
 * from a new act.
 */
const held = new Map<string, string>();

/**
 * The scopes a key is held under. One scope is one act a screen can be about
 * to record; screens that record the same act share it — the counter settle
 * page and the citizen cash page both settle one bill (`settle:<paymentId>`).
 */
export type KeyScope =
  | `custody:${string}`
  | 'expense:pay'
  | 'expense:request'
  | 'income:new'
  | `salary:${string}`
  | `settle:${string}`;

/** The key held for this act, minted the first time it is asked for. */
export function heldKey(tenant: string, scope: KeyScope): string {
  const slot = `${tenant}:${scope}`;
  let key = held.get(slot);
  if (!key) {
    key = newRequestId();
    held.set(slot, key);
  }
  return key;
}

/**
 * Drops the key once the server has confirmed its act — a 2xx, or a refusal
 * `keyIsSpent` names — so the next act in this scope gets a new one. The
 * in-doubt mark goes with it (`markInDoubt`).
 */
export function spendKey(tenant: string, scope: KeyScope): void {
  const slot = `${tenant}:${scope}`;
  held.delete(slot);
  inDoubt.delete(slot);
}

/**
 * The held keys whose last attempt ended in doubt (`outcomeInDoubt`): the act
 * may have been recorded, and only a retry with the key can say.
 *
 * Module state for the reason the keys are: a dialog closed and opened again
 * must still know. Why a screen needs it at all: after a lost answer it
 * re-reads the balance, and that balance may already carry the act. A check
 * made before the request («الرصيد لا يكفي», «أعلى من السقف») then refuses the
 * very retry that would have been answered from the key, and its way out
 * (another wallet, a request instead) is a new act under a new key. While a
 * key is held in doubt such a check is a warning, never a refusal: the server
 * answers a replay before it judges the balance or the ceiling.
 *
 * Cleared only by `spendKey`. A later refusal under the same key does not
 * clear it: the attempt that was lost may still be committing on the server.
 */
const inDoubt = new Set<string>();

/** Marks this scope's held key as in doubt; a scope with no held key is left alone. */
export function markInDoubt(tenant: string, scope: KeyScope): void {
  const slot = `${tenant}:${scope}`;
  if (held.has(slot)) inDoubt.add(slot);
}

/** Whether this scope holds a key whose last attempt ended in doubt (`markInDoubt`). */
export function heldInDoubt(tenant: string, scope: KeyScope): boolean {
  return inDoubt.has(`${tenant}:${scope}`);
}

/**
 * The refusals that say the act an earlier attempt carried this key for was
 * recorded:
 *
 * - `TREASURY_REQUEST_KEY_REUSED`: recorded, with other details than this
 *   attempt's (the form was edited after an answer was lost, or a custody
 *   wallet has moved since the earlier handover);
 * - `EXPENSE_ALREADY_VOID`, `INCOME_ALREADY_VOID`, `TRANSFER_ALREADY_VOID`:
 *   recorded, and cancelled since;
 * - `TRANSACTION_ALREADY_REVERSED`: a counter payment recorded, and reversed
 *   since;
 * - `PAYMENT_IDEMPOTENCY_KEY_REUSED`: recorded, against another invoice.
 */
const ACT_RECORDED = new Set<string>([
  'TREASURY_REQUEST_KEY_REUSED',
  'EXPENSE_ALREADY_VOID',
  'INCOME_ALREADY_VOID',
  'TRANSFER_ALREADY_VOID',
  'TRANSACTION_ALREADY_REVERSED',
  'PAYMENT_IDEMPOTENCY_KEY_REUSED',
]);

/**
 * Whether a failed attempt spent its retry key: the server says the act the
 * key names already exists, so the next press is a new act and needs a new key.
 *
 * The rule for a key that moves money (STA-4), whole. A key belongs to one act:
 * it is minted when a screen first asks for it (`heldKey`), and it is kept
 * across every failure, every edit and every unmount. A refusal proves only that *this*
 * attempt wrote nothing, never that an earlier attempt with the key did not —
 * so a 400, 401, 403, 408, 409 or 429, a dropped connection (status 0) and a
 * 5xx all keep it. Keeping a key the server never recorded costs nothing; the
 * server reads it as new. And an edit made after an answer was lost is caught
 * by the server, which binds a key to its act (`TREASURY_REQUEST_KEY_REUSED`),
 * instead of being recorded a second time.
 *
 * A key is spent (`spendKey`) only when the server confirms its act exists: a
 * 2xx, after which the form locks, or one of the refusals in `ACT_RECORDED`.
 * This answers for the failures, which is where the question is open.
 */
export function keyIsSpent(caught: unknown): boolean {
  return caught instanceof ApiRequestError && ACT_RECORDED.has(caught.code);
}

/**
 * Whether a failure leaves the figures on screen in doubt: no answer at all
 * (status 0) or a server error (5xx), either of which may follow a write that
 * committed, a timeout (408), which a proxy answers while the API may still
 * commit, and a throttle (429), which comes from pressing again after one of
 * those. A screen that prefills a figure from a read — the custody dialog
 * prefills what the collector holds — re-reads after one, so a second look
 * does not start from a balance the lost attempt may have changed.
 *
 * Anything thrown that is not an API answer (a `TypeError` from the network
 * layer) is in doubt too: nothing says it did not reach the server.
 */
export function outcomeInDoubt(caught: unknown): boolean {
  if (!(caught instanceof ApiRequestError)) return true;
  const { status } = caught;
  return status === 0 || status === 408 || status === 429 || status >= 500;
}
