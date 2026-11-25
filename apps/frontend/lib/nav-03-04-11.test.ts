import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { STAFF_ROLE } from '@mechanization/shared-schemas';
import { activeNavItem, canAccessPath, localizedGroupLabel, localizedLabel, NAV_GROUPS, visibleGroups } from '@/components/admin/nav';
import { QUALITY_PANEL_KEYS, QUALITY_TABS } from '@/components/admin/quality/quality-tabs';
import { REVIEW_QUEUE_URL } from '@/components/admin/quality/review-queue';
import { forwardedHref } from '@/lib/legacy-address';
import { QUALITY_REVIEWER_ROLES, WORKLIST_ROLES } from '@/lib/staff-roles';
import {
  REINSPECTIONS_OWNER_KEY,
  REINSPECTIONS_PAGE_KEY,
  REINSPECTIONS_SIZE_KEY,
  WORKLIST_TABS,
} from '@/lib/worklist-tabs';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  NAV-03, NAV-04 and NAV-11 (cleanup sprint, 2026-11-25, open-decisions §25): the four quality
  rows become one page of tabs, «وحدات غير ممسوحة» and «بانتظار إعادة الكشف» become the tabs of
  «قوائم العمل الميداني», and the two queues of "records to review" are told apart by name. The
  old addresses are server redirects that keep their query strings; their pages are the rows' `also`.
*/
const BASE = '/albazourieh/ar/admin';
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const PROTECTED = 'app/[tenant]/[locale]/[adminPath]/(protected)';
const rows = NAV_GROUPS.flatMap((group) => group.items);
const rowAt = (path: string) => rows.find((row) => row.path === path);

// `redirect` throws, as Next's does, so a page's last line ends the render and the test reads where it went.
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

describe('forwardedHref', () => {
  it('keeps the query, renames what the new page needs the name for, and names the tab', () => {
    const href = forwardedHref('/t/ar/a', '/quality', { tab: 'RETURNED', officer: 'u1' }, { rename: { tab: 'queue' }, set: { tab: 'reviews' } });
    const [path, query] = href.split('?');
    expect(path).toBe('/t/ar/a/quality');
    expect(Object.fromEntries(new URLSearchParams(query))).toEqual({ queue: 'RETURNED', officer: 'u1', tab: 'reviews' });
  });

  it('keeps a repeated parameter and drops an undefined one', () => {
    const href = forwardedHref('/t/ar/a', '/x', { kind: ['a', 'b'], gone: undefined });
    expect(new URLSearchParams(href.split('?')[1]).getAll('kind')).toEqual(['a', 'b']);
    expect(href).not.toContain('gone');
  });

  it('adds no question mark to a bare address', () => {
    expect(forwardedHref('/t/ar/a', '/x', {})).toBe('/t/ar/a/x');
  });
});

describe('the old addresses forward (NAV-03, NAV-04)', () => {
  /** Opens an old address's page as Next would, and returns where it sent the reader. */
  async function forwardsTo(path: string, search: Record<string, string>): Promise<{ path: string; query: Record<string, string> }> {
    const oldPage = (await import(/* @vite-ignore */ `../${PROTECTED}/${path}/page`)) as {
      default: (props: { params: Promise<unknown>; searchParams: Promise<unknown> }) => Promise<never>;
    };
    const props = {
      params: Promise.resolve({ tenant: 't', locale: 'ar', adminPath: 'a' }),
      searchParams: Promise.resolve(search),
    };
    const message = await oldPage.default(props).then(
      () => '',
      (caught: Error) => caught.message,
    );
    const url = message.replace('REDIRECT ', '');
    const [pathname, query = ''] = url.split('?');
    return { path: pathname!, query: Object.fromEntries(new URLSearchParams(query)) };
  }

  it('«السجلات» opens the first tab, its state filter under its new name', async () => {
    expect(await forwardsTo('quality/reviews', { tab: 'RETURNED', officer: 'u1', flagged: '1', page: '2' })).toEqual({
      path: '/t/ar/a/quality',
      query: { queue: 'RETURNED', officer: 'u1', flagged: '1', page: '2', tab: 'reviews' },
    });
  });

  it.each([
    ['quality/findings', { kind: 'DUPLICATE', dismissed: '1' }, 'findings'],
    ['quality/checks', { status: 'DONE' }, 'checks'],
    ['quality/officers', {}, 'officers'],
  ] as const)('%s opens its tab with its filters', async (path, search, tab) => {
    expect(await forwardsTo(path, search)).toEqual({ path: '/t/ar/a/quality', query: { ...search, tab } });
  });

  it('every tab it names is one of the page’s, and the renamed filter is one the queue reads', () => {
    expect(QUALITY_TABS).toEqual(['reviews', 'findings', 'checks', 'officers']);
    expect(Object.keys(REVIEW_QUEUE_URL)).toContain('queue');
    expect(Object.keys(REVIEW_QUEUE_URL)).not.toContain('tab');
  });

  it('«وحدات غير ممسوحة» keeps its page, size and officer as they were', async () => {
    expect(await forwardsTo('buildings/unsurveyed', { page: '3', limit: '50', owner: 'u1' })).toEqual({
      path: '/t/ar/a/buildings/worklists',
      query: { page: '3', limit: '50', owner: 'u1', tab: 'unsurveyed' },
    });
  });

  it('«بانتظار إعادة الكشف» moves its page, size and officer to the names its tab keeps them by', async () => {
    expect(await forwardsTo('buildings/reinspections', { page: '2', limit: '10', owner: 'u1' })).toEqual({
      path: '/t/ar/a/buildings/worklists',
      query: {
        [REINSPECTIONS_PAGE_KEY]: '2',
        [REINSPECTIONS_SIZE_KEY]: '10',
        [REINSPECTIONS_OWNER_KEY]: 'u1',
        tab: 'reinspections',
      },
    });
    expect(WORKLIST_TABS).toEqual(['unsurveyed', 'reinspections']);
  });

  it('the pages are server components, with no client effect', () => {
    for (const path of ['quality/reviews', 'quality/findings', 'quality/checks', 'quality/officers', 'buildings/unsurveyed', 'buildings/reinspections']) {
      const source = read(`${PROTECTED}/${path}/page.tsx`);
      expect(source).not.toMatch(/^'use client'/);
      expect(source).toMatch(/import \{ redirect \} from 'next\/navigation';/);
      expect(source).not.toMatch(/useEffect|useRouter|Skeleton/);
    }
  });
});

