// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { FindingsList } from '@/components/admin/quality/findings-list';
import { ALL, SETTLED, TWICE, NO_AREA, findings } from './quality-findings-harness';
import { BASE, PATH, TENANT, heldRead, openScreen, settle, type Screen } from './quality-review-harness';

/*
  «ملاحظات الجودة», fingerprinted in both languages (PAGE-13, cleanup sprint, 2026-11-25), before its files
  are split and their words move to messages. The same rules as the review queue's net
  (`quality-review-render.test.ts`): a split and a move of the words must each leave every fingerprint where it
  was. The whole body is read, so a dialog is in its page.

    QUALITY_FINDINGS_DUMP=<dir> pnpm --filter @mechanization/frontend test -- quality-findings-render
      writes each state's HTML, one tag a line, to diff against a dump from another commit.

    UPDATE_QUALITY_FINDINGS_RENDER=1 pnpm --filter @mechanization/frontend test -- quality-findings-render
      rewrites the fixture, when the markup is meant to change.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({ getFindings: vi.fn() }));
vi.mock('@/lib/quality-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quality-api')>()),
  getFindings: api.getFindings,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, warning: () => {}, error: () => {} }) }));
vi.mock('next/navigation', async () => (await import('./quality-review-harness')).navigationStandIn);
vi.mock('@/components/admin/quality/finding-compare', () => ({ FindingCompare: () => null }));
/* Dates are stood in for by their own input, as in the review queue's net. */
vi.mock('@/lib/dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates')>()),
  formatDateTime: (value: string) => `dateTime(${value})`,
  formatRelative: (value: string, locale: string) => `relative(${value},${locale})`,
}));

const FIXTURE = join(__dirname, '__fixtures__', 'quality-findings-render.json');
type Locale = 'ar' | 'en';
let screen: Screen;
const list = (locale: 'ar' | 'en' = 'en', role = 'SUPER_ADMIN'): ReactElement =>
  createElement(TooltipProvider, {
    children: createElement(FindingsList, { tenant: TENANT, base: BASE, locale, token: 'tok', role }),
  });

async function click(selector: (nodes: HTMLElement[]) => HTMLElement | undefined): Promise<void> {
  const node = selector([...document.body.querySelectorAll<HTMLElement>('button, a')]);
  if (!node) throw new Error('nothing to press');
  await act(async () => node.click());
  await settle();
}
const named = (label: string) => (nodes: HTMLElement[]) =>
  nodes.find((node) => node.getAttribute('aria-label') === label || node.textContent?.trim() === label);
const words = (locale: Locale, ar: string, en: string) => (locale === 'en' ? en : ar);
const everything = findings([...ALL, SETTLED]);

interface Scenario {
  query?: string;
  role?: string;
  reply?: () => void;
  script?: (locale: Locale) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  list: {},
  'list-auditor': { role: 'AUDITOR' },
  'list-resolved': { query: '?dismissed=1', reply: () => api.getFindings.mockResolvedValue(everything) },
  'list-narrowed': { query: '?kind=DUPLICATE_CITIZEN' },
  'list-empty': { reply: () => api.getFindings.mockResolvedValue({ items: [], counts: {} }) },
  'list-loading': { reply: () => api.getFindings.mockImplementation(() => heldRead<never>().promise) },
  'list-failed': {
    reply: () => api.getFindings.mockRejectedValue(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'x' })),
  },
  'details-pair': { query: `?finding=DUPLICATE_CITIZEN|${TWICE.subjectKey}` },
  'details-building': { query: `?finding=UNITS_WITHOUT_AREA|${NO_AREA.subjectKey}` },
  'details-resolved': {
    query: `?dismissed=1&finding=OCCUPANT_HAS_LANDLORD_PHONE|${SETTLED.subjectKey}`,
    reply: () => api.getFindings.mockResolvedValue(everything),
  },
  'details-gone': { query: `?finding=DUPLICATE_CITIZEN|${NO_AREA.subjectKey}` },
  resolving: {
    script: async (locale) => {
      await click(named(words(locale, 'تم الحل', 'Resolved')));
    },
  },
};
const CASES = Object.keys(SCENARIOS).flatMap((name) => [`${name} ar`, `${name} en`]);

/** React's generated ids count up across the file, so they are numbered out. */
const normalised = (html: string): string => html.replace(/:r[0-9a-z]+:/g, ':rN:');
const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

async function render(name: string): Promise<string> {
  const [id, locale] = name.split(' ') as [string, Locale];
  const scenario = SCENARIOS[id]!;
  api.getFindings.mockReset();
  api.getFindings.mockResolvedValue(findings());
  scenario.reply?.();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, '', `${PATH}${scenario.query ?? ''}`);
  await screen.mount(list(locale, scenario.role), locale);
  await scenario.script?.(locale);
  return normalised(document.body.innerHTML);
}
function fresh(): void {
  screen.close();
  document.body.innerHTML = '';
  screen = openScreen();
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  screen = openScreen();
});
afterEach(() => {
  screen.close();
  document.body.innerHTML = '';
});
afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_QUALITY_FINDINGS_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});

describe('the findings, state by state, in both languages', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_QUALITY_FINDINGS_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(CASES)('%s is the page it was', async (name) => {
    const html = await render(name);
    observed[name] = fingerprint(html);

    const dump = process.env.QUALITY_FINDINGS_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name.replace(' ', '.')}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_QUALITY_FINDINGS_RENDER) return;
    expect(observed[name], `${name}: set QUALITY_FINDINGS_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('reaches states that differ from each other, so no script or reply silently did nothing', { timeout: 30_000 }, async () => {
    const pages = new Map<string, string>();
    for (const name of CASES) {
      pages.set(name, await render(name));
      fresh();
    }
    expect(new Set(pages.values()).size).toBe(pages.size);
    expect(pages.get('list en')).toContain('Review unit statuses');
    expect(pages.get('list-auditor en')).not.toContain('Review unit statuses');
    expect(pages.get('list-failed ar')).toContain('تعذّر تحميل ملاحظات الجودة.');
    expect(pages.get('list-empty en')).toContain('Nothing to look at.');
    expect(pages.get('details-pair en')).toContain('The records this is about');
    expect(pages.get('details-resolved en')).toContain('Mother and son');
    expect(pages.get('details-gone en')).toContain('This finding is no longer in the queue.');
    expect(pages.get('resolving en')).toContain('At least four characters.');
  });
});
