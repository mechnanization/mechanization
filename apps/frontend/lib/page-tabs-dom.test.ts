// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { QualityTabs } from '@/components/admin/quality/quality-tabs';
import FieldWorklistsPage from '../app/[tenant]/[locale]/[adminPath]/(protected)/buildings/worklists/page';
import en from '../messages/en.json';

/*
  NAV-03 and NAV-04 (cleanup sprint, 2026-11-25): the tabs of «الجودة» and of «قوائم العمل الميداني»,
  driven in jsdom with the panels stubbed (each is a table with its own reads, and none is under test).

  What is: that only the open tab is mounted, that `?tab=` names it, and what a change of tab does to the
  rest of the query string. The quality panels share `?page=` and `?limit=`, so a change clears what they
  keep; the worklists name their keys apart, so it leaves them where they were.
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// React 18.3 has no `use` (Next's own runtime supplies it for the pages): read the settled params directly.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  use: (settled: { value: unknown }) => settled.value,
}));

// The live address, as `useUrlState` writes it (`history.replaceState`).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch() {} }),
  usePathname: () => window.location.pathname,
  useSearchParams: () => new URLSearchParams(window.location.search),
}));
vi.mock('@/lib/use-staff-query', () => ({ useStaffQuery: () => ({ data: { officers: [] } }) }));

// A panel stands in as a marker in the text; hoisted because the mock factories below run before this module's body.
const stub = vi.hoisted(() => (name: string) => () => `[panel:${name}]`);
vi.mock('@/components/admin/quality/review-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/admin/quality/review-queue')>()),
  ReviewQueue: stub('reviews'),
}));
vi.mock('@/components/admin/quality/findings-list', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/admin/quality/findings-list')>()),
  FindingsList: stub('findings'),
}));
vi.mock('@/components/admin/quality/checks-panel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/admin/quality/checks-panel')>()),
  ChecksPanel: stub('checks'),
}));
vi.mock('@/components/admin/quality/officer-quality', () => ({ OfficerQuality: stub('officers') }));
vi.mock('@/components/admin/worklists/unsurveyed-worklist', () => ({ UnsurveyedWorklist: stub('unsurveyed') }));
vi.mock('@/components/admin/worklists/reinspections-worklist', () => ({
  ReinspectionsWorklist: stub('reinspections'),
}));

let container: HTMLDivElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(createElement(NextIntlClientProvider, { locale: 'en', messages: en as never, children: element }));
  });
}

const openAt = (search: string) => window.history.replaceState(null, '', `/t/en/a/page${search}`);
const panels = () => [...(document.body.textContent ?? '').matchAll(/\[panel:(\w+)\]/g)].map((match) => match[1]);
const query = () => Object.fromEntries(new URLSearchParams(window.location.search));

/** Radix opens a tab on mousedown, not click. */
async function openTab(name: string): Promise<void> {
  const trigger = [...document.querySelectorAll('[role="tab"]')].find((node) => node.textContent === name);
  if (!trigger) throw new Error(`no tab named ${name}`);
  await act(async () => {
    trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  openAt('');
});

describe('«الجودة» (NAV-03)', () => {
  const quality = () =>
    createElement(QualityTabs, { tenant: 't', base: '/t/en/a', locale: 'en', token: 'tok', role: 'SUPER_ADMIN' });
  const tabNames = () => [...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent);

  it('lists the four tabs, «اعتماد السجلات» first, and opens on it', async () => {
    openAt('');
    await mount(quality());
    expect(tabNames()).toEqual(['Record approval', 'Findings', 'Field re-checks', 'By officer']);
    expect(panels()).toEqual(['reviews']);
  });

  it.each([
    ['findings', 'findings'],
    ['checks', 'checks'],
    ['officers', 'officers'],
    ['reviews', 'reviews'],
  ])('opens on ?tab=%s, mounting that tab’s panel and no other', async (tab, panel) => {
    openAt(`?tab=${tab}`);
    await mount(quality());
    expect(panels()).toEqual([panel]);
  });

  it('an unknown ?tab= opens the first', async () => {
    openAt('?tab=nonsense');
    await mount(quality());
    expect(panels()).toEqual(['reviews']);
  });

  it('a change of tab names it and clears what the panels keep, so the next one starts at its first page', async () => {
    openAt('?tab=findings&page=3&limit=50&kind=DUPLICATE&dismissed=1&finding=abc&queue=RETURNED&officer=u1&flagged=1&status=DONE');
    await mount(quality());
    await openTab('Field re-checks');
    expect(query()).toEqual({ tab: 'checks' });
    await mount(quality());
    expect(panels()).toEqual(['checks']);
  });

  it('leaves what is not the panels’ alone', async () => {
    openAt('?tab=reviews&page=2&utm=keep');
    await mount(quality());
    await openTab('Findings');
    expect(query()).toEqual({ tab: 'findings', utm: 'keep' });
  });
});

describe('«قوائم العمل الميداني» (NAV-04)', () => {
  const page = () =>
    createElement(FieldWorklistsPage, {
      params: Object.assign(Promise.resolve({ tenant: 't', locale: 'en', adminPath: 'a' }), {
        status: 'fulfilled' as const,
        value: { tenant: 't', locale: 'en', adminPath: 'a' },
      }),
    });

  it('opens on «وحدات غير ممسوحة», with the page’s header over the tabs', async () => {
    openAt('');
    await mount(page());
    expect([...document.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).toEqual([
      'Unsurveyed units',
      'Awaiting re-inspection',
    ]);
    expect(panels()).toEqual(['unsurveyed']);
    expect(document.querySelector('h1')?.textContent).toBe('Field worklists');
  });

  it('opens on ?tab=reinspections, mounting only that tab', async () => {
    openAt('?tab=reinspections');
    await mount(page());
    expect(panels()).toEqual(['reinspections']);
  });

  it('a change of tab names it and leaves each tab’s page and officer where they were', async () => {
    openAt('?tab=unsurveyed&page=3&limit=50&owner=u1&reinspectPage=2&reinspectLimit=10&reinspectOwner=u2');
    await mount(page());
    await openTab('Awaiting re-inspection');
    expect(query()).toEqual({
      tab: 'reinspections',
      page: '3',
      limit: '50',
      owner: 'u1',
      reinspectPage: '2',
      reinspectLimit: '10',
      reinspectOwner: 'u2',
    });
    await mount(page());
    expect(panels()).toEqual(['reinspections']);
    await openTab('Unsurveyed units');
    expect(query().tab).toBeUndefined();
    expect(query().page).toBe('3');
    expect(query().reinspectPage).toBe('2');
  });
});
