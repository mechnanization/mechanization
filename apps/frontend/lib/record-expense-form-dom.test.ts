// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError, recordExpense, requestExpense } from '@/lib/api-client';
import { heldInDoubt, heldKey, spendKey } from '@/lib/request-id';
import { RecordExpenseForm, type RecordOutcome } from '@/components/admin/finance/record-expense-form';
import en from '../messages/en.json';

/*
  The expense form's money behaviour, driven (PAGE-12, cleanup sprint, 2026-11-25), before it is split.

  `RecordExpenseForm` is one 740-line function holding the two retry keys that keep a payment from being
  made twice, `expense:pay` and `expense:request`: held in module state so they outlive the form, kept across
  every refusal and every lost answer, spent only when the server says the act exists, and an in-flight ref
  that stops a second press in the same tick. A split that moved the wrong line would not change a single
  pixel and could pay a clerk's invoice twice, so this is written first and the split has to keep it green.

  The category and wallet lists and the date picker are stood in for (Radix lists do not open in jsdom, and
  what they pick is not under test); everything else is the real form, the real schemas and the real key module.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout; Radix's checkbox (the «invoice kept» box) measures itself with one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

const api = vi.hoisted(() => ({ recordExpense: vi.fn(), requestExpense: vi.fn(), createExpenseCategory: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  recordExpense: api.recordExpense,
  requestExpense: api.requestExpense,
  createExpenseCategory: api.createExpenseCategory,
}));

/** The handlers the stand-ins were given, so a test can choose a band and a wallet. */
const picks = vi.hoisted(() => ({
  category: null as null | ((value: string) => void),
  wallet: null as null | ((value: string) => void),
}));
vi.mock('@/components/ui/select', async () => {
  const { createElement: h } = await import('react');
  return {
    Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: React.ReactNode }) => {
      picks.category = onValueChange;
      return h('div', { 'data-stand-in': 'category' }, children);
    },
    SelectTrigger: ({ id, children }: { id?: string; children: React.ReactNode }) => h('span', { id }, children),
    SelectValue: ({ children }: { children?: React.ReactNode }) => h('span', null, children),
    SelectContent: () => null,
    SelectItem: () => null,
  };
});
vi.mock('@/components/admin/finance/wallet-select', () => ({
  WalletSelect: ({ onChange }: { onChange: (value: string) => void }) => {
    picks.wallet = onChange;
    return null;
  },
}));
vi.mock('@/components/ui/date-picker', async () => {
  const { createElement: h } = await import('react');
  return {
    DatePicker: ({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) =>
      h('input', { id, value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) }),
  };
});

const TENANT = 't1';
const CATEGORY = '11111111-1111-4111-8111-111111111111';
const WALLET = '22222222-2222-4222-8222-222222222222';
const OTHER_WALLET = '33333333-3333-4333-8333-333333333333';
const NEW_CATEGORY = '44444444-4444-4444-8444-444444444444';
const ACCOUNTS = [
  { id: WALLET, name: 'Main safe', currency: 'LBP', balance: 5_000_000, active: true },
  { id: OTHER_WALLET, name: 'Second safe', currency: 'LBP', balance: 5_000_000, active: true },
] as never;
const CATEGORIES = [{ id: CATEGORY, key: 'fuel', name: 'Fuel', active: true }] as never;

const PAID = { id: 'v1', number: 'PV-1', status: 'AWAITING_ORDER', replayed: false } as never;
const FILED = { id: 'r1', number: 'ER-1', status: 'PENDING', replayed: false } as never;

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let recorded: RecordOutcome[];
let drafts: Array<{ amount: string; accountId: string; party: string; description: string }>;
let cleared: number;

type Props = Partial<Parameters<typeof RecordExpenseForm>[0]>;
const element = (props: Props): ReactElement =>
  createElement(NextIntlClientProvider, {
    locale: 'en',
    messages: en as never,
    children: createElement(QueryClientProvider, {
      client,
      children: createElement(RecordExpenseForm, {
        tenant: TENANT,
        token: 'tok',
        locale: 'en',
        role: 'SUPER_ADMIN',
        accounts: ACCOUNTS,
        categories: CATEGORIES,
        onDraftChange: (draft) => drafts.push(draft),
        onRecorded: (outcome) => recorded.push(outcome),
        onClear: () => {
          cleared += 1;
        },
        ...props,
      }),
    }),
  });

async function mount(props: Props = {}): Promise<void> {
  await act(async () => {
    root.render(element(props));
  });
}
async function remount(props: Props = {}): Promise<void> {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount(props);
}

