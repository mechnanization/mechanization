// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, createTransfer } from '@/lib/api-client';
import { heldInDoubt, heldKey, spendKey } from '@/lib/request-id';
import { RecordTransferForm } from '@/components/admin/finance/record-transfer-form';
import {
  ACCOUNTS,
  BANK,
  CLOSED,
  DOLLARS,
  FROM,
  RATE,
  SAFE,
  TENANT,
  TO,
  chooseKind,
  field,
  fillExchange,
  fillTransfer,
  openPage,
  pick,
  press,
  submitButton,
  submitForm,
  type,
  type Page,
} from './transfer-form-harness';
import en from '../messages/en.json';

/*
  The transfer form's money behaviour, driven (PAGE-12, cleanup sprint, 2026-11-25), before it is split.

  `RecordTransferForm` is one function of some 590 lines holding the key `transfer:new` that keeps a transfer
  from moving money twice: held in module state so it outlives the form, kept across every refusal and lost
  answer, spent only when the server says the act exists, behind an in-flight ref. `transfer-screens.test.ts`
  reads the source for those words; this drives them, with the rules about what the fields do to each other, so
  a split that moved the wrong line fails here.

  The two wallet lists and the date picker are stood in for; everything else is the real form, the real schema,
  the real exchange policy and the real key module.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createTransfer: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  createTransfer: api.createTransfer,
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('@/components/ui/select', async () => (await import('./transfer-form-harness')).selectStandIn);
vi.mock('@/components/ui/date-picker', async () => (await import('./transfer-form-harness')).datePickerStandIn);

const words = en.finance.transfers.form;
const RECORDED = {
  id: 'tr-1',
  transferNumber: 'TR-7',
  feeVoucherNumber: null,
  requiresReview: false,
  fromBalanceAfter: 0,
  toBalanceAfter: 0,
  replayed: false,
};

let page: Page;
let recorded: number;
let printed: string[];

type Props = Partial<Parameters<typeof RecordTransferForm>[0]>;
const form = (props: Props = {}): ReactElement =>
  createElement(RecordTransferForm, {
    tenant: TENANT,
    token: 'tok',
    locale: 'en',
    backHref: '/t1/en/office/finance/transfers',
    accounts: ACCOUNTS,
    rate: RATE,
    onRecorded: () => {
      recorded += 1;
    },
    onPrint: (id) => printed.push(id),
    ...props,
  });
const mount = (props: Props = {}) => page.mount(form(props));

const key = () => heldKey(TENANT, 'transfer:new');
const refused = (status: number, code: string, params?: Record<string, string | number>) =>
  new ApiRequestError(status, { code, message: 'server words', ...(params ? { params } : {}) });
const body = (call = 0) => api.createTransfer.mock.calls[call]![2] as Record<string, unknown>;
const text = () => page.container.textContent ?? '';
const options = (id: string) =>
  [...page.container.querySelectorAll(`[data-list="${id}"] [data-option]`)].map((node) => node.getAttribute('data-option'));
const chosen = (id: string) => page.container.querySelector(`[data-list="${id}"]`)!.getAttribute('data-value');
const alerts = () => [...page.container.querySelectorAll('[role="alert"], [role="status"]')].map((node) => node.textContent).join(' | ');
const fieldValue = (id: string) => field(page, id)?.value;
/** The balances beside the fields. */
const summary = () => page.container.querySelector('aside')!.textContent ?? '';
/** Balances after a lost answer, as a re-read would show them. */
const poorer = ACCOUNTS.map((account) => (account.id === SAFE ? { ...account, balance: 20_000 } : account));

beforeEach(() => {
  api.createTransfer.mockReset();
  api.createTransfer.mockResolvedValue(RECORDED);
  for (const spy of Object.values(toast)) spy.mockReset();
  spendKey(TENANT, 'transfer:new');
  recorded = 0;
  printed = [];
  page = openPage();
});
afterEach(() => page.close());

