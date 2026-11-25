/*
  What the two nets under the transfer form share (`record-transfer-form-dom.test.ts` and
  `record-transfer-form-render.test.ts`, PAGE-12): the wallets and rate, the stand-ins for the two controls a
  test cannot work in jsdom (a Radix list does not open, a calendar is a popover), and the ways a person touches
  the form. Not a test file, and no application code imports it.
*/
import { Children, act, createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TreasuryAccountView, TreasuryRate } from '@mechanization/shared-schemas';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

export const TENANT = 't1';

export const SAFE = '11111111-1111-4111-8111-111111111111';
export const BANK = '22222222-2222-4222-8222-222222222222';
export const DOLLARS = '33333333-3333-4333-8333-333333333333';
export const CLOSED = '44444444-4444-4444-8444-444444444444';

const account = (id: string, name: string, type: TreasuryAccountView['type'], currency: string, balance: number, active = true) =>
  ({ id, name, type, currency, balance, active, isPrimary: false, ownerName: null }) satisfies TreasuryAccountView;

export const ACCOUNTS: TreasuryAccountView[] = [
  account(SAFE, 'Main safe', 'CASH_SAFE', 'LBP', 5_000_000),
  account(BANK, 'Bank', 'BANK_ACCOUNT', 'LBP', 1_000_000),
  account(DOLLARS, 'Dollar safe', 'CASH_SAFE', 'USD', 1_000),
  account(CLOSED, 'Closed safe', 'CASH_SAFE', 'LBP', 10, false),
];

export const RATE: TreasuryRate = {
  baseCurrency: 'LBP',
  secondaryCurrency: 'USD',
  exchangeRate: 89_500,
  exchangeRateUpdatedAt: null,
  tolerancePercent: 2,
  largeExchangeThreshold: 500,
};

export const FROM = 'transfer-fromAccountId';
export const TO = 'transfer-toAccountId';

// ── stand-ins ────────────────────────────────────────────────────────────────

/** The handler each list was given, by its trigger's id, so a test can choose from it. */
export const picks = new Map<string, (value: string) => void>();

type Kids = { children?: ReactNode };

export const selectStandIn = {
  Select: ({
    value,
    disabled,
    onValueChange,
    children,
  }: Kids & { value?: string; disabled?: boolean; onValueChange: (value: string) => void }) => {
    const trigger = Children.toArray(children).find(
      (child): child is ReactElement<{ id: string }> => isValidElement<{ id?: string }>(child) && Boolean(child.props.id),
    );
    const id = trigger!.props.id;
    picks.set(id, onValueChange);
    return createElement(
      'div',
      { 'data-list': id, 'data-value': value ?? '', 'data-disabled': String(Boolean(disabled)) },
      children,
    );
  },
  SelectTrigger: ({ id, children }: Kids & { id?: string }) => createElement('span', { id }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) => createElement('em', null, placeholder),
  SelectContent: ({ children }: Kids) => createElement('ul', null, children),
  SelectItem: ({ value, children }: Kids & { value: string }) => createElement('li', { 'data-option': value }, children),
};

export const datePickerStandIn = {
  DatePicker: ({
    id,
    value,
    max,
    locale,
    onChange,
  }: {
    id: string;
    value: string;
    max?: string;
    locale: string;
    onChange: (value: string) => void;
  }) =>
    createElement('input', {
      id,
      value,
      'data-max': max,
      'data-locale': locale,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
};

// ── the page ─────────────────────────────────────────────────────────────────

export interface Page {
  container: HTMLDivElement;
  client: QueryClient;
  mount: (element: ReactElement, locale?: 'ar' | 'en') => Promise<void>;
  /** Unmounted and mounted again, as a trip to the register and back does. */
  remount: (element: ReactElement, locale?: 'ar' | 'en') => Promise<void>;
  close: () => void;
}

export function openPage(): Page {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root = createRoot(container);
  const client = new QueryClient();
  const mount: Page['mount'] = async (element, locale = 'en') => {
    await act(async () => {
      root.render(
        createElement(NextIntlClientProvider, {
          locale,
          messages: (locale === 'en' ? en : ar) as never,
          children: createElement(QueryClientProvider, { client, children: element }),
        }),
      );
    });
  };
  return {
    container,
    client,
    mount,
    remount: async (element, locale) => {
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount(element, locale);
    },
    close: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export const field = (page: Page, id: string) =>
  page.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);

export async function type(page: Page, id: string, value: string): Promise<void> {
  const node = field(page, id);
  if (!node) throw new Error(`no #${id}`);
  await act(async () => {
    const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function pick(id: string, value: string): Promise<void> {
  const onValueChange = picks.get(id);
  if (!onValueChange) throw new Error(`no list #${id}`);
  await act(async () => onValueChange(value));
}

export const submitButton = (page: Page) => page.container.querySelector<HTMLButtonElement>('button[type="submit"]')!;

export async function press(page: Page, times = 1): Promise<void> {
  await act(async () => {
    for (let i = 0; i < times; i += 1) submitButton(page).click();
  });
}

/** What Enter in a field does: the form is submitted whether or not its button is off. */
export async function submitForm(page: Page): Promise<void> {
  await act(async () => {
    page.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}

/** «تحويل داخلي» or «مصارفة». */
export async function chooseKind(page: Page, label: string): Promise<void> {
  const button = [...page.container.querySelectorAll<HTMLButtonElement>('button[role="radio"]')].find(
    (node) => node.textContent === label,
  );
  if (!button) throw new Error(`no kind «${label}»`);
  await act(async () => button.click());
}

/** A transfer in pounds, from the safe to the bank, with its statement. */
export async function fillTransfer(page: Page, amount = '100000'): Promise<void> {
  await pick(FROM, SAFE);
  await pick(TO, BANK);
  await type(page, 'transfer-amount', amount);
  await type(page, 'transfer-description', 'Banked the day');
}

/** Dollars sold for pounds: 100 for `received`. */
export async function fillExchange(page: Page, received = '8950000', amount = '100'): Promise<void> {
  await chooseKind(page, en.finance.transfers.form.kinds.EXCHANGE);
  await pick(FROM, DOLLARS);
  await pick(TO, SAFE);
  await type(page, 'transfer-amount', amount);
  await type(page, 'transfer-receivedAmount', received);
  await type(page, 'transfer-description', 'Dollars sold for salaries');
}
