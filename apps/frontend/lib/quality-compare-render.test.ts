// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, createElement } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLabels } from '@mechanization/shared-schemas';
import { ApiRequestError } from '@/lib/api-client';
import { FindingCompare } from '@/components/admin/quality/finding-compare';
import {
  ABROAD,
  ALI,
  EAST,
  EAST_BUILDING,
  FIRST,
  ONE_RECORD,
  SECOND,
  TWO_BUILDINGS,
  TWO_CITIZENS,
  WEST_BUILDING,
  file,
} from './quality-compare-harness';
import { BASE, TENANT, heldRead, openScreen, settle, type Screen } from './quality-review-harness';

/*
  The comparison «الإجراء», fingerprinted in both languages (PAGE-13, cleanup sprint, 2026-11-25), before it is
  split and its words move to messages. The same rules as the other quality nets: a split and a move of the
  words must each leave every fingerprint where it was. The whole body is read, so the confirmation is in it.

    QUALITY_COMPARE_DUMP=<dir> pnpm --filter @mechanization/frontend test -- quality-compare-render
      writes each state's HTML, one tag a line, to diff against a dump from another commit.

    UPDATE_QUALITY_COMPARE_RENDER=1 pnpm --filter @mechanization/frontend test -- quality-compare-render
      rewrites the fixture, when the markup is meant to change.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* A 5xx or an unknown error loads the Sentry SDK to report it: seconds of import inside a test on a busy machine. */
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));

const api = vi.hoisted(() => ({ getCitizenProfile: vi.fn(), getCitizenForm: vi.fn(), getBuilding: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  ...api,
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, warning: () => {}, error: () => {} }) }));
vi.mock('next/navigation', () => {
  const router = { push: () => {}, replace: () => {}, prefetch: () => {} };
  return { useRouter: () => router };
});
vi.mock('@/components/admin/merge-citizens-dialog', () => ({ MergeCitizensDialog: () => null }));
/* Dates are stood in for by their own input, as in the other quality nets. */
vi.mock('@/lib/dates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates')>()),
  formatDate: (value: string) => `date(${value})`,
}));

const FIXTURE = join(__dirname, '__fixtures__', 'quality-compare-render.json');
type Locale = 'ar' | 'en';
type Props = Partial<Parameters<typeof FindingCompare>[0]>;
let screen: Screen;

const words = (locale: Locale, ar: string, en: string) => (locale === 'en' ? en : ar);
async function press(scope: ParentNode, label: string): Promise<void> {
  const button = [...scope.querySelectorAll('button')].find((node) => node.textContent?.trim() === label);
  if (!button) throw new Error(`no button «${label}»`);
  await act(async () => button.click());
  await settle();
}
/** The first file's side of a fact's row. */
const cell = (label: string) =>
  [...screen.container.querySelectorAll('dl > div')]
    .find((node) => node.querySelector('dt')?.textContent === label)!
    .querySelectorAll('dd')[0]!;
