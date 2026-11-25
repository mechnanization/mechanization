import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FEE_READ_ROLES, PAYMENT_REVIEW_READ_ROLES, STAFF_ROLE } from '@mechanization/shared-schemas';
import {
  canAccessPath,
  localizedLabel,
  NAV_GROUPS,
  OFF_SIDEBAR_PAGES,
  paletteOnlyItems,
  pageNavItem,
  visibleGroups,
} from '@/components/admin/nav';
import { CITIZEN_RECORD_EDIT_ROLES } from '@/lib/staff-roles';
import ar from '../messages/ar.json';
import en from '../messages/en.json';

/*
  NAV-02, NAV-06 and NAV-07 (cleanup sprint, 2026-11-25, decided in docs/open-decisions.md §25):
  «تسجيل مواطن جديد», «أمان الحساب» and «فواتير تأثّرت بتصحيحات» leave the sidebar. Their
  pages stay, so what a row did (name the page in the header, offer it in the palette, and gate
  it) moves to `OFF_SIDEBAR_PAGES` and to the pages themselves. A path with no row opens to every
  role (`canAccessPath`), which is why two of the pages first turn their other roles away.
*/
const BASE = '/albazourieh/ar/admin';
const FRONTEND = join(__dirname, '..');
const read = (path: string): string => readFileSync(join(FRONTEND, path), 'utf8');
const rows = NAV_GROUPS.flatMap((group) => group.items);
const GONE = ['/citizens/new', '/fees/corrections', '/account'];
const has = (roles: readonly string[], role: string) => roles.includes(role);

describe('the three rows have left the sidebar', () => {
  it('lists none of them, for any role', () => {
    for (const path of GONE) expect(rows.map((row) => row.path)).not.toContain(path);
    for (const role of STAFF_ROLE) {
      const shown = visibleGroups(role).flatMap((group) => group.items.map((item) => item.path));
      for (const path of GONE) expect(shown).not.toContain(path);
    }
  });

  it('claims none of them as an older address of another row', () => {
    const owned = rows.flatMap((row) => row.also ?? []);
    for (const path of GONE) expect(owned).not.toContain(path);
  });
});

describe('OFF_SIDEBAR_PAGES', () => {
  // The three of NAV-02, NAV-06 and NAV-07, and the News lists of NAV-05 (named for the crumb only).
  it('names exactly those pages, in both languages, with an icon each', () => {
    expect(OFF_SIDEBAR_PAGES.map((page) => page.path)).toEqual([...GONE.slice(0, 2), '/news/categories', '/news/publishers', GONE[2]]);
    for (const page of OFF_SIDEBAR_PAGES) {
      expect(localizedLabel(page, 'ar')).toBeTruthy();
      expect(localizedLabel(page, 'en')).toBeTruthy();
      expect(page.keywords?.length).toBeGreaterThan(0);
    }
    expect(new Set(OFF_SIDEBAR_PAGES.map((page) => page.icon)).size).toBe(OFF_SIDEBAR_PAGES.length);
  });

  it('shares no icon with a sidebar row, so a folded rail never shows two the same', () => {
    const icons = new Set(rows.map((row) => row.icon));
    for (const page of OFF_SIDEBAR_PAGES) expect(icons.has(page.icon)).toBe(false);
  });

  it('takes its roles from the sets the server uses, not a copy', () => {
    const roles = (path: string) => OFF_SIDEBAR_PAGES.find((page) => page.path === path)?.roles;
    expect(roles('/citizens/new')).toBe(CITIZEN_RECORD_EDIT_ROLES);
    expect(roles('/fees/corrections')).toBe(PAYMENT_REVIEW_READ_ROLES);
    expect(roles('/account')).toEqual([...STAFF_ROLE]);
  });
});

describe('the guard, which the pages must make up for', () => {
  it('opens «حسابي» to every role, as its row did', () => {
    for (const role of STAFF_ROLE) expect(canAccessPath(`${BASE}/account`, BASE, role)).toBe(true);
  });

  /*
    The trap NAV-02 and NAV-07 name: with no row, the page falls under `/citizens` or `/fees`, whose
    roles are wider than the page's. Pinned so that nobody mistakes the guard for the gate.
  */
  it('lets a role the page is not for through to it, so the page has to turn it away', () => {
    const outsideRegister = STAFF_ROLE.filter((role) => !has(CITIZEN_RECORD_EDIT_ROLES, role));
    expect(outsideRegister.length).toBeGreaterThan(0);
    for (const role of outsideRegister) expect(canAccessPath(`${BASE}/citizens/new`, BASE, role)).toBe(true);

    const readsLedgerNotCorrections = STAFF_ROLE.filter(
      (role) => has(FEE_READ_ROLES, role) && !has(PAYMENT_REVIEW_READ_ROLES, role),
    );
    expect(readsLedgerNotCorrections.length).toBeGreaterThan(0);
    for (const role of readsLedgerNotCorrections) {
      expect(canAccessPath(`${BASE}/fees/corrections`, BASE, role)).toBe(true);
    }
  });
});

