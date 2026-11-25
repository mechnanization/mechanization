// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '@/lib/api-client';
import { ReviewQueue } from '@/components/admin/quality/review-queue';
import { ChecksPanel } from '@/components/admin/quality/checks-panel';
import {
  APPROVED,
  ASSIGNED_CHECK,
  BASE,
  CHANGED,
  CORRECTED,
  DIFFERING,
  FULL,
  MATCHING,
  OFFICERS,
  PATH,
  RETURNED,
  TENANT,
  UNASSIGNED_CHECK,
  click,
  heldRead,
  openScreen,
  queue,
  type Screen,
} from './quality-review-harness';

/*
  «اعتماد السجلات» and «عيّنة التحقق», fingerprinted in both languages (PAGE-13, cleanup sprint, 2026-11-25),
  before the review queue is split and both screens' words move to messages.

  A split that only moves JSX, and a move of the words from `en ? 'x' : 'y'` to messages that keeps every
  word, must each leave every fingerprint where it was: that is how the wording is shown identical in Arabic
  and in English. Each state is reached as a reviewer reaches it, then the HTML is taken, with the clock
  fixed and React's generated ids numbered out.

    QUALITY_REVIEW_DUMP=<dir> pnpm --filter @mechanization/frontend test -- quality-review-render
      writes each state's HTML, one tag a line, to diff against a dump from another commit.

    UPDATE_QUALITY_REVIEW_RENDER=1 pnpm --filter @mechanization/frontend test -- quality-review-render
      rewrites the fixture, when the markup is meant to change.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({ getReviewQueue: vi.fn(), getQualityChecks: vi.fn() }));
vi.mock('@/lib/quality-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/quality-api')>()),
  getReviewQueue: api.getReviewQueue,
  getQualityChecks: api.getQualityChecks,
}));
vi.mock('next/navigation', async () => (await import('./quality-review-harness')).navigationStandIn);
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, warning: () => {}, error: () => {} }) }));
vi.mock('@/components/ui/select', async () => (await import('./transfer-form-harness')).selectStandIn);
vi.mock('@/components/ui/date-picker', async () => (await import('./transfer-form-harness')).datePickerStandIn);
vi.mock('@/components/admin/complete-record-dialog', () => ({ CompleteRecordDialog: () => null }));
/*
  Dates are stood in for by their own input: how a date reads differs between the Node that runs CI and a
  laptop's (time zone, ICU), and it is the formatter's to test, not this page's. Which date goes where is.
*/
vi.mock('@/lib/dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates')>()),
  formatDate: (value: string) => `date(${value})`,
  formatDateTime: (value: string) => `dateTime(${value})`,
  formatRelative: (value: string, locale: string) => `relative(${value},${locale})`,
}));

const FIXTURE = join(__dirname, '__fixtures__', 'quality-review-render.json');

let screen: Screen;
type Locale = 'ar' | 'en';

const reviews = (locale: Locale): ReactElement =>
  createElement(ReviewQueue, { tenant: TENANT, base: BASE, locale, token: 'tok', officers: OFFICERS });
const checks = (locale: Locale, canReview = true): ReactElement =>
  createElement(ChecksPanel, { tenant: TENANT, base: BASE, locale, token: 'tok', canReview, officers: OFFICERS });

const never = () => heldRead<never>().promise;
const refusal = () => Promise.reject(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'server words' }));

interface Scenario {
  query?: string;
  element: (locale: Locale) => ReactElement;
  reply: () => void;
  script?: (locale: Locale) => Promise<void>;
}
const words = (locale: Locale, ar: string, en: string) => (locale === 'en' ? en : ar);