describe('the sidebar after NAV-03, NAV-04 and NAV-11', () => {
  // 35 before NAV-02, 28 after NAV-03/04/11, 26 once NAV-05 folded the news rows: the approved map (§25).
  it('has 26 rows, the approved map', () => {
    expect(rows).toHaveLength(26);
  });

  it('has one «الجودة» row, which owns the four old addresses and keeps the reviewers', () => {
    expect(rows.filter((row) => row.path.startsWith('/quality'))).toHaveLength(1);
    const row = rowAt('/quality');
    expect(row && localizedLabel(row, 'ar')).toBe('الجودة');
    expect(row && localizedLabel(row, 'en')).toBe('Quality');
    expect(row?.also).toEqual(['/quality/reviews', '/quality/findings', '/quality/checks', '/quality/officers']);
    expect(row?.roles).toEqual(QUALITY_REVIEWER_ROLES);
  });

  it('has one «قوائم العمل الميداني» row, which owns both old addresses and keeps the worklist roles', () => {
    expect(rows.filter((row) => /^\/buildings\/(unsurveyed|reinspections|worklists)/.test(row.path))).toHaveLength(1);
    const row = rowAt('/buildings/worklists');
    expect(row && localizedLabel(row, 'ar')).toBe('قوائم العمل الميداني');
    expect(row && localizedLabel(row, 'en')).toBe('Field worklists');
    expect(row?.also).toEqual(['/buildings/unsurveyed', '/buildings/reinspections']);
    expect(row?.roles).toEqual(WORKLIST_ROLES);
  });

  it('guards every old address by its new row, for every role', () => {
    for (const [row, old] of [
      ['/quality', ['/quality/reviews', '/quality/findings', '/quality/checks', '/quality/officers']],
      ['/buildings/worklists', ['/buildings/unsurveyed', '/buildings/reinspections']],
    ] as const) {
      for (const role of STAFF_ROLE) {
        for (const path of old) {
          expect(canAccessPath(`${BASE}${path}`, BASE, role)).toBe(canAccessPath(`${BASE}${row}`, BASE, role));
          expect(activeNavItem(`${BASE}${path}`, BASE, role)?.path).toBe(activeNavItem(`${BASE}${row}`, BASE, role)?.path);
        }
      }
    }
    expect(canAccessPath(`${BASE}/quality/reviews`, BASE, 'COLLECTOR')).toBe(false);
    expect(canAccessPath(`${BASE}/quality/reviews`, BASE, 'AUDITOR')).toBe(true);
    /*
      Not pinned, on purpose: a role outside `WORKLIST_ROLES` falls through to the `/buildings` row it can
      see (the longest *visible* row), here as it did on the two old pages. The server refuses its read.
    */
  });

  it('leaves «المراجعة والتدقيق» with «الجودة» and «سجل النشاطات»', () => {
    const group = visibleGroups('SUPER_ADMIN').find((candidate) => localizedGroupLabel(candidate, 'ar') === 'المراجعة والتدقيق');
    expect(group?.items.map((item) => item.path)).toEqual(['/quality', '/audit']);
  });

  it('puts «قوائم العمل الميداني» ahead of «الحالات» in «العمل الميداني»', () => {
    const group = visibleGroups('SUPER_ADMIN').find((candidate) => localizedGroupLabel(candidate, 'ar') === 'العمل الميداني');
    expect(group?.items.map((item) => item.path)).toEqual(['/buildings/worklists', '/cases']);
  });
});