const field = (id: string) => container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
async function type(id: string, value: string): Promise<void> {
  const node = field(id);
  if (!node) throw new Error(`no #${id}`);
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pick(which: 'category' | 'wallet', value: string): Promise<void> {
  await act(async () => picks[which]!(value));
}
/** The three things every voucher needs, and the two lists. */
async function fillValid(amount = '50000'): Promise<void> {
  await pick('category', CATEGORY);
  await pick('wallet', WALLET);
  await type('expense-amount', amount);
  await type('expense-payee', 'Ali');
  await type('expense-description', 'Fuel for the trucks');
}
const submitButton = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
async function press(times = 1): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) submitButton().click();
  });
}
async function choose(value: 'REQUEST' | 'URGENT'): Promise<void> {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  await act(async () => radio.click());
}
const alertText = () => [...container.querySelectorAll('[role="alert"], [role="status"]')].map((node) => node.textContent ?? '').join(' | ');
const refused = (status: number, code: string, params?: Record<string, string | number>) =>
  new ApiRequestError(status, { code, message: 'server words', ...(params ? { params } : {}) });
const sent = (call: ReturnType<typeof vi.fn>) => call.mock.calls[0]?.[2] as Record<string, unknown>;
const buttonNamed = (text: string) =>
  [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === text);
async function clickNamed(text: string): Promise<void> {
  const button = buttonNamed(text);
  if (!button) throw new Error(`no button «${text}»`);
  await act(async () => button.click());
}

beforeEach(() => {
  api.recordExpense.mockReset();
  api.requestExpense.mockReset();
  api.createExpenseCategory.mockReset();
  api.recordExpense.mockResolvedValue(PAID);
  api.requestExpense.mockResolvedValue(FILED);
  picks.category = null;
  picks.wallet = null;
  for (const scope of ['expense:pay', 'expense:request'] as const) spendKey(TENANT, scope);
  recorded = [];
  drafts = [];
  cleared = 0;
  client = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the manager pays: the recording is the order', () => {
  it('sends the payment under the held key `expense:pay`, with what was typed', async () => {
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    expect(recordExpense).toHaveBeenCalledTimes(1);
    expect(requestExpense).not.toHaveBeenCalled();
    expect(sent(api.recordExpense)).toMatchObject({
      categoryId: CATEGORY,
      accountId: WALLET,
      amount: 50000,
      payee: 'Ali',
      description: 'Fuel for the trucks',
      clientRequestId: key,
    });
    // The manager's recording is the order: no urgent reason is sent.
    expect(sent(api.recordExpense).urgentReason).toBeUndefined();
  });

  it('is answered, says what the server recorded, spends the key and locks the form', async () => {
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    const refresh = vi.spyOn(client, 'invalidateQueries');
    await fillValid();
    await press();
    expect(recorded).toEqual([{ kind: 'PAID', result: PAID }]);
    expect(heldKey(TENANT, 'expense:pay')).not.toBe(key);
    expect(submitButton().disabled).toBe(true);
    expect(refresh).toHaveBeenCalled();
    // A second press on the locked form is no second payment.
    await press();
    expect(recordExpense).toHaveBeenCalledTimes(1);
  });

  it('passes a replay through as the server said it', async () => {
    api.recordExpense.mockResolvedValue({ ...(PAID as object), replayed: true });
    await mount();
    await fillValid();
    await press();
    expect((recorded[0]!.result as { replayed: boolean }).replayed).toBe(true);
  });

  it('sends two presses in one tick as one payment (the in-flight ref, before any state)', async () => {
    let release: (value: unknown) => void = () => {};
    api.recordExpense.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await mount();
    await fillValid();
    await press(2);
    expect(recordExpense).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled).toBe(true);
    await act(async () => release(PAID));
    expect(recorded).toHaveLength(1);
  });
});