describe('a transfer is recorded', () => {
  it('sends it under the held key `transfer:new`, with what was typed', async () => {
    await mount();
    const held = key();
    await fillTransfer(page);
    await press(page);
    expect(createTransfer).toHaveBeenCalledTimes(1);
    expect(body()).toMatchObject({
      kind: 'SAME_CURRENCY',
      fromAccountId: SAFE,
      toAccountId: BANK,
      amount: 100000,
      description: 'Banked the day',
      clientRequestId: held,
    });
    expect(body().feeAmount).toBeUndefined();
    expect(body().receivedAmount).toBeUndefined();
    expect(body().backdateReason).toBeUndefined();
  });

  it('sends the fee when there is one', async () => {
    await mount();
    await fillTransfer(page);
    await type(page, 'transfer-feeAmount', '1000');
    await press(page);
    expect(body().feeAmount).toBe(1000);
  });

  it('says so with the server’s number, spends the key, stays locked and moves on once', async () => {
    await mount();
    const held = key();
    const refresh = vi.spyOn(page.client, 'invalidateQueries');
    await fillTransfer(page);
    await press(page);
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success.mock.calls[0]![0]).toBe('Transfer TR-7 recorded');
    expect(toast.success.mock.calls[0]![1].description).toBe(words.successBody);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(key()).not.toBe(held);
    expect(recorded).toBe(1);
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['treasury', TENANT] });
    expect(submitButton(page).disabled).toBe(true);
    await submitForm(page);
    expect(createTransfer).toHaveBeenCalledTimes(1);
  });

  it('opens the written transfer from the toast, to print', async () => {
    await mount();
    await fillTransfer(page);
    await press(page);
    const action = toast.success.mock.calls[0]![1].action as { label: string; onClick: () => void };
    expect(action.label).toBe(words.print);
    action.onClick();
    expect(printed).toEqual(['tr-1']);
  });

  it.each([
    ['the fee’s voucher', { feeVoucherNumber: 'PV-3' }, 'The money moved, and the fee is booked as expense voucher PV-3.'],
    ['the review', { requiresReview: true, feeVoucherNumber: 'PV-3' }, words.successFlagged],
  ])('says %s when the server answers with it', async (_name, answer, description) => {
    api.createTransfer.mockResolvedValue({ ...RECORDED, ...answer });
    await mount();
    await fillTransfer(page);
    await press(page);
    expect(toast.success.mock.calls[0]![1].description).toBe(description);
  });

  it('announces a replay as already recorded, never as a new transfer', async () => {
    api.createTransfer.mockResolvedValue({ ...RECORDED, replayed: true });
    await mount();
    await fillTransfer(page);
    await press(page);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).toHaveBeenCalledTimes(1);
    expect(toast.warning.mock.calls[0]![0]).toBe('This transfer was already recorded — TR-7');
    expect(toast.warning.mock.calls[0]![1].description).toBe(words.replayedBody);
    expect(recorded).toBe(1);
  });

  it('re-reads the figures before it says so and moves on', async () => {
    let finish: () => void = () => {};
    await mount();
    vi.spyOn(page.client, 'invalidateQueries').mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await fillTransfer(page);
    await press(page);
    expect(toast.success).not.toHaveBeenCalled();
    expect(recorded).toBe(0);
    // Locked already, while the figures are read.
    expect(submitButton(page).disabled).toBe(true);
    await act(async () => finish());
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(recorded).toBe(1);
  });

  it('sends two presses in one tick as one transfer (the in-flight ref, before any state)', async () => {
    let release: (value: unknown) => void = () => {};
    api.createTransfer.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await mount();
    await fillTransfer(page);
    await press(page, 2);
    expect(createTransfer).toHaveBeenCalledTimes(1);
    expect(submitButton(page).disabled).toBe(true);
    expect(submitButton(page).textContent).toBe(words.saving);
    await submitForm(page);
    expect(createTransfer).toHaveBeenCalledTimes(1);
    await act(async () => release(RECORDED));
    expect(recorded).toBe(1);
  });
});

