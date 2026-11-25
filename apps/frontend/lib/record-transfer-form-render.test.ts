// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { spendKey } from '@/lib/request-id';
import { RecordTransferForm } from '@/components/admin/finance/record-transfer-form';
import {
  ACCOUNTS,
  DOLLARS,
  FROM,
  RATE,
  SAFE,
  TENANT,
  chooseKind,
  fillExchange,
  fillTransfer,
  openPage,
  pick,
  press,
  submitForm,
  type,
  type Page,
} from './transfer-form-harness';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  The transfer form's markup, fingerprinted (PAGE-12, cleanup sprint, 2026-11-25), before it is split.

  The behaviour net (`record-transfer-form-dom.test.ts`) says what the form does with money. This one says what
  it draws in each state it can be in: a split that only moves JSX into other files must leave every
  fingerprint where it was. A state is reached as a person reaches it, then the container's HTML is taken, with
  the clock frozen and React's generated ids numbered out. The two wallet lists and the date picker are the
  harness's stand-ins, which draw every prop the form hands them.

    TRANSFER_FORM_DUMP=<dir> pnpm --filter @mechanization/frontend test -- record-transfer-form-render
      writes each state's HTML, one tag a line, to diff against a dump from another commit.

    UPDATE_TRANSFER_FORM_RENDER=1 pnpm --filter @mechanization/frontend test -- record-transfer-form-render
      rewrites the fixture, when the markup is meant to change.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ createTransfer: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  createTransfer: api.createTransfer,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, warning: () => {}, error: () => {} }) }));
vi.mock('@/components/ui/select', async () => (await import('./transfer-form-harness')).selectStandIn);
vi.mock('@/components/ui/date-picker', async () => (await import('./transfer-form-harness')).datePickerStandIn);

const FIXTURE = join(__dirname, '__fixtures__', 'record-transfer-form-render.json');

let page: Page;

type Props = Partial<Parameters<typeof RecordTransferForm>[0]>;
const form = (locale: 'ar' | 'en', props: Props = {}) =>
  createElement(RecordTransferForm, {
    tenant: TENANT,
    token: 'tok',
    locale,
    backHref: '/t1/office/finance/transfers',
    accounts: ACCOUNTS,
    rate: RATE,
    onRecorded: () => {},
    onPrint: () => {},
    ...props,
  });

const lost = () => new ApiRequestError(0, { code: 'NETWORK_ERROR', message: 'server words' });

/** One state each, reached as a person reaches it; the script runs after the mount. */
const SCENARIOS: Record<string, { locale?: 'ar'; props?: Props; script?: () => Promise<void> }> = {
  'empty-ar': { locale: 'ar' },
  'empty-en': {},
  'empty-submitted': { script: () => submitForm(page) },
  'nowhere-to-send': { script: () => pick(FROM, DOLLARS) },
  'transfer-filled': {
    script: async () => {
      await fillTransfer(page);
      await type(page, 'transfer-feeAmount', '1000');
    },
  },
  'transfer-short': { script: () => fillTransfer(page, '9000000') },
  'transfer-backdated': {
    script: async () => {
      await fillTransfer(page);
      await type(page, 'transfer-date', '2026-11-01');
    },
  },
  'transfer-refused': {
    script: async () => {
      api.createTransfer.mockRejectedValueOnce(new ApiRequestError(400, { code: 'VALIDATION_FAILED', message: 'x' }));
      await fillTransfer(page);
      await press(page);
    },
  },
  'transfer-sending': {
    script: async () => {
      api.createTransfer.mockImplementationOnce(() => new Promise(() => {}));
      await fillTransfer(page);
      await press(page);
    },
  },
  'transfer-recorded': {
    script: async () => {
      api.createTransfer.mockResolvedValueOnce({ id: 'tr-1', transferNumber: 'TR-1', replayed: false });
      await fillTransfer(page);
      await press(page);
    },
  },
  'transfer-short-in-doubt': {
    script: async () => {
      api.createTransfer.mockRejectedValueOnce(lost());
      await fillTransfer(page);
      await press(page);
      await page.mount(
        form('en', { accounts: ACCOUNTS.map((account) => (account.id === SAFE ? { ...account, balance: 20_000 } : account)) }),
      );
    },
  },
  'exchange-empty': { script: () => chooseKind(page, en.finance.transfers.form.kinds.EXCHANGE) },
  'exchange-empty-ar': { locale: 'ar', script: () => chooseKind(page, ar.finance.transfers.form.kinds.EXCHANGE) },
  'exchange-within': { script: () => fillExchange(page) },
  'exchange-beyond': { script: () => fillExchange(page, '9500000') },
  'exchange-beyond-submitted': {
    script: async () => {
      await fillExchange(page, '9500000');
      await press(page);
    },
  },
  'exchange-large': { script: () => fillExchange(page, '53700000', '600') },
  'exchange-no-official-rate': { props: { rate: { ...RATE, exchangeRate: null } }, script: () => fillExchange(page) },
};

/** React's generated ids (`:r4:`) count up across the file, so they are numbered out. */
const normalised = (html: string): string => html.replace(/:r[0-9a-z]+:/g, ':rN:');
const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

async function render(name: string): Promise<string> {
  const scenario = SCENARIOS[name]!;
  const locale = scenario.locale ?? 'en';
  spendKey(TENANT, 'transfer:new');
  await page.mount(form(locale, scenario.props), locale);
  await scenario.script?.();
  return normalised(page.container.innerHTML);
}

function fresh(): void {
  page.close();
  page = openPage();
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
});
afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_TRANSFER_FORM_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});
beforeEach(() => {
  api.createTransfer.mockReset();
  page = openPage();
});
afterEach(() => page.close());

describe('the transfer form’s markup, state by state', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_TRANSFER_FORM_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(Object.keys(SCENARIOS))('%s is the page it was', async (name) => {
    const html = await render(name);
    observed[name] = fingerprint(html);

    const dump = process.env.TRANSFER_FORM_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_TRANSFER_FORM_RENDER) return;
    expect(observed[name], `${name}: set TRANSFER_FORM_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('each state is rendered twice the same, so a difference is a change and not noise', async () => {
    for (const name of ['empty-en', 'exchange-beyond', 'transfer-short-in-doubt']) {
      api.createTransfer.mockReset();
      const first = await render(name);
      fresh();
      expect(await render(name), name).toBe(first);
      fresh();
    }
  });

  it('reaches states that differ from each other, so no script silently did nothing', async () => {
    const pages = new Map<string, string>();
    for (const name of Object.keys(SCENARIOS)) {
      api.createTransfer.mockReset();
      pages.set(name, await render(name));
      fresh();
    }
    expect(new Set(pages.values()).size).toBe(pages.size);
    const words = en.finance.transfers.form;
    expect(pages.get('empty-submitted')).toContain(words.errors.fromAccountId);
    expect(pages.get('nowhere-to-send')).toContain(words.noSameCurrency);
    expect(pages.get('transfer-short')).toContain(words.shortBody);
    expect(pages.get('transfer-backdated')).toContain('transfer-backdateReason');
    expect(pages.get('transfer-sending')).toContain(words.saving);
    expect(pages.get('transfer-short-in-doubt')).toContain(words.shortInDoubt);
    expect(pages.get('exchange-beyond')).toContain('transfer-adjustmentReason');
    expect(pages.get('exchange-beyond-submitted')).toContain(words.errors.adjustmentReason);
    expect(pages.get('exchange-large')).toContain('above the large-exchange threshold');
    expect(pages.get('exchange-no-official-rate')).toContain(words.reviewNoRate);
  });
});