describe('the two queues of "records to review" are told apart (NAV-11)', () => {
  it('names `/citizens/review` «ملفات ناقصة» / "Incomplete files", on its row and its page', () => {
    const row = rowAt('/citizens/review');
    expect(row && localizedLabel(row, 'ar')).toBe('ملفات ناقصة');
    expect(row && localizedLabel(row, 'en')).toBe('Incomplete files');
    expect(ar.reviewQueue.title).toBe('ملفات ناقصة');
    expect(en.reviewQueue.title).toBe('Incomplete files');
  });

  it('names the other «اعتماد السجلات» / "Record approval", as the first tab of «الجودة»', () => {
    expect(ar.quality.tabs.reviews).toBe('اعتماد السجلات');
    expect(en.quality.tabs.reviews).toBe('Record approval');
  });

  it('no row, page title or tab still calls either «يتطلب مراجعة» or «السجلات»', () => {
    for (const row of rows) {
      expect(localizedLabel(row, 'ar')).not.toBe('يتطلب مراجعة');
      expect(localizedLabel(row, 'ar')).not.toBe('السجلات');
      expect(localizedLabel(row, 'en')).not.toBe('Requires review');
    }
    expect(Object.values(ar.quality.tabs)).not.toContain('السجلات');
  });

  it('the register’s link to the queue is named as the queue is', () => {
    const page = read(`${PROTECTED}/citizens/page.tsx`);
    expect(page).toMatch(/`Incomplete files \(\$\{totals\.requiringReview\}\)`/);
    expect(page).toMatch(/`ملفات ناقصة \(\$\{totals\.requiringReview\}\)`/);
  });
});

describe('the tabbed pages', () => {
  it('«الجودة» is one client page: the reviewers’ gate, then the four tabs', () => {
    const page = read(`${PROTECTED}/quality/page.tsx`);
    expect(page).toMatch(/^'use client'/);
    expect(page).toMatch(/<QualityScreen /);
    expect(page).toMatch(/<QualityTabs /);
  });

  it('clears what the panels share when the tab changes, taken from their own schemas', () => {
    const source = read('components/admin/quality/quality-tabs.tsx');
    expect(source).toMatch(/setUrl\(\{ tab: id as QualityTab \}, \{ clear: QUALITY_PANEL_KEYS \}\)/);
    expect(QUALITY_PANEL_KEYS).toEqual(
      expect.arrayContaining(['page', 'limit', 'queue', 'officer', 'flagged', 'kind', 'dismissed', 'finding', 'status']),
    );
    expect(QUALITY_PANEL_KEYS).not.toContain('tab');
  });

  it('«قوائم العمل الميداني» keeps each tab’s own state: the second tab’s keys are its own', () => {
    const second = read('components/admin/worklists/reinspections-worklist.tsx');
    expect(second).toMatch(/pageKey: REINSPECTIONS_PAGE_KEY/);
    expect(second).toMatch(/sizeKey: REINSPECTIONS_SIZE_KEY/);
    expect(second).toMatch(/\[REINSPECTIONS_OWNER_KEY\]/);
    const first = read('components/admin/worklists/unsurveyed-worklist.tsx');
    expect(first).not.toMatch(/pageKey|sizeKey/);
    expect(new Set([REINSPECTIONS_PAGE_KEY, REINSPECTIONS_SIZE_KEY, REINSPECTIONS_OWNER_KEY, 'page', 'limit', 'owner', 'tab']).size).toBe(7);
  });

  it('draws its header once, in the page, and the tabs’ bodies draw none of their own', () => {
    for (const path of ['components/admin/worklists/unsurveyed-worklist.tsx', 'components/admin/worklists/reinspections-worklist.tsx']) {
      expect(read(path)).not.toMatch(/<PageHeader/);
    }
    expect(read(`${PROTECTED}/buildings/worklists/page.tsx`)).toMatch(/<PageHeader /);
  });

  it('is the Tabs primitive in both, with the direction from the locale', () => {
    const source = read('components/admin/page-tabs.tsx');
    expect(source).toMatch(/<TabsList variant="line"/);
    expect(source).toMatch(/dir=\{locale === 'en' \? 'ltr' : 'rtl'\}/);
  });

  it('says every tab in both languages', () => {
    for (const messages of [en, ar]) {
      for (const key of ['reviews', 'findings', 'checks', 'officers'] as const) expect(messages.quality.tabs[key]).toBeTruthy();
      for (const key of ['unsurveyed', 'reinspections'] as const) expect(messages.fieldWorklists.tabs[key]).toBeTruthy();
    }
  });
});
