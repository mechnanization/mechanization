import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localizedGroupLabel, localizedLabel, navLabel, NAV_GROUPS, OFF_SIDEBAR_PAGES } from '@/components/admin/nav';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  NAV-10 (cleanup sprint, 2026-11-25): every nav label and its page's title read one message key.

  A row used to carry its own Arabic and English text (`label`, `labelEn`) while its page wrote the title again
  in its own copy, and eight of them said something else («الأرصدة» in the sidebar, «أرصدة الخزينة» on the
  page). Now a row is `key`, the words are `messages.nav.items`, and the page reads the same message through
  `navLabel`. This reads the sources (the runner collects `lib/**` only).
*/
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const PROTECTED = 'app/[tenant]/[locale]/[adminPath]/(protected)';
const rows = NAV_GROUPS.flatMap((group) => group.items);
const pages = [...rows, ...OFF_SIDEBAR_PAGES];

describe('a row is a key, and its words are messages', () => {
  it('no row, group or off-sidebar page carries its own text', () => {
    for (const item of pages) {
      expect(item, item.path).not.toHaveProperty('label');
      expect(item, item.path).not.toHaveProperty('labelEn');
    }
    for (const group of NAV_GROUPS) {
      expect(group).not.toHaveProperty('label');
      expect(group).not.toHaveProperty('labelEn');
    }
  });

  it('nav.ts says `labelEn` nowhere (the audit’s verification)', () => {
    expect(read('components/admin/nav.ts')).not.toMatch(/labelEn/);
  });

  it('every key has its words in both languages, and no message is left without a row', () => {
    const itemKeys = pages.map((item) => item.key).sort();
    expect(new Set(itemKeys).size).toBe(itemKeys.length);
    expect(Object.keys(ar.nav.items).sort()).toEqual(itemKeys);
    expect(Object.keys(en.nav.items).sort()).toEqual(itemKeys);
    const groupKeys = NAV_GROUPS.flatMap((group) => (group.key ? [group.key] : [])).sort();
    expect(Object.keys(ar.nav.groups).sort()).toEqual(groupKeys);
    expect(Object.keys(en.nav.groups).sort()).toEqual(groupKeys);
    for (const key of itemKeys) {
      expect((ar.nav.items as Record<string, string>)[key]).toBeTruthy();
      expect((en.nav.items as Record<string, string>)[key]).toBeTruthy();
    }
  });

  it('the old, unread `nav` keys are gone: it is `items` and `groups` and nothing else', () => {
    expect(Object.keys(ar.nav).sort()).toEqual(['groups', 'items']);
    expect(Object.keys(en.nav).sort()).toEqual(['groups', 'items']);
  });

  it('the sidebar, crumb and palette read a row through localizedLabel, which is the message', () => {
    for (const item of pages) {
      expect(localizedLabel(item, 'ar')).toBe((ar.nav.items as Record<string, string>)[item.key]);
      expect(localizedLabel(item, 'en')).toBe((en.nav.items as Record<string, string>)[item.key]);
      expect(navLabel(item.key, 'en')).toBe(localizedLabel(item, 'en'));
    }
    for (const group of NAV_GROUPS.filter((candidate) => candidate.key)) {
      expect(localizedGroupLabel(group, 'ar')).toBe((ar.nav.groups as Record<string, string>)[group.key!]);
      expect(localizedGroupLabel(group, 'en')).toBe((en.nav.groups as Record<string, string>)[group.key!]);
    }
  });

  it('the palette matches either language’s name, not only the Arabic one', () => {
    const source = read('components/admin/command-palette.tsx');
    expect(source).toMatch(/localizedLabel\(item, 'ar'\)\.includes\(term\)/);
    expect(source).toMatch(/localizedLabel\(item, 'en'\)\.toLowerCase\(\)\.includes\(term\.toLowerCase\(\)\)/);
  });
});

describe('a page names itself with its row’s key', () => {
  /*
    Pages whose heading is not a `PageHeader` in `page.tsx`, and why. A new row is not on this list, so its
    page has to read its key or the test says so.
  */
  const ELSEWHERE: Record<string, string> = {
    '/inspector/profile': 'its header is in components/admin/inspector-earnings-roster.tsx and inspector-profile-detail.tsx',
    '/map': 'the full-screen map has no page header',
    '/citizens/new': 'the form’s own header, in CitizenEditor, says the page is new, and the crumb says «جديد»',
  };

  const direct = pages.filter((item) => !(item.path in ELSEWHERE));

  it.each(direct.map((item) => [item.path, item.key] as const))('%s draws its title from navLabel(\'%s\')', (path, key) => {
    const file = `${PROTECTED}${path}/page.tsx`;
    expect(existsSync(join(FRONTEND, file)), file).toBe(true);
    expect(read(file)).toMatch(new RegExp(`navLabel\\('${key}', (?:locale|isAr \\? 'ar' : 'en')\\)`));
  });

  it('the two earnings screens read the row’s key too', () => {
    for (const file of ['components/admin/inspector-earnings-roster.tsx', 'components/admin/inspector-profile-detail.tsx']) {
      expect(read(file)).toMatch(/navLabel\('earnings', isAr \? 'ar' : 'en'\)/);
    }
  });

  it('keeps its exceptions to the pages above, each with its reason', () => {
    expect(Object.keys(ELSEWHERE).sort()).toEqual(['/citizens/new', '/inspector/profile', '/map']);
    for (const path of Object.keys(ELSEWHERE)) expect(pages.map((item) => item.path)).toContain(path);
  });

  it('writes the title nowhere else on the page: no inline pair beside it', () => {
    for (const [path, pair] of [
      ['/fees', "'إدارة الرسوم والمدفوعات'"],
      ['/audit', "'Audit trail'"],
      ['/staff', "'Staff'"],
      ['/account', "'Account Security'"],
    ] as const) {
      expect(read(`${PROTECTED}${path}/page.tsx`)).not.toContain(pair);
    }
  });
});

// The treasury is named in full, «أرصدة الخزينة» / "Treasury balances" (the owner's choice, 2026-11-25), not the short «الأرصدة».
describe('the titles that said something else now say the row’s words (one place to change them)', () => {
  const item = (key: string, locale: 'ar' | 'en') => ((locale === 'ar' ? ar : en).nav.items as Record<string, string>)[key];

  it.each([
    ['fees', 'الرسوم والمدفوعات', 'Fees & billing'],
    ['payments', 'سجل العمليات', 'Payment operations'],
    ['treasury', 'أرصدة الخزينة', 'Treasury balances'],
    ['buildings', 'سجل المباني', 'Building census'],
    ['audit', 'سجل النشاطات', 'Audit log'],
    ['news', 'الأخبار', 'News'],
    ['staff', 'الموظفون', 'Staff management'],
    ['account', 'أمان الحساب', 'Account security'],
    ['earnings', 'أرباح المسح الميداني', 'Field survey earnings'],
  ])('%s is «%s» / "%s", in the sidebar and on its page', (key, arabic, english) => {
    expect(item(key, 'ar')).toBe(arabic);
    expect(item(key, 'en')).toBe(english);
  });
});