describe('the retry key, across what goes wrong (STA-4)', () => {
  it('is kept across a refusal, which releases the button, and goes out again', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(400, 'VALIDATION_FAILED'));
    await mount();
    const held = key();
    const refresh = vi.spyOn(page.client, 'invalidateQueries');
    await fillTransfer(page);
    await press(page);
    expect(page.container.querySelector('[role="alert"]')).not.toBeNull();
    expect(submitButton(page).disabled).toBe(false);
    expect(key()).toBe(held);
    expect(heldInDoubt(TENANT, 'transfer:new')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(recorded).toBe(0);
    await press(page);
    expect(body(1).clientRequestId).toBe(held);
    // The refusal's words go when the next press is answered.
    expect(page.container.querySelector('[role="alert"]')).toBeNull();
  });

  it.each([
    ['a lost answer', 0, 'NETWORK_ERROR'],
    ['a server error', 500, 'INTERNAL_ERROR'],
    ['a timeout', 408, 'TIMEOUT'],
    ['a throttle', 429, 'TOO_MANY_REQUESTS'],
  ])('is kept, marked in doubt, and the figures re-read after %s', async (_name, status, code) => {
    api.createTransfer.mockRejectedValueOnce(refused(status, code));
    await mount();
    const held = key();
    const refresh = vi.spyOn(page.client, 'invalidateQueries');
    await fillTransfer(page);
    await press(page);
    expect(key()).toBe(held);
    expect(heldInDoubt(TENANT, 'transfer:new')).toBe(true);
    expect(refresh).toHaveBeenCalledWith({ queryKey: ['treasury', TENANT] });
    expect(submitButton(page).disabled).toBe(false);
    await press(page);
    expect(body(1).clientRequestId).toBe(held);
  });

  it('is spent when the server says the act exists, and says which transfer it was', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(409, 'TRANSFER_ALREADY_VOID', { transferNumber: 'TR-2' }));
    await mount();
    const held = key();
    const refresh = vi.spyOn(page.client, 'invalidateQueries');
    await fillTransfer(page);
    await press(page);
    expect(key()).not.toBe(held);
    expect(alerts()).toContain('TR-2');
    expect(alerts()).toContain('has since been cancelled');
    expect(refresh).toHaveBeenCalled();
    expect(submitButton(page).disabled).toBe(false);
  });

  it('is spent when the key was used with other details (an edit after a lost answer)', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(409, 'TREASURY_REQUEST_KEY_REUSED'));
    await mount();
    const held = key();
    await fillTransfer(page);
    await press(page);
    expect(key()).not.toBe(held);
  });

  it('outlives the form: unmounted after a lost answer and mounted again, the same key goes out', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount();
    const held = key();
    await fillTransfer(page);
    await press(page);
    await page.remount(form());
    expect(key()).toBe(held);
    expect(heldInDoubt(TENANT, 'transfer:new')).toBe(true);
    await fillTransfer(page);
    await press(page);
    expect(body(1).clientRequestId).toBe(held);
  });
});

describe('a shortage', () => {
  it('turns the button off and says so, counting the fee', async () => {
    await mount();
    await fillTransfer(page, '1000000');
    await pick(FROM, BANK);
    await pick(TO, SAFE);
    expect(submitButton(page).disabled).toBe(false);
    await type(page, 'transfer-feeAmount', '1');
    expect(submitButton(page).disabled).toBe(true);
    expect(alerts()).toContain(words.shortBody);
  });

  it('refuses a submit made past the button, with no request sent', async () => {
    await mount();
    await fillTransfer(page, '9000000');
    await submitForm(page);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(text()).toContain(words.errors.short);
    expect(document.activeElement?.id).toBe('transfer-amount');
  });

  it('is only a warning after a lost answer: the retry goes out under the same key', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount();
    const held = key();
    await fillTransfer(page);
    await press(page);
    // The re-read shows the safe without the money the lost press may have moved.
    await mount({ accounts: poorer });
    expect(alerts()).toContain(words.shortInDoubt);
    expect(submitButton(page).disabled).toBe(false);
    await press(page);
    expect(createTransfer).toHaveBeenCalledTimes(2);
    expect(body(1).clientRequestId).toBe(held);
  });
});

