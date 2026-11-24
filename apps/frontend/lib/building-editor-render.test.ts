import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BuildingEditor } from '@/components/admin/building-editor';
import { ToastProvider } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';

/*
  The building editor, rendered on the server, one page per step (GOD-21, phase 1).

  The same net as the citizen form's (`citizen-form-render.test.ts`): render before,
  render after a move, compare the page's length and SHA-256 with
  `lib/__fixtures__/building-editor-render.json`. The editor shows one step at a
  time, so each step of a creation is a page of its own, in each language.

  What it does NOT see: effects, anything after a click (the behaviour is
  `building-editor-dom.test.ts`'s), the map (stubbed: jsdom and node have no WebGL,
  so what `ParcelPinPicker` draws is not in these pages), and an edit, which shows a
  spinner until its building loads. A move that touches those is read in review.

    BUILDING_EDITOR_DUMP=<dir> pnpm --filter @mechanization/frontend test -- building-editor-render

  writes every page one tag per line, to diff against a dump from the commit before;

    UPDATE_BUILDING_EDITOR_RENDER=1 pnpm --filter @mechanization/frontend test -- building-editor-render

  rewrites the fixture when the markup changed on purpose.
*/
vi.mock('next/navigation', () => ({
  useParams: () => ({ tenant: 't', locale: 'ar', adminPath: 'a' }),
  useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
  usePathname: () => '/t/ar/a/buildings/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/use-staff-session', () => ({
  useStaffSession: () => ({ token: null, user: null }),
}));
vi.mock('@/components/admin/parcel-pin-picker', () => ({
  ParcelPinPicker: () => null,
  footprintOf: () => null,
  outlineOf: () => null,
  parcelAt: () => null,
  parcelsOf: () => [],
  floorLabel: (floor: number) => `floor ${floor}`,
  loadParcelLabelPoints: async () => null,
  loadParcelOutlines: async () => null,
}));

const FIXTURE = join(__dirname, '__fixtures__', 'building-editor-render.json');
const messages = {
  ar: JSON.parse(readFileSync(join(__dirname, '../messages/ar.json'), 'utf8')),
  en: JSON.parse(readFileSync(join(__dirname, '../messages/en.json'), 'utf8')),
};

interface Scenario {
  locale: 'ar' | 'en';
  props?: Record<string, unknown>;
}

const SCENARIOS: Record<string, Scenario> = {
  'create-step0-ar': { locale: 'ar' },
  'create-step1-ar': { locale: 'ar', props: { initialStep: 1 } },
  'create-step2-ar': { locale: 'ar', props: { initialStep: 2 } },
  'create-step0-en': { locale: 'en' },
  'create-step2-en': { locale: 'en', props: { initialStep: 2 } },
  // The wizard for «تعديل معلومات المبنى» has no matrix step; with no building loaded it is a spinner either way.
  'create-from-a-parcel-ar': { locale: 'ar', props: { initialParcelNumber: '1042' } },
};

function normalise(html: string): string {
  const seen = new Map<string, string>();
  return html.replace(/:[Rr][0-9a-z]+:/g, (id) => {
    if (!seen.has(id)) seen.set(id, `:id${seen.size}:`);
    return seen.get(id)!;
  });
}

function render(scenario: Scenario): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return normalise(
    renderToStaticMarkup(
      createElement(NextIntlClientProvider, {
        locale: scenario.locale,
        messages: messages[scenario.locale],
        children: createElement(QueryClientProvider, {
          client,
          children: createElement(TooltipProvider, {
            children: createElement(ToastProvider, {
              children: createElement(BuildingEditor, {
                tenant: 't',
                locale: scenario.locale,
                adminPath: 'a',
                ...scenario.props,
              }),
            }),
          }),
        }),
      }),
    ),
  );
}

const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
  if (process.env.UPDATE_BUILDING_EDITOR_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});

describe('the building editor’s first paint', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_BUILDING_EDITOR_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(Object.keys(SCENARIOS))('%s is the page it was', (name) => {
    const html = render(SCENARIOS[name]);
    observed[name] = fingerprint(html);

    const dump = process.env.BUILDING_EDITOR_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_BUILDING_EDITOR_RENDER) return;
    expect(observed[name], `${name}: set BUILDING_EDITOR_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('each page is rendered twice the same, so a difference is a change and not noise', () => {
    for (const name of Object.keys(SCENARIOS)) expect(render(SCENARIOS[name])).toBe(render(SCENARIOS[name]));
  });

  it('each step is a page of its own, and the parcel from the map or the list is in the first one', () => {
    const pages = new Set(['create-step0-ar', 'create-step1-ar', 'create-step2-ar'].map((n) => render(SCENARIOS[n])));
    expect(pages.size).toBe(3);
    expect(render(SCENARIOS['create-from-a-parcel-ar'])).toContain('value="1042"');
    expect(render(SCENARIOS['create-step0-ar'])).not.toContain('value="1042"');
  });
});
