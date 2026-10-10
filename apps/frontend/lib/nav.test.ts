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
    expect(paths).toEqual(expect.arrayContaining(['/finance', '/finance/income', '/finance/expenses']));
    expect(paths).not.toContain('/map');
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

  it('opens a page under a row by that row’s roles', () => {
    expect(canAccessPath(`${BASE}/finance/income/categories`, BASE, 'AUDITOR')).toBe(true);
    expect(canAccessPath(`${BASE}/finance/income/categories`, BASE, 'COLLECTOR')).toBe(false);
  });

  it('refuses a known section while the role is still unknown', () => {
    expect(canAccessPath(`${BASE}/citizens`, BASE, undefined)).toBe(false);
  });
});

describe('activeNavItem', () => {
  // The longest match wins, so a detail page lights its own row and not a prefix of it.
  it('attributes a page to the most specific row', () => {
    expect(activeNavItem(`${BASE}/finance`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance');
    expect(activeNavItem(`${BASE}/finance/income/new`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance/income');
    expect(activeNavItem(`${BASE}/finance/collectors/abc`, BASE, 'SUPER_ADMIN')?.path).toBe('/finance/collectors');
    expect(activeNavItem(`${BASE}/citizens/review`, BASE, 'SUPER_ADMIN')?.path).toBe('/citizens/review');
  });

  it('does not match a path that only shares a prefix of letters', () => {
    expect(activeNavItem(`${BASE}/financed`, BASE, 'SUPER_ADMIN')).toBeUndefined();
  });
});