describe('the retry key, across what goes wrong (STA-4)', () => {
  it('is kept across a refusal, and the same press is sent again with it', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(400, 'VALIDATION_FAILED'));
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    expect(submitButton().disabled).toBe(false);
    expect(heldKey(TENANT, 'expense:pay')).toBe(key);
    expect(heldInDoubt(TENANT, 'expense:pay')).toBe(false);
    await press();
    expect(recordExpense).toHaveBeenCalledTimes(2);
    expect(api.recordExpense.mock.calls[1]![2].clientRequestId).toBe(key);
  });

  it.each([
    ['a lost answer', 0, 'NETWORK_ERROR'],
    ['a server error', 500, 'INTERNAL_ERROR'],
    ['a timeout', 408, 'TIMEOUT'],
    ['a throttle', 429, 'TOO_MANY_REQUESTS'],
  ])('is kept, marked in doubt, and the figures re-read after %s', async (_name, status, code) => {
    api.recordExpense.mockRejectedValueOnce(refused(status, code));
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    const refresh = vi.spyOn(client, 'invalidateQueries');
    await fillValid();
    await press();
    expect(heldKey(TENANT, 'expense:pay')).toBe(key);
    expect(heldInDoubt(TENANT, 'expense:pay')).toBe(true);
    expect(refresh).toHaveBeenCalled();
    expect(submitButton().disabled).toBe(false);
    await press();
    expect(api.recordExpense.mock.calls[1]![2].clientRequestId).toBe(key);
  });

  it('is spent when the server says the act exists, and says which voucher it was', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(409, 'EXPENSE_ALREADY_VOID', { voucherNumber: 'PV-12' }));
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    expect(heldKey(TENANT, 'expense:pay')).not.toBe(key);
    expect(alertText()).toContain('PV-12');
    expect(submitButton().disabled).toBe(false);
  });

  it('is spent when the key was used with other details (an edit after a lost answer)', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(409, 'TREASURY_REQUEST_KEY_REUSED'));
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    expect(heldKey(TENANT, 'expense:pay')).not.toBe(key);
  });

  it('outlives the form: unmounted after a lost answer and mounted again, the same key goes out', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount();
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    await remount();
    expect(heldKey(TENANT, 'expense:pay')).toBe(key);
    expect(heldInDoubt(TENANT, 'expense:pay')).toBe(true);
    await fillValid();
    await press();
    expect(api.recordExpense.mock.calls[1]![2].clientRequestId).toBe(key);
  });

  it('is one key per act: a request and a payment never share one', async () => {
    await mount({ role: 'ACCOUNTANT' });
    expect(heldKey(TENANT, 'expense:request')).not.toBe(heldKey(TENANT, 'expense:pay'));
  });
});

describe('the accountant files a request (the default)', () => {
  it('sends the request under `expense:request`, with no date and no urgent reason', async () => {
    await mount({ role: 'ACCOUNTANT' });
    const key = heldKey(TENANT, 'expense:request');
    await fillValid();
    await press();
    expect(requestExpense).toHaveBeenCalledTimes(1);
    expect(recordExpense).not.toHaveBeenCalled();
    const body = sent(api.requestExpense);
    expect(body).toMatchObject({ categoryId: CATEGORY, accountId: WALLET, amount: 50000, payee: 'Ali', clientRequestId: key });
    expect(body.paidOn).toBeUndefined();
    expect(body.urgentReason).toBeUndefined();
    expect(recorded).toEqual([{ kind: 'REQUESTED', result: FILED }]);
    expect(heldKey(TENANT, 'expense:request')).not.toBe(key);
  });

  it('draws no date field and no urgent reason', async () => {
    await mount({ role: 'ACCOUNTANT' });
    expect(field('expense-date')).toBeNull();
    expect(field('expense-urgent')).toBeNull();
  });

  it('keeps its key across a lost answer, apart from the payment key', async () => {
    api.requestExpense.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount({ role: 'ACCOUNTANT' });
    const key = heldKey(TENANT, 'expense:request');
    const payKey = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    expect(heldInDoubt(TENANT, 'expense:request')).toBe(true);
    expect(heldInDoubt(TENANT, 'expense:pay')).toBe(false);
    await press();
    expect(api.requestExpense.mock.calls[1]![2].clientRequestId).toBe(key);
    expect(heldKey(TENANT, 'expense:pay')).toBe(payKey);
  });
});