const SCENARIOS: Record<string, Scenario> = {
  'reviews-to-review': { element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([FULL, CORRECTED, CHANGED])) },
  'reviews-returned': { query: '?queue=RETURNED', element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([RETURNED])) },
  'reviews-approved': { query: '?queue=APPROVED', element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([APPROVED])) },
  'reviews-paged-filtered': {
    query: `?officer=${OFFICERS[0]!.id}&flagged=1&page=2`,
    element: reviews,
    reply: () => api.getReviewQueue.mockResolvedValue(queue([FULL], 61)),
  },
  'reviews-empty-to-review': { element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([])) },
  'reviews-empty-returned': { query: '?queue=RETURNED', element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([])) },
  'reviews-empty-approved': { query: '?queue=APPROVED', element: reviews, reply: () => api.getReviewQueue.mockResolvedValue(queue([])) },
  'reviews-loading': { element: reviews, reply: () => api.getReviewQueue.mockImplementation(never) },
  'reviews-failed': { element: reviews, reply: () => api.getReviewQueue.mockImplementation(refusal) },
  'reviews-returning': {
    element: reviews,
    reply: () => api.getReviewQueue.mockResolvedValue(queue([CHANGED])),
    script: (locale) => click(screen, words(locale, 'إعادة إلى الموظف', 'Return to the officer')),
  },
  'checks-open': { element: checks, reply: () => api.getQualityChecks.mockResolvedValue({ items: [UNASSIGNED_CHECK, ASSIGNED_CHECK] }) },
  'checks-open-officer': {
    element: (locale) => checks(locale, false),
    reply: () => api.getQualityChecks.mockResolvedValue({ items: [UNASSIGNED_CHECK, ASSIGNED_CHECK] }),
  },
  'checks-done': { query: '?status=DONE', element: checks, reply: () => api.getQualityChecks.mockResolvedValue({ items: [MATCHING, DIFFERING] }) },
  'checks-empty': { element: checks, reply: () => api.getQualityChecks.mockResolvedValue({ items: [] }) },
  'checks-empty-officer': { element: (locale) => checks(locale, false), reply: () => api.getQualityChecks.mockResolvedValue({ items: [] }) },
  'checks-empty-done': { query: '?status=DONE', element: checks, reply: () => api.getQualityChecks.mockResolvedValue({ items: [] }) },
  'checks-loading': { element: checks, reply: () => api.getQualityChecks.mockImplementation(never) },
  'checks-failed': { element: checks, reply: () => api.getQualityChecks.mockImplementation(refusal) },
  'checks-answering': {
    element: checks,
    reply: () => api.getQualityChecks.mockResolvedValue({ items: [UNASSIGNED_CHECK] }),
    script: (locale) => click(screen, words(locale, 'تسجيل ما وجدته', 'Record what you found')),
  },
  'checks-answering-differs': {
    element: checks,
    reply: () => api.getQualityChecks.mockResolvedValue({ items: [UNASSIGNED_CHECK] }),
    script: async (locale) => {
      await click(screen, words(locale, 'تسجيل ما وجدته', 'Record what you found'));
      await click(screen, words(locale, 'هناك ما يختلف', 'Something is different'));
    },
  },
};
const CASES = Object.keys(SCENARIOS).flatMap((name) => [`${name} ar`, `${name} en`]);

/**
 * What differs between two renders of one page: React's generated ids (`:r4:`, `radix-:r7:`) count up across the
 * file, and a Radix tab panel holds `animation-duration: 0s` until the next animation frame, which on a busy
 * machine comes after the page is read. Both are written as the settled page has them.
 */
const normalised = (html: string): string =>
  html.replace(/:r[0-9a-z]+:/g, ':rN:').replaceAll('style="animation-duration: 0s;"', 'style=""');
const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

async function render(name: string): Promise<string> {
  const [id, locale] = name.split(' ') as [string, Locale];
  const scenario = SCENARIOS[id]!;
  api.getReviewQueue.mockReset();
  api.getQualityChecks.mockReset();
  scenario.reply();
  window.history.replaceState(null, '', `${PATH}${scenario.query ?? ''}`);
  await screen.mount(scenario.element(locale), locale);
  await scenario.script?.(locale);
  return normalised(screen.container.innerHTML);
}
function fresh(): void {
  screen.close();
  screen = openScreen();
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_QUALITY_REVIEW_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});
beforeEach(() => {
  screen = openScreen();
});
afterEach(() => screen.close());

describe('the review queue and the checks, state by state, in both languages', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_QUALITY_REVIEW_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(CASES)('%s is the page it was', async (name) => {
    const html = await render(name);
    observed[name] = fingerprint(html);

    const dump = process.env.QUALITY_REVIEW_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name.replace(' ', '.')}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_QUALITY_REVIEW_RENDER) return;
    expect(observed[name], `${name}: set QUALITY_REVIEW_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('reaches states that differ from each other, so no script or reply silently did nothing', async () => {
    const pages = new Map<string, string>();
    for (const name of CASES) {
      pages.set(name, await render(name));
      fresh();
    }
    expect(new Set(pages.values()).size).toBe(pages.size);
    expect(pages.get('reviews-to-review en')).toContain('Citizen 1');
    expect(pages.get('reviews-returning en')).toContain('return-reason');
    expect(pages.get('reviews-failed en')).toContain('Could not load the review queue.');
    expect(pages.get('reviews-paged-filtered en')).toContain('Page 2 of 3');
    expect(pages.get('checks-failed ar')).toContain('تعذّر تحميل عمليات التحقق.');
    expect(pages.get('checks-answering-differs en')).toContain('What did you find on the ground?');
    expect(pages.get('checks-done en')).toContain('The area is half what was filed');
  });
});