describe('an exchange', () => {
  it('sends the two amounts and the changer, and no reason within the tolerance', async () => {
    await mount();
    await fillExchange(page);
    await type(page, 'transfer-changer', 'Al-Amana');
    await press(page);
    expect(body()).toMatchObject({
      kind: 'EXCHANGE',
      fromAccountId: DOLLARS,
      toAccountId: SAFE,
      amount: 100,
      receivedAmount: 8950000,
      moneyChangerName: 'Al-Amana',
    });
    expect(body().adjustmentReason).toBeUndefined();
    expect(field(page, 'transfer-adjustmentReason')).toBeNull();
  });

  it('asks why a rate beyond the tolerance, before anything is sent', async () => {
    await mount();
    await fillExchange(page, '9500000');
    expect(alerts()).toContain('6.15%');
    // The review notice is a plain info box, with no live role.
    expect(text()).toContain(words.reviewTolerance);
    await press(page);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(text()).toContain(words.errors.adjustmentReason);
    expect(document.activeElement?.id).toBe('transfer-adjustmentReason');
    await type(page, 'transfer-adjustmentReason', 'The market moved');
    expect(text()).not.toContain(words.errors.adjustmentReason);
    await press(page);
    expect(body().adjustmentReason).toBe('The market moved');
  });

  it('does not ask why on the retry of a lost press, whatever the rate is now', async () => {
    api.createTransfer.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount();
    await fillExchange(page);
    await press(page);
    await mount({ rate: { ...RATE, exchangeRate: 50_000 } });
    await press(page);
    expect(createTransfer).toHaveBeenCalledTimes(2);
  });

  it('flags a large exchange, and one with no official rate to compare', async () => {
    await mount();
    await fillExchange(page, '53700000', '600');
    expect(text()).toContain('above the large-exchange threshold (500)');
    await mount({ rate: { ...RATE, exchangeRate: null } });
    expect(text()).toContain(words.reviewNoRate);
  });

  it('works the received amount out of a quoted rate, and again when the amount changes', async () => {
    await mount();
    await fillExchange(page, '', '100');
    await type(page, 'transfer-rate', '90000');
    expect(fieldValue('transfer-receivedAmount')).toBe('9,000,000');
    await type(page, 'transfer-amount', '200');
    expect(fieldValue('transfer-receivedAmount')).toBe('18,000,000');
  });

  it('divides by the rate when the pounds are what is sold', async () => {
    await mount();
    await chooseKind(page, words.kinds.EXCHANGE);
    await pick(FROM, SAFE);
    await pick(TO, DOLLARS);
    await type(page, 'transfer-amount', '900000');
    await type(page, 'transfer-rate', '90000');
    expect(fieldValue('transfer-receivedAmount')).toBe('10');
  });

  it('forgets the quoted rate once the received amount is typed', async () => {
    await mount();
    await fillExchange(page, '', '100');
    await type(page, 'transfer-rate', '90000');
    await type(page, 'transfer-receivedAmount', '8000000');
    expect(fieldValue('transfer-rate')).toBe('');
    await type(page, 'transfer-amount', '200');
    expect(fieldValue('transfer-receivedAmount')).toBe('8,000,000');
  });

  it('shows what each wallet will hold', async () => {
    await mount();
    await fillExchange(page);
    await type(page, 'transfer-feeAmount', '5');
    // 1,000 − 100 − 5 dollars leave; 5,000,000 + 8,950,000 pounds arrive.
    expect(summary()).toContain('895');
    expect(summary()).toContain('13,950,000');
  });
});