describe('the accountant pays urgently (art. 35)', () => {
  it('asks why, and sends the payment under `expense:pay` with the reason', async () => {
    await mount({ role: 'ACCOUNTANT' });
    await choose('URGENT');
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid();
    await press();
    // The reason is required: nothing is sent without it.
    expect(recordExpense).not.toHaveBeenCalled();
    await type('expense-urgent', 'The generator stopped');
    await press();
    expect(recordExpense).toHaveBeenCalledTimes(1);
    expect(sent(api.recordExpense)).toMatchObject({ urgentReason: 'The generator stopped', clientRequestId: key });
  });

  it('is refused here above the manager’s ceiling, with no request sent, and offers the request', async () => {
    await mount({ role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } });
    await choose('URGENT');
    await fillValid('200000');
    await type('expense-urgent', 'The generator stopped');
    await press();
    expect(recordExpense).not.toHaveBeenCalled();
    expect(alertText()).toContain('Send it as a request');
  });

  it('keeps what was typed when «send it as a request» switches the way, and sends that under `expense:request`', async () => {
    await mount({ role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } });
    await choose('URGENT');
    await fillValid('200000');
    const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes('Send it as a request'))!;
    await act(async () => button.click());
    expect(field('expense-payee')!.value).toBe('Ali');
    expect(field('expense-amount')!.value).toContain('200');
    await press();
    expect(requestExpense).toHaveBeenCalledTimes(1);
    expect(sent(api.requestExpense).amount).toBe(200000);
  });

  it('is only warned about the ceiling after a press whose answer was lost: the retry is sent', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(0, 'NETWORK_ERROR'));
    await mount({ role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } });
    await choose('URGENT');
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid('50000');
    await type('expense-urgent', 'The generator stopped');
    await press();
    expect(heldInDoubt(TENANT, 'expense:pay')).toBe(true);
    // The manager lowers the ceiling while the answer is lost, and the screen reads it.
    await mount({ role: 'ACCOUNTANT', urgentCeilings: { LBP: 10_000 } });
    // A warning that says to press again, and no offer of a request under a new key.
    expect(alertText()).toContain(en.finance.expenses.form.ceiling.overTitle);
    expect(buttonNamed(en.finance.expenses.form.ceiling.sendAsRequest)).toBeUndefined();
    await press();
    expect(recordExpense).toHaveBeenCalledTimes(2);
    expect(api.recordExpense.mock.calls[1]![2].clientRequestId).toBe(key);
    // Recorded: the warning goes with the lock, rather than offering a second act on a paid voucher.
    expect(alertText()).not.toContain(en.finance.expenses.form.ceiling.overTitle);
    expect(buttonNamed(en.finance.expenses.form.ceiling.sendAsRequest)).toBeUndefined();
  });

  it('is told the server’s own ceiling when it refuses, keeps the key, and offers the request', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(409, 'EXPENSE_URGENT_OVER_CEILING', { ceiling: 20_000, currency: 'LBP' }));
    await mount({ role: 'ACCOUNTANT' });
    await choose('URGENT');
    const key = heldKey(TENANT, 'expense:pay');
    await fillValid('50000');
    await type('expense-urgent', 'The generator stopped');
    await press();
    expect(alertText()).toMatch(/20,000/);
    expect([...container.querySelectorAll('button')].some((node) => node.textContent?.includes('Send it as a request'))).toBe(true);
    expect(heldKey(TENANT, 'expense:pay')).toBe(key);
  });
});

describe('before anything is sent', () => {
  it('refuses an empty form with a word per field, and sends nothing', async () => {
    await mount();
    await press();
    expect(recordExpense).not.toHaveBeenCalled();
    expect(requestExpense).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.finance.expenses.form.errors.amount);
    expect(container.textContent).toContain(en.finance.expenses.form.errors.payee);
    expect(container.textContent).toContain(en.finance.expenses.form.errors.description);
  });

  it('asks the reason for a back-dated voucher, and sends it with the date', async () => {
    await mount();
    await fillValid();
    expect(field('expense-adjustment')).toBeNull();
    await type('expense-date', '2020-01-15');
    expect(field('expense-adjustment')).not.toBeNull();
    await press();
    expect(recordExpense).not.toHaveBeenCalled();
    expect(container.textContent).toContain(en.finance.expenses.form.errors.adjustmentReason);
    await type('expense-adjustment', 'The invoice came late');
    await press();
    expect(sent(api.recordExpense)).toMatchObject({ paidOn: '2020-01-15', adjustmentReason: 'The invoice came late' });
  });

  it('draws no back-dating reason for a request, which has no date', async () => {
    await mount({ role: 'ACCOUNTANT' });
    expect(field('expense-adjustment')).toBeNull();
  });
});

