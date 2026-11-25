// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { PAYMENT_REVIEW_READ_ROLES } from '@mechanization/shared-schemas';
import { useRoleGate } from '@/components/admin/use-role-gate';
import NewCitizenPage from '../app/[tenant]/[locale]/[adminPath]/(protected)/citizens/new/page';
import { CITIZEN_RECORD_EDIT_ROLES } from '@/lib/staff-roles';
import { ToastProvider } from '@/components/ui/toast';
import en from '../messages/en.json';

/*
  NAV-02 and NAV-07 (cleanup sprint, 2026-11-25): «تسجيل مواطن جديد» and «فواتير تأثّرت
  بتصحيحات» have no sidebar row, so a path under `/citizens` or `/fees` opens to roles the
  page is not for (`canAccessPath`). `useRoleGate` is what turns them away, and this drives
  it for real: the real page for the first, the hook itself for the second (its page has
  twenty other dependencies the gate does not touch).
*/
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const nav = vi.hoisted(() => {
  const replace = vi.fn();
  return {
    replace,
    router: { push: vi.fn(), replace, prefetch() {} },
    /** A router that is a new object on every render, as a dependency that changes under the effect. */
    unstable: false,
    session: { token: 'tok' as string | null, user: null as { id: string; role: string } | null },
  };
});

// React 18.3 has no `use` (Next's own runtime supplies it for the pages): read the settled params directly.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  use: (settled: { value: unknown }) => settled.value,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => (nav.unstable ? { ...nav.router } : nav.router),
  usePathname: () => '/t/en/a/citizens/new',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/use-staff-session', () => ({ useStaffSession: () => nav.session }));
// The form is not under test: a marker stands in for it.
vi.mock('@/components/admin/citizen-editor', () => ({
  CitizenEditor: () => createElement('div', { 'data-testid': 'editor' }, 'the form'),
}));

let container: HTMLDivElement;
let root: Root;

function params<T>(value: T): Promise<T> {
  // A settled thenable, which React's `use` reads without suspending.
  return Object.assign(Promise.resolve(value), { status: 'fulfilled' as const, value });
}

async function mount(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'en',
        messages: en as never,
        children: createElement(ToastProvider, null, element),
      }),
    );
  });
}

function as(role: string | null): void {
  nav.session = { token: 'tok', user: role ? { id: 'u1', role } : null };
}

beforeEach(() => {
  nav.replace.mockClear();
  nav.unstable = false;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const page = () =>
  createElement(NewCitizenPage, { params: params({ tenant: 't', locale: 'en', adminPath: 'a' }) });
const editorShown = () => document.querySelector('[data-testid="editor"]') !== null;

describe('«تسجيل مواطن جديد» (NAV-02)', () => {
  it.each(['SUPER_ADMIN', 'FIELD_INSPECTOR', 'COLLECTOR', 'ADMINISTRATIVE_OFFICER'])(
    'opens the form for %s, which may register',
    async (role) => {
      expect(CITIZEN_RECORD_EDIT_ROLES).toContain(role);
      as(role);
      await mount(page());
      expect(editorShown()).toBe(true);
      expect(nav.replace).not.toHaveBeenCalled();
    },
  );

  it.each(['VIEWER', 'AUDITOR', 'ACCOUNTANT'])('turns %s away to the register, saying why, and draws no form', async (role) => {
    expect(CITIZEN_RECORD_EDIT_ROLES).not.toContain(role);
    as(role);
    await mount(page());
    expect(editorShown()).toBe(false);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(nav.replace).toHaveBeenCalledWith('/t/en/a/citizens');
    expect(document.body.textContent).toContain(en.access.title);
    expect(document.body.textContent).toContain(en.access.registerCitizen);
  });

  it('says it once, even when a dependency of its effect changes on every render', async () => {
    nav.unstable = true;
    as('VIEWER');
    await mount(page());
    await mount(page());
    await mount(page());
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it('draws nothing and sends no one while the session is still being read', async () => {
    as(null);
    await mount(page());
    expect(editorShown()).toBe(false);
    expect(nav.replace).not.toHaveBeenCalled();
  });
});

describe('useRoleGate on «فواتير تأثّرت بتصحيحات» (NAV-07)', () => {
  let seen: { allowed: boolean | null; token: string | null; role: string | null } | undefined;
  function Probe(): null {
    seen = useRoleGate('t', '/t/en/a', PAYMENT_REVIEW_READ_ROLES, { to: '/t/en/a/fees', reason: 'feeCorrections' });
    return null;
  }

  beforeEach(() => {
    seen = undefined;
  });

  it.each(['SUPER_ADMIN', 'AUDITOR', 'ACCOUNTANT', 'VIEWER'])('gives %s its token, to read with', async (role) => {
    as(role);
    await mount(createElement(Probe));
    expect(seen).toEqual({ allowed: true, token: 'tok', role });
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it.each(['COLLECTOR', 'FIELD_INSPECTOR', 'ADMINISTRATIVE_OFFICER'])(
    'gives %s no token, and sends it to the fees page saying why',
    async (role) => {
      expect(PAYMENT_REVIEW_READ_ROLES as readonly string[]).not.toContain(role);
      as(role);
      await mount(createElement(Probe));
      expect(seen).toEqual({ allowed: false, token: null, role });
      expect(nav.replace).toHaveBeenCalledWith('/t/en/a/fees');
      expect(document.body.textContent).toContain(en.access.feeCorrections);
    },
  );

  it('is undecided, with no token, until the session is read', async () => {
    as(null);
    await mount(createElement(Probe));
    expect(seen).toEqual({ allowed: null, token: null, role: null });
    expect(nav.replace).not.toHaveBeenCalled();
  });
});