describe('pageNavItem, the header’s crumb', () => {
  const crumb = (path: string, role: string) => pageNavItem(`${BASE}${path}`, BASE, role)?.path;

  it('names «أمان الحساب» for every role, where there is no row to name', () => {
    for (const role of STAFF_ROLE) expect(crumb('/account', role)).toBe('/account');
  });

  it('names «تسجيل مواطن جديد» for the roles it is for, and the register for the others', () => {
    for (const role of STAFF_ROLE) {
      expect(crumb('/citizens/new', role)).toBe(has(CITIZEN_RECORD_EDIT_ROLES, role) ? '/citizens/new' : '/citizens');
    }
  });

  it('names «فواتير تأثّرت بتصحيحات» for its readers, and the fees page for the others', () => {
    for (const role of STAFF_ROLE.filter((candidate) => has(FEE_READ_ROLES, candidate))) {
      expect(crumb('/fees/corrections', role)).toBe(has(PAYMENT_REVIEW_READ_ROLES, role) ? '/fees/corrections' : '/fees');
    }
  });

  it('leaves every other page to its row', () => {
    expect(crumb('/citizens/abc', 'SUPER_ADMIN')).toBe('/citizens');
    expect(crumb('/citizens/review', 'SUPER_ADMIN')).toBe('/citizens/review');
    expect(crumb('/fees/notices', 'SUPER_ADMIN')).toBe('/fees');
    expect(crumb('/accounting', 'SUPER_ADMIN')).toBeUndefined();
    expect(pageNavItem(null, BASE, 'SUPER_ADMIN')).toBeUndefined();
    expect(pageNavItem(`${BASE}/account`, BASE, undefined)).toBeUndefined();
  });
});

describe('the command palette', () => {
  it('still offers «تسجيل مواطن جديد» to the roles that may register', () => {
    for (const role of STAFF_ROLE) {
      expect(paletteOnlyItems(role).map((item) => item.path)).toEqual(
        has(CITIZEN_RECORD_EDIT_ROLES, role) ? ['/citizens/new'] : [],
      );
    }
    expect(paletteOnlyItems(undefined)).toEqual([]);
  });

  it('is read from the palette, and the header from pageNavItem', () => {
    expect(read('components/admin/command-palette.tsx')).toMatch(/\.\.\.paletteOnlyItems\(role\)/);
    expect(read('components/admin/admin-header.tsx')).toMatch(/pageNavItem\(pathname, base, role\)/);
  });
});

describe('the pages turn their other roles away themselves', () => {
  const newPage = read('app/[tenant]/[locale]/[adminPath]/(protected)/citizens/new/page.tsx');
  const correctionsPage = read('app/[tenant]/[locale]/[adminPath]/(protected)/fees/corrections/page.tsx');
  const gate = read('components/admin/use-role-gate.ts');

  it('«تسجيل مواطن جديد» draws no form for a role outside CITIZEN_RECORD_EDIT_ROLES', () => {
    expect(newPage).toMatch(/useRoleGate\(tenant, base, CITIZEN_RECORD_EDIT_ROLES, \{/);
    expect(newPage).toMatch(/to: `\$\{base\}\/citizens`/);
    expect(newPage).toMatch(/if \(gate\.allowed !== true\) return null;/);
  });

  it('«فواتير تأثّرت بتصحيحات» reads nothing for a role outside PAYMENT_REVIEW_READ_ROLES', () => {
    expect(correctionsPage).toMatch(/useRoleGate\(tenant, base, PAYMENT_REVIEW_READ_ROLES, \{/);
    expect(correctionsPage).toMatch(/to: `\$\{base\}\/fees`/);
    // The read takes the gate's token, which is null for a role turned away.
    expect(correctionsPage).toMatch(/const \{ token, role: gateRole \} = useRoleGate/);
    expect(correctionsPage).not.toMatch(/useStaffSession/);
  });

  it('the gate gives no token to a role it turns away, and says why once', () => {
    expect(gate).toMatch(/token: allowed \? staff\.token : null/);
    expect(gate).toMatch(/sent\.current/);
    expect(gate).toMatch(/toast\.info\(t\('title'\), \{ description: t\(reason\) \}\)/);
    expect(gate).toMatch(/router\.replace\(to\)/);
  });

  it('says why in both languages', () => {
    for (const messages of [en, ar]) {
      expect(messages.access.title).toBeTruthy();
      expect(messages.access.registerCitizen).toBeTruthy();
      expect(messages.access.feeCorrections).toBeTruthy();
    }
  });
});

describe('the other doors stay open', () => {
  it('opens «تسجيل مواطن جديد» from the register’s header, the unsurveyed worklist and a unit in the matrix', () => {
    expect(read('app/[tenant]/[locale]/[adminPath]/(protected)/citizens/page.tsx')).toMatch(/\/citizens\/new/);
    expect(read('components/admin/worklists/unsurveyed-worklist.tsx')).toMatch(/\/citizens\/new/);
    expect(read('components/admin/building-unit-matrix-view.tsx')).toMatch(/\/citizens\/new/);
  });

  it('opens «فواتير تأثّرت بتصحيحات» from the fees page, to the roles that may read it', () => {
    const fees = read('app/[tenant]/[locale]/[adminPath]/(protected)/fees/page.tsx');
    expect(fees).toMatch(/const canReadCorrections = hasRole\(PAYMENT_REVIEW_READ_ROLES, role\)/);
    expect(fees).toMatch(/\{canReadCorrections \? \(\s*<Link href=\{`\$\{base\}\/fees\/corrections`\}/);
  });

  it('opens «أمان الحساب» from the user menu', () => {
    expect(read('components/admin/admin-header.tsx')).toMatch(/router\.push\(`\$\{base\}\/account`\)/);
  });
});