describe('the shared fields and the way out', () => {
  it('tells the composer the shared fields as they change, so «قبض» keeps them', async () => {
    await mount();
    await pick('wallet', WALLET);
    await type('expense-amount', '1200');
    await type('expense-payee', 'Ali');
    await type('expense-description', 'Fuel');
    expect(drafts.at(-1)).toMatchObject({ accountId: WALLET, party: 'Ali', description: 'Fuel' });
    expect(drafts.at(-1)!.amount).toContain('1');
  });

  it('starts from what was carried over from the other side', async () => {
    await mount({ initial: { amount: '5,000', party: 'Rima', description: 'Carried', accountId: WALLET } });
    expect(field('expense-payee')!.value).toBe('Rima');
    expect(field('expense-description')!.value).toBe('Carried');
    expect(field('expense-amount')!.value).toBe('5,000');
  });

  it('clears through the composer, and not while a press is on the wire', async () => {
    let release: (value: unknown) => void = () => {};
    api.recordExpense.mockImplementation(() => new Promise((resolve) => (release = resolve)));
    await mount();
    await clickNamed(en.finance.expenses.form.clear);
    expect(cleared).toBe(1);
    await fillValid();
    await press();
    expect(buttonNamed(en.finance.expenses.form.clear)!.disabled).toBe(true);
    await act(async () => release(PAID));
  });
});

describe('what is typed is what is sent', () => {
  it('sends the wallet that was chosen, not the one the form opened on', async () => {
    await mount();
    await fillValid();
    await pick('wallet', OTHER_WALLET);
    await press();
    expect(sent(api.recordExpense).accountId).toBe(OTHER_WALLET);
  });

  it('sends the invoice number and that its paper was kept', async () => {
    await mount();
    await fillValid();
    await type('expense-invoice', 'INV-7');
    await act(async () => container.querySelector<HTMLButtonElement>('#expense-receipt')!.click());
    await press();
    expect(sent(api.recordExpense)).toMatchObject({ invoiceNumber: 'INV-7', hasPhysicalReceipt: true });
  });

  it('selects a band the manager adds on the spot, and sends it', async () => {
    api.createExpenseCategory.mockResolvedValue({ id: NEW_CATEGORY, key: 'tyres', name: 'Tyres', active: true });
    await mount();
    await fillValid();
    await clickNamed(en.finance.expenses.form.newCategory);
    await type('new-category-name', 'Tyres');
    await clickNamed(en.finance.expenses.newCategory.create);
    expect(field('new-category-name')).toBeNull();
    expect(container.querySelector('#expense-category')!.textContent).toBe('Tyres');
    // Nothing was paid by adding a band, and the rest of the voucher is as it was.
    expect(recordExpense).not.toHaveBeenCalled();
    expect(field('expense-payee')!.value).toBe('Ali');
    await press();
    expect(sent(api.recordExpense).categoryId).toBe(NEW_CATEGORY);
  });

  it('leaves the voucher alone when adding a band is cancelled', async () => {
    await mount();
    await fillValid();
    await clickNamed(en.finance.expenses.form.newCategory);
    await clickNamed(en.finance.expenses.newCategory.cancel);
    expect(field('new-category-name')).toBeNull();
    expect(api.createExpenseCategory).not.toHaveBeenCalled();
    await press();
    expect(sent(api.recordExpense).categoryId).toBe(CATEGORY);
  });

  it('offers no new band to an accountant', async () => {
    await mount({ role: 'ACCOUNTANT' });
    expect(buttonNamed(en.finance.expenses.form.newCategory)).toBeUndefined();
  });

  it('drops the complaints about one way of paying when the way is switched', async () => {
    api.recordExpense.mockRejectedValueOnce(refused(400, 'VALIDATION_FAILED'));
    await mount({ role: 'ACCOUNTANT' });
    await choose('URGENT');
    await press();
    expect(container.textContent).toContain(en.finance.expenses.form.errors.payee);
    await choose('REQUEST');
    expect(container.textContent).not.toContain(en.finance.expenses.form.errors.payee);
    // And the server's refusal of the one way is not shown against the other.
    await choose('URGENT');
    await fillValid();
    await type('expense-urgent', 'The generator stopped');
    await press();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    await choose('REQUEST');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('re-reads the treasury but not the band list under the open select, and reports only after', async () => {
    let finish: () => void = () => {};
    await mount();
    const refresh = vi
      .spyOn(client, 'invalidateQueries')
      .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    await fillValid();
    await press();
    const filters = refresh.mock.calls[0]![0] as unknown as {
      queryKey: unknown[];
      predicate: (query: { queryKey: unknown[] }) => boolean;
    };
    expect(filters.queryKey).toEqual(['treasury', TENANT]);
    expect(filters.predicate({ queryKey: ['treasury', TENANT, 'accounts'] })).toBe(true);
    expect(filters.predicate({ queryKey: ['treasury', TENANT, 'expense-categories', 'all'] })).toBe(false);
    expect(recorded).toHaveLength(0);
    await act(async () => finish());
    expect(recorded).toHaveLength(1);
  });
});
