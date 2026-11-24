import { describe, expect, it } from 'vitest';
import { STAFF_ROLE } from '@mechanization/shared-schemas';
import {
  activeNavItem,
  canAccessPath,
  defaultPathFor,
  localizedGroupLabel,
  NAV_GROUPS,
  visibleGroups,
} from '@/components/admin/nav';

/*
  The sidebar's rules, without rendering it.

  Here rather than beside `components/admin/nav.ts` because the runner only
  collects `lib/**` (vitest.config.mts), as `residence-move.test.ts` does for
  the citizen form's types. `nav.ts` is plain data and pure functions; nothing
  here needs a DOM.
*/

const BASE = '/albazourieh/ar/admin';
const rows = NAV_GROUPS.flatMap((group) => group.items);

describe('the sidebar’s shape', () => {
  it('lists every path once', () => {
    const paths = rows.map((row) => row.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  // An older address two rows claimed would light whichever was declared first.
  it('lets no older address belong to two rows, or shadow a row of its own', () => {
    const owned = rows.flatMap((row) => [row.path, ...(row.also ?? [])]);
    expect(new Set(owned).size).toBe(owned.length);
  });

  // Past five, a heading stops helping the eye find a row (NAV_GROUPS header).
  it('holds no group of more than five rows', () => {
    for (const group of NAV_GROUPS) expect(group.items.length).toBeLessThanOrEqual(5);
  });

  // A folded rail shows icons only; two rows with one icon cannot be told apart there.
  it('gives every row an icon of its own', () => {
    const icons = rows.map((row) => row.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it('names every row and every labelled group in both languages', () => {
    for (const row of rows) expect(row.labelEn).toBeTruthy();
    for (const group of NAV_GROUPS.slice(1)) {
      expect(group.label).toBeTruthy();
      expect(group.labelEn).toBeTruthy();
    }
  });

  it('keeps the landing group unlabelled and first', () => {
    expect(NAV_GROUPS[0].label).toBeUndefined();
    expect(localizedGroupLabel(NAV_GROUPS[0])).toBe('');
  });
});

describe('where each role lands', () => {
  /*
    Pinned on the 2026-10-09 reorganisation: moving groups must not move anyone's
    front door. The three roles that may not open the dashboard land on their
    own page, as they did before.
  */
  it.each([
    ['SUPER_ADMIN', '/dashboard'],
    ['AUDITOR', '/dashboard'],
    ['VIEWER', '/dashboard'],
    ['FIELD_INSPECTOR', '/inspector/profile'],
    ['COLLECTOR', '/inspector/profile'],
    ['ACCOUNTANT', '/inspector/profile'],
    ['ADMINISTRATIVE_OFFICER', '/inspector/profile'],
  ])('%s lands on %s', (role, path) => {
    expect(defaultPathFor(role)).toBe(path);
  });

  it('every role can open the page it lands on', () => {
    for (const role of STAFF_ROLE) {
      expect(canAccessPath(`${BASE}${defaultPathFor(role)}`, BASE, role)).toBe(true);
    }
  });
});

describe('visibleGroups', () => {
  it('shows nothing while the role is unknown', () => {
    expect(visibleGroups(undefined)).toEqual([]);
  });

  it('never shows an empty group', () => {
    for (const role of STAFF_ROLE) {
      for (const group of visibleGroups(role)) expect(group.items.length).toBeGreaterThan(0);
    }
  });

  /*
    The reason money is two groups: the collector works billing and never the
    books, so he sees a «الرسوم والجباية» heading and no «الخزينة» at all,
    rather than a «المالية» of which he could open three rows out of seven.
  */
  it('shows the collector the fees and none of the treasury', () => {
    const labels = visibleGroups('COLLECTOR').map((group) => group.label);
    expect(labels).toContain('الرسوم والجباية');
    expect(labels).not.toContain('الخزينة');
  });

  it('shows the accountant the treasury and no map', () => {
    const paths = visibleGroups('ACCOUNTANT').flatMap((group) => group.items.map((item) => item.path));
    expect(paths).toEqual(expect.arrayContaining(['/finance', '/finance/movements', '/finance/transactions']));
    // One register for money in and out (2026-10-12): the two old rows are gone from the sidebar.
    expect(paths).not.toContain('/finance/income');
    expect(paths).not.toContain('/finance/expenses');
    expect(paths).not.toContain('/map');
  });

  // Recording is the accountant's and the manager's; the auditor reads the register.
  it('shows the auditor the register and not the recording page', () => {
    const paths = visibleGroups('AUDITOR').flatMap((group) => group.items.map((item) => item.path));
    expect(paths).toContain('/finance/transactions');
    expect(paths).not.toContain('/finance/movements');
  });
});

describe('canAccessPath', () => {
  it('lets every role open the admin base, so the index page can redirect', () => {
    expect(canAccessPath(BASE, BASE, 'COLLECTOR')).toBe(true);
    expect(canAccessPath(`${BASE}/`, BASE, 'VIEWER')).toBe(true);
  });

  // A URL under no row is a 404, not a permission question; refusing it would hide the typo.
  it('lets an unknown path through to the not-found page', () => {
    expect(canAccessPath(`${BASE}/no-such-page`, BASE, 'COLLECTOR')).toBe(true);
  });

  /*
    Only sections with no visible row above them. A row the role cannot see
    under one it can — `/citizens/new` under `/citizens` for «مشاهد فقط» — is
    reachable by address, because the longest *visible* row matches; that page
    turns the role away itself (`CitizenEditor`), and the server refuses the
    save. Not pinned here either way.
  */
  it('refuses a section the role cannot see', () => {
    expect(canAccessPath(`${BASE}/finance`, BASE, 'COLLECTOR')).toBe(false);
    expect(canAccessPath(`${BASE}/staff`, BASE, 'VIEWER')).toBe(false);
    expect(canAccessPath(`${BASE}/settings`, BASE, 'ACCOUNTANT')).toBe(false);
  });

  // NAV-09: the user menu's «أرباح المسح الميداني» item is drawn under this very question.
  it('admits «أرباح المسح الميداني» to every working role and not to «مشاهد فقط»', () => {
    const earnings = `${BASE}/inspector/profile`;
    expect(canAccessPath(earnings, BASE, 'VIEWER')).toBe(false);
    expect(canAccessPath(earnings, BASE, undefined)).toBe(false);
    for (const role of ['SUPER_ADMIN', 'COLLECTOR', 'ACCOUNTANT', 'AUDITOR']) {
      expect(canAccessPath(earnings, BASE, role)).toBe(true);
    }
  });

  it('opens a page under a row by that row’s roles', () => {
    expect(canAccessPath(`${BASE}/finance/income/categories`, BASE, 'AUDITOR')).toBe(true);
    expect(canAccessPath(`${BASE}/finance/income/categories`, BASE, 'COLLECTOR')).toBe(false);
  });

  // The printed vouchers kept their addresses when the registers merged; the register's row guards them.
  it('guards a page under an older address by the row that owns it', () => {
    expect(canAccessPath(`${BASE}/finance/expenses/abc/print`, BASE, 'VIEWER')).toBe(true);
    expect(canAccessPath(`${BASE}/finance/expenses/abc/print`, BASE, 'COLLECTOR')).toBe(false);
    expect(canAccessPath(`${BASE}/finance/transactions`, BASE, 'FIELD_INSPECTOR')).toBe(false);
    expect(canAccessPath(`${BASE}/finance/movements`, BASE, 'FIELD_INSPECTOR')).toBe(false);
  });

  // The papers on a request are identity copies: «مشاهد فقط» and the collector do not reach the queue.
  it('opens the municipal requests to their readers only', () => {
    expect(canAccessPath(`${BASE}/requests`, BASE, 'ADMINISTRATIVE_OFFICER')).toBe(true);
    expect(canAccessPath(`${BASE}/requests/abc/print`, BASE, 'AUDITOR')).toBe(true);
    expect(canAccessPath(`${BASE}/requests`, BASE, 'VIEWER')).toBe(false);
    expect(canAccessPath(`${BASE}/requests/new`, BASE, 'COLLECTOR')).toBe(false);
    expect(activeNavItem(`${BASE}/requests/abc/print`, BASE, 'SUPER_ADMIN')?.path).toBe('/requests');
  });

  it('refuses a known section while the role is still unknown', () => {
    expect(canAccessPath(`${BASE}/citizens`, BASE, undefined)).toBe(false);
  });
});

describe('activeNavItem', () => {
  // The longest match wins, so a detail page lights its own row and not a prefix of it.
  it('attributes a page to the most specific row', () => {
    expect(activeNavItem(`${BASE}/finance`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance');
    expect(activeNavItem(`${BASE}/finance/movements`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance/movements');
    expect(activeNavItem(`${BASE}/finance/transactions`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance/transactions');
    expect(activeNavItem(`${BASE}/finance/collectors/abc`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance/collectors');
    expect(activeNavItem(`${BASE}/citizens/review`, BASE, 'SUPER_ADMIN')?.path).toBe('/citizens/review');
  });

  // An older address counts as the row's own, and beats the shorter `/finance`.
  it('attributes a page under an older address to the row that owns it', () => {
    expect(activeNavItem(`${BASE}/finance/income/abc/print`, BASE, 'ACCOUNTANT')?.path).toBe('/finance/transactions');
    expect(activeNavItem(`${BASE}/finance/expenses/new`, BASE, 'ACCOUNTANT')?.path).toBe('/finance/transactions');
    expect(activeNavItem(`${BASE}/finance/income/categories`, BASE, 'AUDITOR')?.path).toBe('/finance/transactions');
  });

  it('does not match a path that only shares a prefix of letters', () => {
    expect(activeNavItem(`${BASE}/financed`, BASE, 'SUPER_ADMIN')).toBeUndefined();
    expect(activeNavItem(`${BASE}/finance/incomes`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance');
  });
});

describe('News and the village that may not have it', () => {
  const newsPaths = (groups: ReturnType<typeof visibleGroups>) =>
    groups.flatMap((group) => group.items).filter((item) => item.path.startsWith('/news')).map((item) => item.path);

  it('shows the three News rows to the administrator and the administrative officer', () => {
    for (const role of ['SUPER_ADMIN', 'ADMINISTRATIVE_OFFICER']) {
      expect(newsPaths(visibleGroups(role))).toEqual(['/news/articles', '/news/categories', '/news/publishers']);
    }
  });

  it('never shows them to any other role', () => {
    for (const role of ['AUDITOR', 'FIELD_INSPECTOR', 'COLLECTOR', 'ACCOUNTANT', 'VIEWER']) {
      expect(newsPaths(visibleGroups(role))).toEqual([]);
    }
  });

  it('hides them, and the group with them, only when Day3ati says News is off', () => {
    const off = visibleGroups('SUPER_ADMIN', { newsEnabled: false });
    expect(newsPaths(off)).toEqual([]);
    expect(off.map((group) => group.label)).not.toContain('الأخبار');
  });

  it('keeps them while it is on, or not yet known, so a slow Day3ati does not take the menu away', () => {
    expect(newsPaths(visibleGroups('SUPER_ADMIN', { newsEnabled: true }))).toHaveLength(3);
    expect(newsPaths(visibleGroups('SUPER_ADMIN', { newsEnabled: undefined }))).toHaveLength(3);
  });

  it('leaves every other row alone when News is off', () => {
    const all = visibleGroups('SUPER_ADMIN').flatMap((group) => group.items).length;
    const without = visibleGroups('SUPER_ADMIN', { newsEnabled: false }).flatMap((group) => group.items).length;
    expect(all - without).toBe(3);
  });
});
