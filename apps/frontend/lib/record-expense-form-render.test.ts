// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RecordExpenseForm } from '@/components/admin/finance/record-expense-form';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  The expense form's markup, fingerprinted (PAGE-12, cleanup sprint, 2026-11-25), before it is split.

  The behaviour net (`record-expense-form-dom.test.ts`) says what the form does with money. This one says
  what it looks like in each state it can be in, with the real select, wallet and date components: a
  split that only moves JSX into other files must leave every fingerprint where it was. A state is reached
  as a person reaches it (a radio pressed, an amount typed), then the container's HTML is taken, with the
  clock frozen and React's generated ids numbered out, so a difference is a change and not noise.

    EXPENSE_FORM_DUMP=<dir> pnpm --filter @mechanization/frontend test -- record-expense-form-render
      writes each state's HTML, one tag a line, to diff against a dump from another commit.

    UPDATE_EXPENSE_FORM_RENDER=1 pnpm --filter @mechanization/frontend test -- record-expense-form-render
      rewrites the fixture, when the markup is meant to change.

  It cannot see what a click does after the first paint, which is the other file's job.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  recordExpense: vi.fn(),
  requestExpense: vi.fn(),
}));

const FIXTURE = join(__dirname, '__fixtures__', 'record-expense-form-render.json');
const WALLET = '22222222-2222-4222-8222-222222222222';
const CATEGORY = '11111111-1111-4111-8111-111111111111';
const ACCOUNTS = [
  { id: WALLET, name: 'Main safe', currency: 'LBP', balance: 5_000_000, active: true, kind: 'CASH', isMain: true },
  { id: '33333333-3333-4333-8333-333333333333', name: 'Dollar safe', currency: 'USD', balance: 1_200, active: true, kind: 'CASH', isMain: false },
] as never;
const CATEGORIES = [
  { id: CATEGORY, key: 'fuel', name: 'Fuel', active: true },
  { id: '44444444-4444-4444-8444-444444444444', key: 'repairs', name: 'Repairs', active: true },
] as never;

let container: HTMLDivElement;
let root: Root;

type Props = Partial<Parameters<typeof RecordExpenseForm>[0]>;

async function mount(locale: 'ar' | 'en', props: Props = {}): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale,
        messages: (locale === 'en' ? en : ar) as never,
        children: createElement(QueryClientProvider, {
          client: new QueryClient(),
          children: createElement(RecordExpenseForm, {
            tenant: 't1',
            token: 'tok',
            locale,
            role: 'SUPER_ADMIN',
            accounts: ACCOUNTS,
            categories: CATEGORIES,
            onRecorded: () => {},
            onClear: () => {},
            ...props,
          }),
        }),
      }),
    );
  });
}
async function type(id: string, value: string): Promise<void> {
  const node = container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function clickRadio(value: 'REQUEST' | 'URGENT'): Promise<void> {
  const radio = container.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
  await act(async () => radio.click());
}
async function clickButton(text: string): Promise<void> {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
  await act(async () => button.click());
}

/** One state each, reached as a person reaches it; the value is the script after the mount. */
const SCENARIOS: Record<string, { locale: 'ar' | 'en'; props?: Props; script?: () => Promise<void> }> = {
  'manager-ar': { locale: 'ar' },
  'manager-en': { locale: 'en' },
  'manager-carried-draft': {
    locale: 'en',
    props: { initial: { amount: '5,000', party: 'Rima', description: 'Carried from the other side', accountId: WALLET } },
  },
  'manager-empty-submit': {
    locale: 'en',
    script: async () => {
      await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    },
  },
  'manager-short-of-balance': {
    locale: 'en',
    script: async () => type('expense-amount', '9000000'),
  },
  'manager-adding-category': {
    locale: 'en',
    script: async () => clickButton(en.finance.expenses.form.newCategory),
  },
  'accountant-request-ar': { locale: 'ar', props: { role: 'ACCOUNTANT' } },
  'accountant-request-en': { locale: 'en', props: { role: 'ACCOUNTANT' } },
  'accountant-urgent': {
    locale: 'en',
    props: { role: 'ACCOUNTANT' },
    script: async () => clickRadio('URGENT'),
  },
  'accountant-urgent-ceiling-note': {
    locale: 'en',
    props: { role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } },
    script: async () => {
      await clickRadio('URGENT');
      await type('expense-amount', '50000');
    },
  },
  'accountant-urgent-over-ceiling': {
    locale: 'en',
    props: { role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } },
    script: async () => {
      await clickRadio('URGENT');
      await type('expense-amount', '200000');
    },
  },
  'accountant-urgent-over-ceiling-ar': {
    locale: 'ar',
    props: { role: 'ACCOUNTANT', urgentCeilings: { LBP: 100_000 } },
    script: async () => {
      await clickRadio('URGENT');
      await type('expense-amount', '200000');
    },
  },
  'accountant-back-to-request': {
    locale: 'en',
    props: { role: 'ACCOUNTANT' },
    script: async () => {
      await clickRadio('URGENT');
      await clickRadio('REQUEST');
    },
  },
};

/** React's generated ids (`:r4:`, `radix-:r7:`) count up across the file, so they are numbered out. */
const normalised = (html: string): string => html.replace(/:r[0-9a-z]+:/g, ':rN:');
const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

async function render(name: string): Promise<string> {
  const scenario = SCENARIOS[name]!;
  await mount(scenario.locale, scenario.props);
  await scenario.script?.();
  return normalised(container.innerHTML);
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_EXPENSE_FORM_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('the expense form’s markup, state by state', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_EXPENSE_FORM_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(Object.keys(SCENARIOS))('%s is the page it was', async (name) => {
    const html = await render(name);
    observed[name] = fingerprint(html);

    const dump = process.env.EXPENSE_FORM_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_EXPENSE_FORM_RENDER) return;
    expect(observed[name], `${name}: set EXPENSE_FORM_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('each state is rendered twice the same, so a difference is a change and not noise', async () => {
    for (const name of ['manager-en', 'accountant-urgent-over-ceiling']) {
      const first = await render(name);
      await act(async () => root.unmount());
      root = createRoot(container);
      expect(await render(name)).toBe(first);
      await act(async () => root.unmount());
      root = createRoot(container);
    }
  });

  it('the states differ from each other where they should', async () => {
    const pages = new Map<string, string>();
    for (const name of ['manager-en', 'accountant-request-en', 'accountant-urgent', 'accountant-urgent-over-ceiling']) {
      pages.set(name, await render(name));
      await act(async () => root.unmount());
      root = createRoot(container);
    }
    expect(new Set(pages.values()).size).toBe(pages.size);
    // The urgent reason is in the urgent page and in no other; the over-ceiling alert only in its own.
    expect(pages.get('accountant-urgent')).toContain('expense-urgent');
    expect(pages.get('accountant-request-en')).not.toContain('expense-urgent');
    expect(pages.get('accountant-urgent-over-ceiling')).toContain(en.finance.expenses.form.ceiling.overTitle);
    expect(pages.get('accountant-urgent')).not.toContain(en.finance.expenses.form.ceiling.overTitle);
  });
});