describe('the wallets', () => {
  it('offers the open wallets as a source, and no destination before one is chosen', async () => {
    await mount();
    expect(options(FROM)).toEqual([SAFE, BANK, DOLLARS]);
    expect(options(FROM)).not.toContain(CLOSED);
    expect(page.container.querySelector(`[data-list="${TO}"]`)!.getAttribute('data-disabled')).toBe('true');
  });

  it('offers a transfer the same currency, and an exchange the other', async () => {
    await mount();
    await pick(FROM, SAFE);
    expect(options(TO)).toEqual([BANK]);
    await chooseKind(page, words.kinds.EXCHANGE);
    expect(options(TO)).toEqual([DOLLARS]);
  });

  it('says there is nowhere to send it', async () => {
    await mount();
    await pick(FROM, DOLLARS);
    expect(text()).toContain(words.noSameCurrency);
    await mount({ accounts: ACCOUNTS.filter((account) => account.currency === 'LBP') });
    await chooseKind(page, words.kinds.EXCHANGE);
    await pick(FROM, SAFE);
    expect(text()).toContain(words.noOtherCurrency);
  });

  it.each([
    ['the new source is the destination', BANK, ''],
    ['the new source is another currency', DOLLARS, ''],
  ])('drops a destination when %s', async (_name, source, left) => {
    await mount();
    await pick(FROM, SAFE);
    await pick(TO, BANK);
    await pick(FROM, source);
    expect(chosen(TO)).toBe(left);
  });

  it('keeps a destination that still fits', async () => {
    await mount({
      accounts: [...ACCOUNTS, { ...ACCOUNTS[1]!, id: '55555555-5555-4555-8555-555555555555', name: 'Petty' }],
    });
    await pick(FROM, SAFE);
    await pick(TO, BANK);
    await pick(FROM, '55555555-5555-4555-8555-555555555555');
    expect(chosen(TO)).toBe(BANK);
  });

  it('rewrites the amount and the fee the way the new source keeps its money', async () => {
    await mount();
    await pick(FROM, DOLLARS);
    await type(page, 'transfer-amount', '10.5');
    await type(page, 'transfer-feeAmount', '1.25');
    expect(fieldValue('transfer-amount')).toBe('10.5');
    await pick(FROM, SAFE);
    expect(fieldValue('transfer-amount')).not.toContain('.');
    expect(fieldValue('transfer-feeAmount')).not.toContain('.');
  });

  it('starts the destination, the received amount and the rate again when the kind changes', async () => {
    await mount();
    await fillExchange(page, '', '100');
    await type(page, 'transfer-rate', '90000');
    await chooseKind(page, words.kinds.SAME_CURRENCY);
    expect(chosen(TO)).toBe('');
    expect(chosen(FROM)).toBe(DOLLARS);
    await chooseKind(page, words.kinds.EXCHANGE);
    expect(fieldValue('transfer-rate')).toBe('');
    expect(fieldValue('transfer-receivedAmount')).toBe('');
    expect(fieldValue('transfer-amount')).toBe('100');
  });
});

describe('before anything is sent', () => {
  it('says what is missing, field by field, and clears each as it is mended', async () => {
    await mount();
    await submitForm(page);
    expect(createTransfer).not.toHaveBeenCalled();
    for (const message of [words.errors.fromAccountId, words.errors.toAccountId, words.errors.amount, words.errors.description]) {
      expect(text()).toContain(message);
    }
    await pick(FROM, SAFE);
    expect(text()).not.toContain(words.errors.fromAccountId);
    await pick(TO, BANK);
    expect(text()).not.toContain(words.errors.toAccountId);
    await type(page, 'transfer-amount', '10');
    expect(text()).not.toContain(words.errors.amount);
    await type(page, 'transfer-description', 'Banked');
    expect(text()).not.toContain(words.errors.description);
  });

  it('puts the officer on the first thing to mend', async () => {
    await mount();
    await pick(FROM, SAFE);
    await pick(TO, BANK);
    await press(page);
    expect(document.activeElement?.id).toBe('transfer-amount');
  });

  it('clears the other complaints when the kind changes', async () => {
    await mount();
    await submitForm(page);
    await chooseKind(page, words.kinds.EXCHANGE);
    expect(text()).not.toContain(words.errors.amount);
  });

  it('asks the reason for an earlier date, and sends it with the date', async () => {
    await mount();
    await fillTransfer(page);
    expect(field(page, 'transfer-backdateReason')).toBeNull();
    await type(page, 'transfer-date', '2020-01-15');
    await press(page);
    expect(createTransfer).not.toHaveBeenCalled();
    expect(text()).toContain(words.errors.backdateReason);
    await type(page, 'transfer-backdateReason', 'Banked last week');
    expect(text()).not.toContain(words.errors.backdateReason);
    await press(page);
    expect(body()).toMatchObject({ transferredOn: '2020-01-15', backdateReason: 'Banked last week' });
  });

  it('leads back to the register', async () => {
    await mount();
    expect(page.container.querySelector('a')!.getAttribute('href')).toBe('/t1/en/office/finance/transfers');
    expect(page.container.querySelector('a')!.textContent).toBe(words.cancel);
  });
});
