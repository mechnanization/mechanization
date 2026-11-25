// @vitest-environment jsdom
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarNav } from '@/components/admin/admin-sidebar';
import { visibleGroups } from '@/components/admin/nav';
import { settingsCopy } from '@/lib/settings-i18n';
import * as settingsI18n from '@/lib/settings-i18n';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  NAV-05 and PAGE-01 (cleanup sprint, 2026-11-25, decided in open-decisions §25).

  NAV-05: «الأخبار» is one row under its own name, with no group heading above it, and the two lists its
  articles are filed and published by open from the articles page's header. PAGE-01: settings loses its
  «المستخدمون» tab, which repeated `/staff`, and the section and the role catalogue only it read are deleted.
  The sidebar is rendered for real; the pages are read as source (the runner collects `lib/**` only).
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('next/navigation', () => ({
  usePathname: () => '/t/ar/a/dashboard',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch() {} }),
}));

const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const NEWS = 'app/[tenant]/[locale]/[adminPath]/(protected)/news';

let container: HTMLDivElement;
let root: Root;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.localStorage.clear();
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  errors.mockRestore();
});

async function sidebar(options: { role: string; collapsed?: boolean; newsEnabled?: boolean; locale?: string }): Promise<void> {
  await act(async () => {
    root.render(createElement(SidebarNav, { base: '/t/ar/a', role: options.role, collapsed: options.collapsed, newsEnabled: options.newsEnabled, locale: options.locale ?? 'ar' }));
  });
}
const summaries = () => [...container.querySelectorAll('summary')].map((node) => node.textContent?.trim());
const links = () => [...container.querySelectorAll('a')].map((node) => node.getAttribute('href'));

describe('«الأخبار» in the sidebar (NAV-05)', () => {
  it('is one row with no heading over it: a link, and no group named «الأخبار»', async () => {
    await sidebar({ role: 'SUPER_ADMIN' });
    expect(links()).toContain('/t/ar/a/news/articles');
    expect(links()).not.toContain('/t/ar/a/news/categories');
    expect(links()).not.toContain('/t/ar/a/news/publishers');
    expect(summaries()).not.toContain('الأخبار');
    // One fold per group that has a heading, and none for the landing group or for News.
    const headed = visibleGroups('SUPER_ADMIN').filter((group) => group.key !== undefined).length;
    expect(container.querySelectorAll('details')).toHaveLength(headed);
    expect(container.querySelector('details a[href$="/news/articles"]')).toBeNull();
  });

  it('draws two headingless groups without a React key clash, open and folded to the rail', async () => {
    await sidebar({ role: 'SUPER_ADMIN' });
    await sidebar({ role: 'SUPER_ADMIN', collapsed: true });
    expect(links()).toContain('/t/ar/a/news/articles');
    const clashes = errors.mock.calls.filter((call: unknown[]) => String(call[0]).includes('same key') || String(call[0]).includes('unique "key"'));
    expect(clashes).toEqual([]);
  });

  it('names the row in English as «News»', async () => {
    await sidebar({ role: 'SUPER_ADMIN', locale: 'en' });
    const row = [...container.querySelectorAll('a')].find((node) => node.getAttribute('href') === '/t/ar/a/news/articles');
    expect(row?.textContent?.trim()).toBe('News');
  });

  it('leaves it out for a role that does not edit the news, and when News is off', async () => {
    await sidebar({ role: 'ACCOUNTANT' });
    expect(links().some((href) => href?.includes('/news'))).toBe(false);
    await sidebar({ role: 'SUPER_ADMIN', newsEnabled: false });
    expect(links().some((href) => href?.includes('/news'))).toBe(false);
  });

  it('keeps the landing rows on top, with the rule that sets them off', async () => {
    await sidebar({ role: 'SUPER_ADMIN' });
    expect(links()[0]).toBe('/t/ar/a/dashboard');
  });
});

describe('the lists open from the articles page, and lead back to it (NAV-05)', () => {
  it('the articles page’s header links to both lists beside «مقال جديد»', () => {
    const page = read(`${NEWS}/articles/page.tsx`);
    expect(page).toMatch(/href=\{`\$\{base\}\/news\/categories`\}/);
    expect(page).toMatch(/href=\{`\$\{base\}\/news\/publishers`\}/);
    expect(page).toMatch(/t\('categoriesLink'\)/);
    expect(page).toMatch(/t\('publishersLink'\)/);
  });

  it.each(['categories', 'publishers'])('%s keeps a way back to the articles in the header', (name) => {
    expect(read(`${NEWS}/${name}/page.tsx`)).toMatch(/<HeaderBackLink fallbackHref=\{`\$\{base\}\/news\/articles`\} label=\{t\('back'\)\} \/>/);
  });

  it('says each link and each way back in both languages', () => {
    for (const messages of [en, ar]) {
      expect(messages.news.articles.categoriesLink).toBeTruthy();
      expect(messages.news.articles.publishersLink).toBeTruthy();
      expect(messages.news.categories.back).toBeTruthy();
      expect(messages.news.publishers.back).toBeTruthy();
    }
  });
});

describe('settings has no «المستخدمون» tab (PAGE-01)', () => {
  function sourcesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) sourcesUnder(path, out);
      else if (/\.(ts|tsx)$/.test(path) && !/\.test\.ts$/.test(path)) out.push(path);
    }
    return out;
  }

  it('the section is deleted, and nothing imports it', () => {
    expect(existsSync(join(FRONTEND, 'components/admin/settings/users-section.tsx'))).toBe(false);
    const users = ['app', 'components', 'lib']
      .flatMap((dir) => sourcesUnder(join(FRONTEND, dir)))
      .filter((file) => /UsersSection|users-section/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(FRONTEND, file));
    expect(users).toEqual([]);
  });

  it('the page lists four sections, none of them users', () => {
    const page = read('app/[tenant]/[locale]/[adminPath]/(protected)/settings/page.tsx');
    expect(page).toMatch(/const SECTION_IDS = \['profile', 'finance', 'numbering', 'cadastre'\] as const;/);
    expect(page).not.toMatch(/'users'/);
  });

  it('an old ?tab=users opens the first section rather than nothing', () => {
    const page = read('app/[tenant]/[locale]/[adminPath]/(protected)/settings/page.tsx');
    expect(page).toMatch(/param\.oneOf\(SECTION_IDS, 'profile'\)/);
  });

  it('the role catalogue only that section read is gone with it, and «النظام» still reaches /staff', () => {
    for (const locale of ['ar', 'en']) {
      const copy = settingsCopy(locale) as unknown as Record<string, unknown>;
      expect(copy.users).toBeUndefined();
      expect((copy.nav as Record<string, unknown>).users).toBeUndefined();
    }
    for (const name of ['ROLE_KEYS', 'ROLE_BACKEND_VALUE', 'roleKeyFor']) {
      expect(name in settingsI18n).toBe(false);
    }
    const staffRow = visibleGroups('SUPER_ADMIN').flatMap((group) => group.items).find((item) => item.path === '/staff');
    expect(staffRow?.roles).toEqual(['SUPER_ADMIN']);
  });
});