const editOn = async (locale: Locale, field: 'phone' | 'motherName' | 'name') => {
  const label = field === 'name' ? words(locale, 'الاسم الكامل', 'Full name') : getLabels(locale).citizenField[field]!;
  await press(cell(label), words(locale, 'تعديل', 'Edit'));
};
async function type(id: string, value: string): Promise<void> {
  const node = screen.container.querySelector<HTMLInputElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const refusal = () => Promise.reject(new ApiRequestError(500, { code: 'INTERNAL_ERROR', message: 'x' }));
const never = () => heldRead<never>().promise;

interface Scenario {
  props?: Props;
  reply?: () => void;
  script?: (locale: Locale) => Promise<void>;
}

const SCENARIOS: Record<string, Scenario> = {
  citizens: {},
  'citizens-officer': { props: { canMerge: false } },
  'citizens-reviewer': { props: { canEdit: false, canMerge: false } },
  'citizens-abroad': {
    reply: () => api.getCitizenProfile.mockImplementation((_t: string, _k: string, id: string) => Promise.resolve(id === ALI ? FIRST : ABROAD)),
  },
  'citizens-loading': { reply: () => api.getCitizenProfile.mockImplementation(never) },
  'citizens-failed': { reply: () => api.getCitizenProfile.mockImplementation(refusal) },
  'editing-name': { script: (locale) => editOn(locale, 'name') },
  'editing-phone': { script: (locale) => editOn(locale, 'phone') },
  'editing-opening': {
    reply: () => api.getCitizenForm.mockImplementation(never),
    script: (locale) => editOn(locale, 'motherName'),
  },
  asking: {
    script: async (locale) => {
      await editOn(locale, 'phone');
      await type('edit-0-phone', '+96171000000');
      await press(screen.container, words(locale, 'حفظ', 'Save'));
    },
  },
  buildings: { props: { finding: TWO_BUILDINGS } },
  'buildings-loading': { props: { finding: TWO_BUILDINGS }, reply: () => api.getBuilding.mockImplementation(never) },
  'buildings-failed': { props: { finding: TWO_BUILDINGS }, reply: () => api.getBuilding.mockImplementation(refusal) },
  'one-record': { props: { finding: ONE_RECORD } },
};
const CASES = Object.keys(SCENARIOS).flatMap((name) => [`${name} ar`, `${name} en`]);

/** React's generated ids count up across the file, so they are numbered out. */
const normalised = (html: string): string => html.replace(/:r[0-9a-z]+:/g, ':rN:');
const fingerprint = (html: string) => ({ length: html.length, sha256: createHash('sha256').update(html).digest('hex') });
const observed: Record<string, { length: number; sha256: string }> = {};

async function render(name: string): Promise<string> {
  const [id, locale] = name.split(' ') as [string, Locale];
  const scenario = SCENARIOS[id]!;
  for (const spy of Object.values(api)) spy.mockReset();
  api.getCitizenProfile.mockImplementation((_t: string, _k: string, citizen: string) =>
    Promise.resolve(citizen === ALI ? FIRST : SECOND),
  );
  api.getCitizenForm.mockImplementation((_t: string, _k: string, citizen: string) => Promise.resolve(file(citizen)));
  api.getBuilding.mockImplementation((_t: string, _k: string, structure: string) =>
    Promise.resolve(structure === EAST ? EAST_BUILDING : WEST_BUILDING),
  );
  scenario.reply?.();
  await screen.mount(
    createElement(FindingCompare, {
      finding: TWO_CITIZENS,
      tenant: TENANT,
      base: BASE,
      locale,
      token: 'tok',
      canEdit: true,
      canMerge: true,
      onBack: () => {},
      onChanged: () => {},
      ...scenario.props,
    }),
    locale,
  );
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
  if (process.env.UPDATE_QUALITY_COMPARE_RENDER) {
    const sorted = Object.fromEntries(Object.entries(observed).sort(([a], [b]) => a.localeCompare(b)));
    mkdirSync(join(__dirname, '__fixtures__'), { recursive: true });
    writeFileSync(FIXTURE, JSON.stringify(sorted, null, 2) + '\n');
  }
});

describe('the comparison, state by state, in both languages', () => {
  const expected: Record<string, { length: number; sha256: string }> = process.env.UPDATE_QUALITY_COMPARE_RENDER
    ? {}
    : JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it.each(CASES)('%s is the page it was', async (name) => {
    const html = await render(name);
    observed[name] = fingerprint(html);

    const dump = process.env.QUALITY_COMPARE_DUMP;
    if (dump) {
      mkdirSync(dump, { recursive: true });
      writeFileSync(join(dump, `${name.replace(' ', '.')}.html`), html.replace(/></g, '>\n<'));
    }

    if (process.env.UPDATE_QUALITY_COMPARE_RENDER) return;
    expect(observed[name], `${name}: set QUALITY_COMPARE_DUMP=<dir> to write the page and diff it`).toEqual(expected[name]);
  });

  it('reaches states that differ from each other, so no script or reply silently did nothing', { timeout: 30_000 }, async () => {
    const pages = new Map<string, string>();
    for (const name of CASES) {
      pages.set(name, await render(name));
      fresh();
    }
    expect(new Set(pages.values()).size).toBe(pages.size);
    expect(pages.get('citizens-reviewer en')).toContain('Your role reviews records');
    expect(pages.get('citizens-failed ar')).toContain('تعذّر تحميل السجلّين.');
    expect(pages.get('editing-name en')).toContain('edit-0-middleName');
    expect(pages.get('editing-opening en')).toContain('animate-spin');
    expect(pages.get('asking en')).toContain('Save this change?');
    expect(pages.get('buildings en')).toContain('X-498-B');
    expect(pages.get('one-record en')).toContain('nothing to set against it');
  });
});
